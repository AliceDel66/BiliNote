// MCP 连接器：写入工具优先级选择 / 参数键名推断 / externalId 提取 / 401 鉴权兜底
import { describe, expect, it, vi } from 'vitest';
import {
  createMcpConnector,
  extractExternalId,
  pickBestWriteTool,
} from '../lib/connectors/mcpConnector';
import type { ConnectorProfile } from '../lib/connectors/types';

function profile(kind: 'remote-mcp' | 'custom-mcp'): ConnectorProfile {
  return {
    id: 'p1',
    kind,
    name: '测试',
    status: kind === 'remote-mcp' ? 'beta' : 'custom',
    config: { endpoint: 'https://mcp.example.com/rpc', token: 'tok' },
    createdAt: 0,
  };
}

/** 按 RPC method 返回固定结果的 fetch mock，记录 tools/call 入参与每次请求的 url/headers */
function mockMcpFetch(handlers: {
  tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];
  callResult?: unknown;
}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    });
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: { name?: string; arguments?: Record<string, unknown> };
    };
    let result: unknown;
    if (body.method === 'initialize') result = { serverInfo: { name: 'srv' } };
    else if (body.method === 'tools/list') result = { tools: handlers.tools ?? [] };
    else {
      calls.push({
        name: body.params.name ?? '',
        arguments: body.params.arguments ?? {},
      });
      result = handlers.callResult ?? {};
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, requests, fetchImpl };
}

describe('pickBestWriteTool 写入工具优先级', () => {
  const tools = [
    { name: 'update_doc' },
    { name: 'append_block' },
    { name: 'create_page' },
    { name: 'search_docs' },
  ];

  it('无 externalId：create* > append* > update*', () => {
    expect(pickBestWriteTool(tools)?.name).toBe('create_page');
    expect(pickBestWriteTool(tools.filter((t) => t.name !== 'create_page'))?.name).toBe(
      'append_block',
    );
    expect(
      pickBestWriteTool(tools.filter((t) => !t.name.includes('create') && !t.name.includes('append')))
        ?.name,
    ).toBe('update_doc');
  });

  it('有 externalId：update* > append* > create*（避免重复同步反复新建）', () => {
    expect(pickBestWriteTool(tools, 'doc-1')?.name).toBe('update_doc');
    expect(
      pickBestWriteTool(
        tools.filter((t) => t.name !== 'update_doc'),
        'doc-1',
      )?.name,
    ).toBe('append_block');
  });

  it('没有任何写工具 → undefined', () => {
    expect(pickBestWriteTool([{ name: 'search_docs' }])).toBeUndefined();
  });
});

describe('extractExternalId', () => {
  it('id / pageId / docId 优先；支持 structuredContent 与 text JSON', () => {
    expect(extractExternalId({ id: 'a' })).toBe('a');
    expect(extractExternalId({ pageId: 'b' })).toBe('b');
    expect(extractExternalId({ structuredContent: { docId: 'c' } })).toBe('c');
    expect(extractExternalId({ content: [{ type: 'text', text: '{"documentId":"d"}' }] })).toBe('d');
    expect(extractExternalId('plain-string')).toBe('plain-string');
    expect(extractExternalId({ foo: 1 })).toBeUndefined();
    expect(extractExternalId(null)).toBeUndefined();
  });
});

describe('mcpConnector.upsertCourseNote', () => {
  const input = {
    courseTitle: '操作系统课程',
    partLabel: 'P2 进程管理',
    contentMd: '# 笔记内容',
  };

  it('选 create 工具；title 带分 P 标签；默认 content 键；提取 pageId', async () => {
    const { calls, fetchImpl } = mockMcpFetch({
      tools: [{ name: 'create_doc' }],
      callResult: { structuredContent: { pageId: 'page-9' } },
    });
    const conn = createMcpConnector(profile('remote-mcp'), { fetchImpl });
    const result = await conn.upsertCourseNote(input);
    expect(result.externalId).toBe('page-9');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('create_doc');
    expect(calls[0].arguments.title).toBe('操作系统课程 · P2 进程管理');
    expect(calls[0].arguments.content).toBe('# 笔记内容');
  });

  it('按 inputSchema 选键名变体（markdown / docId）', async () => {
    const { calls, fetchImpl } = mockMcpFetch({
      tools: [
        {
          name: 'create_markdown_doc',
          inputSchema: { properties: { title: {}, markdown: {}, docId: {} } },
        },
      ],
      callResult: { docId: 'd-1' },
    });
    const conn = createMcpConnector(profile('custom-mcp'), { fetchImpl });
    await conn.upsertCourseNote({ ...input, externalId: 'ext-1' });
    // create* 工具存在时即使带 externalId 也无 update/append 可选 → 仍用 create*，但带 id 键
    expect(calls[0].arguments.markdown).toBe('# 笔记内容');
    expect(calls[0].arguments.content).toBeUndefined();
    expect(calls[0].arguments.docId).toBe('ext-1');
  });

  it('结果无 id 字段时回退为传入的 externalId', async () => {
    const { fetchImpl } = mockMcpFetch({
      tools: [{ name: 'update_doc' }],
      callResult: { ok: true },
    });
    const conn = createMcpConnector(profile('custom-mcp'), { fetchImpl });
    const result = await conn.upsertCourseNote({ ...input, externalId: 'keep-me' });
    expect(result.externalId).toBe('keep-me');
  });

  it('无写工具 → protocol 错误', async () => {
    const { fetchImpl } = mockMcpFetch({ tools: [{ name: 'search_docs' }] });
    const conn = createMcpConnector(profile('remote-mcp'), { fetchImpl });
    await expect(conn.upsertCourseNote(input)).rejects.toThrow(/写入工具/);
  });
});

describe('mcpConnector.testConnection', () => {
  it('成功：返回服务器名与映射能力清单', async () => {
    const { fetchImpl } = mockMcpFetch({
      tools: [{ name: 'search_docs' }, { name: 'create_page' }, { name: 'append_text' }],
    });
    const conn = createMcpConnector(profile('remote-mcp'), { fetchImpl });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('srv');
    expect(result.detail).toContain('search');
    expect(result.detail).toContain('create');
    expect(result.detail).toContain('append');
    expect(result.detail).not.toContain('tok'); // 不泄露 token
  });

  it('失败（鉴权）：返回中文可操作提示', async () => {
    const fetchImpl = (async () => new Response('x', { status: 401 })) as typeof fetch;
    const conn = createMcpConnector(profile('custom-mcp'), { fetchImpl });
    const result = await conn.testConnection();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Token');
  });
});

describe('mcpConnector 构造期 SSRF 复查', () => {
  it('内网 / 明文端点在构造时即被拒绝', () => {
    const bad: ConnectorProfile = {
      ...profile('custom-mcp'),
      config: { endpoint: 'http://192.168.1.10/mcp' },
    };
    expect(() => createMcpConnector(bad)).toThrow(/https/);
    const lan: ConnectorProfile = {
      ...profile('custom-mcp'),
      config: { endpoint: 'https://192.168.1.10/mcp' },
    };
    expect(() => createMcpConnector(lan)).toThrow(/内网|拦截/);
  });

  it('custom-mcp / remote-mcp 仍拦截 127.0.0.1（本机仅放行 local-mcp）', () => {
    for (const kind of ['custom-mcp', 'remote-mcp'] as const) {
      const p: ConnectorProfile = {
        ...profile(kind),
        config: { endpoint: 'http://127.0.0.1:27184/mcp' },
      };
      expect(() => createMcpConnector(p), kind).toThrow(/https|内网|拦截/);
    }
  });
});

describe('authScheme → 鉴权头映射', () => {
  function profileWith(config: Record<string, unknown>): ConnectorProfile {
    return { ...profile('remote-mcp'), config };
  }

  it("raw：Authorization 直接放原始 token（腾讯文档官方要求，无 Bearer 前缀）", async () => {
    const { requests, fetchImpl } = mockMcpFetch({ tools: [] });
    const conn = createMcpConnector(
      profileWith({
        endpoint: 'https://docs.qq.com/openapi/mcp',
        token: 'tencent-raw-token',
        authScheme: 'raw',
      }),
      { fetchImpl },
    );
    await conn.testConnection();
    expect(requests[0].headers.Authorization).toBe('tencent-raw-token');
    expect(requests[0].headers.Authorization).not.toContain('Bearer');
  });

  it('bearer：Authorization: Bearer <token>；缺省 authScheme 的旧 profile 行为不变', async () => {
    const explicit = mockMcpFetch({ tools: [] });
    await createMcpConnector(
      profileWith({
        endpoint: 'https://mcp.example.com/rpc',
        token: 'tok-1',
        authScheme: 'bearer',
      }),
      { fetchImpl: explicit.fetchImpl },
    ).testConnection();
    expect(explicit.requests[0].headers.Authorization).toBe('Bearer tok-1');

    // 旧版 custom-mcp profile（无 authScheme 字段）→ 仍然 Bearer
    const legacy = mockMcpFetch({ tools: [] });
    await createMcpConnector(
      profileWith({ endpoint: 'https://mcp.example.com/rpc', token: 'tok-2' }),
      { fetchImpl: legacy.fetchImpl },
    ).testConnection();
    expect(legacy.requests[0].headers.Authorization).toBe('Bearer tok-2');
  });

  it('none：即使 config 里残留 token 也不带任何鉴权头（飞书 URL 内嵌凭据）', async () => {
    const { requests, fetchImpl } = mockMcpFetch({ tools: [] });
    const conn = createMcpConnector(
      profileWith({
        endpoint: 'https://open.feishu.cn/mcp/stream/mcp_abc123',
        token: 'stray-token',
        authScheme: 'none',
      }),
      { fetchImpl },
    );
    await conn.testConnection();
    expect(requests[0].headers.Authorization).toBeUndefined();
  });

  it('无 token 时任何 scheme 都不带头', async () => {
    const { requests, fetchImpl } = mockMcpFetch({ tools: [] });
    await createMcpConnector(
      profileWith({ endpoint: 'https://mcp.example.com/rpc', authScheme: 'raw' }),
      { fetchImpl },
    ).testConnection();
    expect(requests[0].headers.Authorization).toBeUndefined();
  });
});

describe('401 鉴权兜底（withAuthFallback：raw ↔ bearer 互换重试）', () => {
  function profileWith(config: Record<string, unknown>): ConnectorProfile {
    return { ...profile('remote-mcp'), config };
  }

  /** 鉴权格式敏感的 mock：Authorization 等于 failHeader 时 401，其余正常 MCP 应答 */
  function authSensitiveFetch(failHeader: string) {
    const requests: { headers: Record<string, string>; method: string }[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      requests.push({ headers, method: body.method });
      if (headers.Authorization === failHeader) return new Response('x', { status: 401 });
      let result: unknown;
      if (body.method === 'initialize') result = { serverInfo: { name: 'srv' } };
      else if (body.method === 'tools/list') result = { tools: [{ name: 'create_doc' }] };
      else result = { structuredContent: { docId: 'doc-9' } };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return { requests, fetchImpl };
  }

  it('raw 遇 401 → 自动 Bearer 重试成功：持久化 bearer 且 detail 注明切换', async () => {
    const p = profileWith({
      endpoint: 'https://docs.qq.com/openapi/mcp',
      token: 'tk',
      authScheme: 'raw',
    });
    const { requests, fetchImpl } = authSensitiveFetch('tk'); // 裸值被拒
    const persist = vi.fn(async () => {});
    const conn = createMcpConnector(p, { fetchImpl, persistAuthScheme: persist });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('已自动切换为 Bearer 鉴权');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(p, 'bearer');
    // 第 1 次裸值 initialize（401）→ 重试 bearer 的 initialize + tools/list
    expect(requests.map((r) => r.headers.Authorization)).toEqual([
      'tk',
      'Bearer tk',
      'Bearer tk',
    ]);
  });

  it('bearer（legacy 无 scheme）遇 401 → 降级裸值重试成功：持久化 raw 并注明', async () => {
    const p = profileWith({ endpoint: 'https://docs.qq.com/openapi/mcp', token: 'tk' });
    const { requests, fetchImpl } = authSensitiveFetch('Bearer tk'); // Bearer 被拒
    const persist = vi.fn(async () => {});
    const conn = createMcpConnector(p, { fetchImpl, persistAuthScheme: persist });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('已自动切换为裸值鉴权');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(p, 'raw');
    expect(requests.map((r) => r.headers.Authorization)).toEqual(['Bearer tk', 'tk', 'tk']);
  });

  it('upsertCourseNote 同样走兜底：raw 401 → bearer 重试写入成功并持久化', async () => {
    const p = profileWith({
      endpoint: 'https://docs.qq.com/openapi/mcp',
      token: 'tk',
      authScheme: 'raw',
    });
    const { fetchImpl } = authSensitiveFetch('tk');
    const persist = vi.fn(async () => {});
    const conn = createMcpConnector(p, { fetchImpl, persistAuthScheme: persist });
    const result = await conn.upsertCourseNote({ courseTitle: '课程', contentMd: '# 笔记' });
    expect(result.externalId).toBe('doc-9');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(p, 'bearer');
  });

  it('两次都 401 → 维持鉴权失败错误，不持久化任何变更', async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      return new Response('x', { status: 401 });
    }) as typeof fetch;
    const persist = vi.fn(async () => {});
    const conn = createMcpConnector(
      profileWith({
        endpoint: 'https://docs.qq.com/openapi/mcp',
        token: 'tk',
        authScheme: 'raw',
      }),
      { fetchImpl, persistAuthScheme: persist },
    );
    const result = await conn.testConnection();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Token'); // 原鉴权失败文案
    expect(persist).not.toHaveBeenCalled();
    expect(callCount).toBe(2); // raw 一次 + bearer 重试一次，initialize 即被拒
  });

  it("authScheme 'none' 遇 401 不重试（URL 内嵌凭据无可互换 scheme）", async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      return new Response('x', { status: 401 });
    }) as typeof fetch;
    const persist = vi.fn(async () => {});
    const conn = createMcpConnector(
      profileWith({
        endpoint: 'https://open.feishu.cn/mcp/stream/mcp_abc',
        token: 'stray',
        authScheme: 'none',
      }),
      { fetchImpl, persistAuthScheme: persist },
    );
    const result = await conn.testConnection();
    expect(result.ok).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    expect(callCount).toBe(1);
  });

  it('持久化失败不阻断主流程：静默降级为仅本次生效', async () => {
    const p = profileWith({
      endpoint: 'https://docs.qq.com/openapi/mcp',
      token: 'tk',
      authScheme: 'raw',
    });
    const { fetchImpl } = authSensitiveFetch('tk');
    const persist = vi.fn(async () => {
      throw new Error('storage down');
    });
    const conn = createMcpConnector(p, { fetchImpl, persistAuthScheme: persist });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true); // 重试成功本身不受影响
    expect(result.detail).toContain('已自动切换为 Bearer 鉴权');
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('local-mcp（语雀等 stdio MCP 经本机代理）', () => {
  function localProfile(config: Record<string, unknown>): ConnectorProfile {
    return {
      id: 'lp1',
      kind: 'local-mcp',
      name: '语雀',
      status: 'beta',
      config,
      createdAt: 0,
    };
  }

  it('端点由端口构造（http://127.0.0.1:<port>/mcp），bridge token 走 Bearer', async () => {
    const { requests, fetchImpl } = mockMcpFetch({
      tools: [{ name: 'create_document_with_toc' }, { name: 'get_document' }],
    });
    const conn = createMcpConnector(localProfile({ port: 27184, token: 'bridge-tok' }), {
      fetchImpl,
    });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(requests[0].url).toBe('http://127.0.0.1:27184/mcp');
    expect(requests[0].headers.Authorization).toBe('Bearer bridge-tok');
  });

  it('缺省端口 = 27184；回环地址仅此 kind 放行', async () => {
    const { requests, fetchImpl } = mockMcpFetch({ tools: [] });
    const conn = createMcpConnector(localProfile({ token: 'bt' }), { fetchImpl });
    await conn.testConnection();
    expect(requests[0].url).toBe('http://127.0.0.1:27184/mcp');
  });

  it('非法端口在构造时即被拒绝', () => {
    expect(() => createMcpConnector(localProfile({ port: 70000, token: 'bt' }))).toThrow(/端口/);
  });

  it('连不上本机代理时给出启动指引提示', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const conn = createMcpConnector(localProfile({ port: 27184, token: 'bt' }), { fetchImpl });
    const result = await conn.testConnection();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mcp-proxy');
  });
});
