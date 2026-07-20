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
