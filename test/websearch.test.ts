import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WEB_SEARCH_TOOL,
  WEB_SEARCH_MAX_ROUNDS,
  decideSearchPlan,
  looksLikeToolUnsupported,
  runBuiltinToolLoop,
  webSearchToolsFor,
  type SearchPlan,
  type ToolMode,
} from '../lib/chat';
import {
  chatStream,
  LLMError,
  type ChatMessage,
  type ChatStreamOutcome,
} from '../lib/llm';

const KIMI_TOOLS = [{ type: 'builtin_function', function: { name: '$web_search' } }];

const OK_OUTCOME: ChatStreamOutcome = {
  finishReason: 'stop',
  toolCalls: [],
  truncatedByLength: false,
  filtered: false,
};

describe('webSearchToolsFor（已知 Provider 联网能力表）', () => {
  it('moonshot.cn 域名 → Kimi 内置联网工具 $web_search', () => {
    expect(webSearchToolsFor('https://api.moonshot.cn/v1')).toEqual(KIMI_TOOLS);
    expect(webSearchToolsFor('https://api.moonshot.cn')).toEqual(KIMI_TOOLS);
  });

  it('其他 Provider 与非法 URL → null（能力未知，不盲目透传 tools）', () => {
    expect(webSearchToolsFor('https://api.openai.com/v1')).toBeNull();
    expect(webSearchToolsFor('https://api.deepseek.com/v1')).toBeNull();
    expect(webSearchToolsFor('https://api.moonshot.ai/v1')).toBeNull();
    expect(webSearchToolsFor('not-a-url')).toBeNull();
  });
});

describe('looksLikeToolUnsupported（工具被拒错误特征）', () => {
  it('kimi 风格 400 unknown tool: $web_search → true', () => {
    expect(
      looksLikeToolUnsupported(
        400,
        '{"error":{"message":"unknown tool: $web_search","type":"invalid_request_error"}}',
      ),
    ).toBe(true);
  });

  it('通用 400 tools not supported → true', () => {
    expect(looksLikeToolUnsupported(400, 'tools not supported by this model')).toBe(
      true,
    );
  });

  it('422 unknown builtin function → true', () => {
    expect(looksLikeToolUnsupported(422, 'unknown builtin function')).toBe(true);
  });

  it('401 鉴权失败 → false（不误判为不支持）', () => {
    expect(looksLikeToolUnsupported(401, 'unsupported operation')).toBe(false);
  });

  it('400 但与工具无关（context length）→ false', () => {
    expect(
      looksLikeToolUnsupported(400, 'maximum context length exceeded for this model'),
    ).toBe(false);
  });

  it('无 status（网络层错误）→ false', () => {
    expect(looksLikeToolUnsupported(undefined, 'unsupported tool')).toBe(false);
  });
});

describe('decideSearchPlan（模式 × Provider 能力决策矩阵）', () => {
  it.each([
    { mode: 'course' as ToolMode, hasTools: true, expected: 'none' as SearchPlan },
    { mode: 'course' as ToolMode, hasTools: false, expected: 'none' as SearchPlan },
    { mode: 'auto' as ToolMode, hasTools: true, expected: 'attempt' as SearchPlan },
    { mode: 'auto' as ToolMode, hasTools: false, expected: 'unsupported' as SearchPlan },
    { mode: 'force' as ToolMode, hasTools: true, expected: 'attempt' as SearchPlan },
    { mode: 'force' as ToolMode, hasTools: false, expected: 'unsupported' as SearchPlan },
  ])('$mode × hasTools=$hasTools → $expected', ({ mode, hasTools, expected }) => {
    expect(decideSearchPlan(mode, hasTools)).toBe(expected);
  });
});

describe('chatStream tools 透传与 tool_calls 检测', () => {
  /** 返回 SSE 流并捕获请求体的 mock fetch */
  function sseFetchCapture(
    sse: string,
    onBody?: (parsed: Record<string, unknown>) => void,
  ): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      if (onBody && init?.body) {
        onBody(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
  }

  it('tools 原样透传进请求体', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const fetchImpl = sseFetchCapture(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
      (b) => {
        captured.body = b;
      },
    );
    let text = '';
    for await (const delta of chatStream({
      baseURL: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-test',
      model: 'kimi-k2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: KIMI_TOOLS,
      fetchImpl,
    })) {
      text += delta;
    }
    expect(text).toBe('ok');
    expect(captured.body?.tools).toEqual(KIMI_TOOLS);
  });

  it('不传 tools 时请求体不含 tools 字段', async () => {
    const captured: { body: Record<string, unknown> | null } = { body: null };
    const fetchImpl = sseFetchCapture('data: [DONE]\n\n', (b) => {
      captured.body = b;
    });
    for await (const _ of chatStream({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [],
      fetchImpl,
    })) {
      /* noop */
    }
    expect(captured.body !== null && 'tools' in captured.body).toBe(false);
  });

  it('流中出现 tool_calls → 不再抛错，收集进结局（供内置工具协议循环使用）', async () => {
    const fetchImpl = sseFetchCapture(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"$web_search","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
    );
    const gen = chatStream({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'k',
      model: 'm',
      messages: [],
      tools: KIMI_TOOLS,
      fetchImpl,
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    expect(step.value.toolCalls).toEqual([{ id: 'call_1', name: '$web_search', arguments: '{}' }]);
    expect(step.value.finishReason).toBe('tool_calls');
  });
});

describe('runBuiltinToolLoop（Kimi 内置联网协议循环）', () => {
  const baseMessages: ChatMessage[] = [{ role: 'user', content: '问题' }];

  /** 按脚本逐轮返回结局的 roundFn，记录每轮收到的 messages */
  function scriptedRoundFn(outcomes: ChatStreamOutcome[]) {
    const seen: ChatMessage[][] = [];
    const toolsSeen: (unknown[] | undefined)[] = [];
    const roundFn = async (messages: ChatMessage[], tools: unknown[] | undefined) => {
      seen.push([...messages]);
      toolsSeen.push(tools);
      const outcome = outcomes.shift();
      if (!outcome) throw new Error('脚本外的额外轮次');
      return outcome;
    };
    return { seen, toolsSeen, roundFn };
  }

  const toolCallsOutcome = (name: string, id = 'call_1'): ChatStreamOutcome => ({
    finishReason: 'tool_calls',
    toolCalls: [{ id, name, arguments: '{"q":"x"}' }],
    truncatedByLength: false,
    filtered: false,
  });

  it('首轮无 tool_calls → 一轮结束，不回传任何消息', async () => {
    const { seen, roundFn } = scriptedRoundFn([OK_OUTCOME]);
    const outcome = await runBuiltinToolLoop(baseMessages, KIMI_TOOLS, roundFn);
    expect(outcome).toBe(OK_OUTCOME);
    expect(seen).toEqual([baseMessages]);
  });

  it('内置 $web_search：回传 assistant tool_calls + role=tool ack 后再请求，两轮消息结构正确', async () => {
    const { seen, toolsSeen, roundFn } = scriptedRoundFn([
      toolCallsOutcome(BUILTIN_WEB_SEARCH_TOOL),
      OK_OUTCOME,
    ]);
    const outcome = await runBuiltinToolLoop(baseMessages, KIMI_TOOLS, roundFn);
    expect(outcome).toBe(OK_OUTCOME);
    expect(seen).toHaveLength(2);
    // 第二轮 = 原始消息 + assistant tool_calls 回声 + 每个 call 一条 tool ack
    const round2 = seen[1];
    expect(round2[0]).toEqual(baseMessages[0]);
    expect(round2[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: BUILTIN_WEB_SEARCH_TOOL, arguments: '{"q":"x"}' },
        },
      ],
    });
    expect(round2[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '' });
    expect(round2).toHaveLength(3);
    // 每轮都带 tools
    expect(toolsSeen).toEqual([KIMI_TOOLS, KIMI_TOOLS]);
    // 调用方传入的 messages 不被原地修改
    expect(baseMessages).toHaveLength(1);
  });

  it('多个 tool_call：每个 call 各追加一条 tool ack', async () => {
    const multi: ChatStreamOutcome = {
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 'call_1', name: BUILTIN_WEB_SEARCH_TOOL, arguments: '{}' },
        { id: 'call_2', name: BUILTIN_WEB_SEARCH_TOOL, arguments: '{}' },
      ],
      truncatedByLength: false,
      filtered: false,
    };
    const { seen, roundFn } = scriptedRoundFn([multi, OK_OUTCOME]);
    await runBuiltinToolLoop(baseMessages, KIMI_TOOLS, roundFn);
    const round2 = seen[1];
    expect(round2.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '' },
      { role: 'tool', tool_call_id: 'call_2', content: '' },
    ]);
  });

  it(`达到 ${WEB_SEARCH_MAX_ROUNDS} 轮仍要调用 → 抛 tool_calls 错误（交给上层降级）`, async () => {
    const outcomes = Array.from({ length: WEB_SEARCH_MAX_ROUNDS }, () =>
      toolCallsOutcome(BUILTIN_WEB_SEARCH_TOOL),
    );
    const { seen, roundFn } = scriptedRoundFn(outcomes);
    await expect(
      runBuiltinToolLoop(baseMessages, KIMI_TOOLS, roundFn),
    ).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === 'tool_calls');
    // 恰好 MAX 轮，没有多发请求
    expect(seen).toHaveLength(WEB_SEARCH_MAX_ROUNDS);
  });

  it('非内置工具名 → 立即抛 tool_calls 错误（不追加任何消息、不多发请求）', async () => {
    const { seen, roundFn } = scriptedRoundFn([toolCallsOutcome('some_client_tool')]);
    await expect(
      runBuiltinToolLoop(baseMessages, KIMI_TOOLS, roundFn),
    ).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === 'tool_calls');
    expect(seen).toHaveLength(1);
  });
});
