import { describe, expect, it } from 'vitest';
import {
  createNotionClient,
  NotionError,
  NOTION_TEXT_LIMIT,
  type NotionBlock,
} from '../lib/notion';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function jsonResp(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** 记录请求并按序/按逻辑返回响应的 mock fetch */
function mockFetch(handler: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const noSleep = () => Promise.resolve();

function makeClient(
  fetchImpl: typeof fetch,
  extra?: { sleep?: (ms: number) => Promise<void>; minIntervalMs?: number },
) {
  return createNotionClient({
    token: 'ntn_test',
    fetchImpl,
    sleep: extra?.sleep ?? noSleep,
    minIntervalMs: extra?.minIntervalMs ?? 0,
  });
}

describe('validateToken / 错误映射', () => {
  it('返回集成名称与工作区，并携带认证头', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResp({
        id: 'u1',
        type: 'bot',
        name: 'BiliNote',
        bot: { workspace_name: '我的知识库' },
      }),
    );
    const info = await makeClient(fetchImpl).validateToken();
    expect(info.botName).toBe('BiliNote');
    expect(info.workspaceName).toBe('我的知识库');
    expect(calls[0].url).toBe('https://api.notion.com/v1/users/me');
    expect(calls[0].headers.Authorization).toBe('Bearer ntn_test');
    expect(calls[0].headers['Notion-Version']).toBe('2022-06-28');
  });

  it.each([
    [401, 'auth', '令牌无效'],
    [403, 'forbidden', '共享给集成'],
    [404, 'not_found', '页面不存在'],
  ] as const)('HTTP %i → %s（中文提示）', async (status, kind, hint) => {
    const { fetchImpl } = mockFetch(() => jsonResp({ message: 'err' }, status));
    await expect(makeClient(fetchImpl).validateToken()).rejects.toSatisfy(
      (e) =>
        e instanceof NotionError &&
        e.kind === kind &&
        e.status === status &&
        e.userMessage.includes(hint),
    );
  });

  it('网络异常 → network', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(makeClient(fetchImpl).validateToken()).rejects.toSatisfy(
      (e) => e instanceof NotionError && e.kind === 'network',
    );
  });
});

describe('searchPages', () => {
  it('POST /search 带 page 过滤与 page_size=10，并提取标题', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResp({
        results: [
          {
            id: 'p1',
            url: 'https://notion.so/p1',
            last_edited_time: '2026-07-01T00:00:00.000Z',
            properties: {
              Name: { type: 'title', title: [{ plain_text: '学习笔记' }] },
            },
          },
          {
            id: 'p2',
            url: 'https://notion.so/p2',
            last_edited_time: '2026-07-02T00:00:00.000Z',
            properties: { title: { type: 'title', title: [] } },
          },
        ],
      }),
    );
    const pages = await makeClient(fetchImpl).searchPages('学习');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://api.notion.com/v1/search');
    expect(calls[0].body).toMatchObject({
      query: '学习',
      filter: { property: 'object', value: 'page' },
      page_size: 10,
    });
    expect(pages).toEqual([
      {
        id: 'p1',
        title: '学习笔记',
        url: 'https://notion.so/p1',
        lastEditedTime: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'p2',
        title: '',
        url: 'https://notion.so/p2',
        lastEditedTime: '2026-07-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('appendBlocks 分批（>100 块）', () => {
  it('250 块 → 3 次请求（100/100/50）', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResp({ results: [] }));
    const blocks: NotionBlock[] = Array.from({ length: 250 }, (_, i) => ({
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: `块${i}` } }],
      },
    }));
    await makeClient(fetchImpl).appendBlocks('page-1', blocks);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // 回归保护：Notion 追加子块是 PATCH /blocks/{id}/children；
      // 该路径的 POST 不存在，会返回 400 invalid_request_url
      expect(call.method).toBe('PATCH');
      expect(call.url).toBe('https://api.notion.com/v1/blocks/page-1/children');
    }
    expect(
      calls.map((c) => (c.body?.children as unknown[]).length),
    ).toEqual([100, 100, 50]);
  });
});

describe('限流与 429 重试', () => {
  it('429 + Retry-After → 按头等待后重试成功', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    let n = 0;
    const { fetchImpl, calls } = mockFetch(() =>
      ++n === 1
        ? jsonResp({ message: 'rate limited' }, 429, { 'Retry-After': '1' })
        : jsonResp({ id: 'u1', name: 'BiliNote' }),
    );
    const info = await makeClient(fetchImpl, { sleep }).validateToken();
    expect(info.botName).toBe('BiliNote');
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it('无 Retry-After → 指数退避；超过 3 次重试 → rate_limit', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResp({ message: 'rate limited' }, 429),
    );
    await expect(
      makeClient(fetchImpl, { sleep }).validateToken(),
    ).rejects.toSatisfy(
      (e) => e instanceof NotionError && e.kind === 'rate_limit',
    );
    expect(calls).toHaveLength(4); // 首次 + 3 次重试
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it('请求串行且保持最小间隔', async () => {
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    const { fetchImpl } = mockFetch(() => jsonResp({ id: 'u1' }));
    const client = makeClient(fetchImpl, { sleep, minIntervalMs: 60_000 });
    await Promise.all([client.validateToken(), client.validateToken()]);
    // 第二个请求必然被拉开间隔（第一次：lastAt=0 不等待）
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(60_000);
  });
});

describe('listChildren 翻页', () => {
  it('has_more 时携带 start_cursor 继续拉取', async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      call.url.includes('start_cursor=c2')
        ? jsonResp({ results: [{ id: 'b3' }], has_more: false, next_cursor: null })
        : jsonResp({
            results: [{ id: 'b1' }, { id: 'b2' }],
            has_more: true,
            next_cursor: 'c2',
          }),
    );
    const children = await makeClient(fetchImpl).listChildren('page-1');
    expect(children.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    expect(calls).toHaveLength(2);
  });
});

describe('getPage 标题提取', () => {
  it('返回页面标题与 last_edited_time', async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      jsonResp({
        id: 'p1',
        last_edited_time: '2026-07-01T00:00:00.000Z',
        properties: {
          Name: { type: 'title', title: [{ plain_text: 'P2 · 进程管理' }] },
        },
      }),
    );
    const page = await makeClient(fetchImpl).getPage('p1');
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toBe('https://api.notion.com/v1/pages/p1');
    expect(page.title).toBe('P2 · 进程管理');
    expect(page.lastEditedTime).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('updatePageTitle', () => {
  it('PATCH /pages/{id}，body 为 title 属性', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResp({ id: 'p1' }));
    await makeClient(fetchImpl).updatePageTitle('page-1', 'P2 · 进程管理');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toBe('https://api.notion.com/v1/pages/page-1');
    expect(calls[0].body).toEqual({
      properties: {
        title: [{ type: 'text', text: { content: 'P2 · 进程管理' } }],
      },
    });
  });

  it('标题超过 NOTION_TEXT_LIMIT 时裁剪', async () => {
    const { fetchImpl, calls } = mockFetch(() => jsonResp({ id: 'p1' }));
    await makeClient(fetchImpl).updatePageTitle('page-1', 'x'.repeat(5000));
    const titleProp = calls[0].body?.properties as {
      title: { text: { content: string } }[];
    };
    expect(titleProp.title[0].text.content).toHaveLength(NOTION_TEXT_LIMIT);
  });
});
