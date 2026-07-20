import { describe, expect, it } from 'vitest';
import {
  decideSearchPlan,
  looksLikeToolUnsupported,
  webSearchToolsFor,
  type SearchPlan,
  type ToolMode,
} from '../lib/chat';
import { chatStream, LLMError } from '../lib/llm';

const KIMI_TOOLS = [{ type: 'builtin_function', function: { name: '$web_search' } }];

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

  it('流中出现 tool_calls → 抛出 tool_calls 类型错误（上层按不支持降级）', async () => {
    const fetchImpl = sseFetchCapture(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
    );
    await expect(async () => {
      for await (const _ of chatStream({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [],
        tools: KIMI_TOOLS,
        fetchImpl,
      })) {
        /* noop */
      }
    }).rejects.toSatisfy(
      (e) => e instanceof LLMError && e.kind === 'tool_calls',
    );
  });
});
