import { describe, expect, it } from 'vitest';
import { chatStream, fetchModels, LLMError } from '../lib/llm';

/** 构造一个返回 SSE 流的 mock fetch */
function sseFetch(events: string[], status = 200): typeof fetch {
  const body = events.join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return (async () =>
    new Response(stream, {
      status,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch;
}

function chunk(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

describe('chatStream SSE 解析', () => {
  it('多 chunk delta 拼接 + [DONE] 结束', async () => {
    const fetchImpl = sseFetch([
      chunk('你好'),
      chunk('，'),
      chunk('世界'),
      'data: [DONE]\n\n',
      chunk('不应出现'),
    ]);
    let text = '';
    for await (const delta of chatStream({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
    })) {
      text += delta;
    }
    expect(text).toBe('你好，世界');
  });

  it('跨 TCP 分包（流分多次 enqueue）也能正确解析', async () => {
    const pieces = [
      'data: {"choices":[{"delta":{"content":"AB',
      'C"}}]}\n\ndata: {"choices":[{"delta":{"content":"D"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const p of pieces) controller.enqueue(enc.encode(p));
        controller.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200 })) as typeof fetch;
    let text = '';
    for await (const delta of chatStream({
      baseURL: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'm',
      messages: [],
      fetchImpl,
    })) {
      text += delta;
    }
    expect(text).toBe('ABCD');
  });

  it('401 抛出 auth 类型错误', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid key"}', { status: 401 })) as typeof fetch;
    await expect(async () => {
      for await (const _ of chatStream({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'bad',
        model: 'm',
        messages: [],
        fetchImpl,
      })) {
        /* noop */
      }
    }).rejects.toSatisfy(
      (e) => e instanceof LLMError && e.kind === 'auth' && e.status === 401,
    );
  });

  it('429 抛出 rate_limit 类型错误', async () => {
    const fetchImpl = (async () =>
      new Response('too many', { status: 429 })) as typeof fetch;
    await expect(async () => {
      for await (const _ of chatStream({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [],
        fetchImpl,
      })) {
        /* noop */
      }
    }).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === 'rate_limit');
  });

  it('网络异常抛出 network 类型错误', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(async () => {
      for await (const _ of chatStream({
        baseURL: 'https://api.example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [],
        fetchImpl,
      })) {
        /* noop */
      }
    }).rejects.toSatisfy((e) => e instanceof LLMError && e.kind === 'network');
  });
});

describe('chatStream SSE 结束语义（P2 加固）', () => {
  /** 手动迭代 generator，收集文本与结构化结局 */
  async function drain(params: Parameters<typeof chatStream>[0]) {
    const gen = chatStream(params);
    let text = '';
    let step = await gen.next();
    while (!step.done) {
      text += step.value;
      step = await gen.next();
    }
    return { text, outcome: step.value };
  }

  const base = {
    baseURL: 'https://api.example.com/v1',
    apiKey: 'k',
    model: 'm',
    messages: [],
  };

  it('中途断流（无 [DONE] 且无 finish_reason）→ 抛 truncated，不当成功', async () => {
    const fetchImpl = sseFetch([chunk('半截回答'), chunk('还在说')]); // 流直接结束
    await expect(drain({ ...base, fetchImpl })).rejects.toSatisfy(
      (e) => e instanceof LLMError && e.kind === 'truncated',
    );
  });

  it('finish_reason=stop 但无 [DONE] → 正常完成', async () => {
    const fetchImpl = sseFetch([
      chunk('完整回答'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ]);
    const { text, outcome } = await drain({ ...base, fetchImpl });
    expect(text).toBe('完整回答');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.toolCalls).toEqual([]);
    expect(outcome.truncatedByLength).toBe(false);
  });

  it('finish_reason=length 无 [DONE] → 完成且标注 truncatedByLength', async () => {
    const fetchImpl = sseFetch([
      chunk('被 max_tokens 截断的'),
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    ]);
    const { text, outcome } = await drain({ ...base, fetchImpl });
    expect(text).toBe('被 max_tokens 截断的');
    expect(outcome.truncatedByLength).toBe(true);
  });

  it('finish_reason=content_filter 且全程无正文 → 抛 filtered', async () => {
    const fetchImpl = sseFetch([
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    await expect(drain({ ...base, fetchImpl })).rejects.toSatisfy(
      (e) => e instanceof LLMError && e.kind === 'filtered',
    );
  });

  it('finish_reason=content_filter 但有正文 → 完成且标注 filtered', async () => {
    const fetchImpl = sseFetch([
      chunk('部分回答'),
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { text, outcome } = await drain({ ...base, fetchImpl });
    expect(text).toBe('部分回答');
    expect(outcome.filtered).toBe(true);
  });

  it('tool_calls 跨 chunk 分片合并（首片 id/name，后续补 arguments）', async () => {
    const fetchImpl = sseFetch([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"$web_search","arguments":"{\\"q\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const { text, outcome } = await drain({ ...base, fetchImpl });
    expect(text).toBe('');
    expect(outcome.toolCalls).toEqual([
      { id: 'call_1', name: '$web_search', arguments: '{"q":"x"}' },
    ]);
    expect(outcome.finishReason).toBe('tool_calls');
  });

  it('尾部残留（无换行收尾的最后一个 chunk）也参与结束判定', async () => {
    const fetchImpl = sseFetch([
      chunk('尾巴'),
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', // 无 \n\n 收尾
    ]);
    const { text, outcome } = await drain({ ...base, fetchImpl });
    expect(text).toBe('尾巴');
    expect(outcome.finishReason).toBe('stop');
  });
});

describe('fetchModels', () => {
  it('解析模型 id 列表', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'moonshot-v1-8k' }, { id: 'kimi-k2' }, {}] }),
        { status: 200 },
      )) as typeof fetch;
    const models = await fetchModels('https://api.example.com/v1/', 'sk-x', {
      fetchImpl,
    });
    expect(models).toEqual(['moonshot-v1-8k', 'kimi-k2']);
  });
});
