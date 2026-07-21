// MCP 连接器：写入工具优先级选择 / 参数键名推断 / externalId 提取
import { describe, expect, it } from 'vitest';
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

/** 按 RPC method 返回固定结果的 fetch mock，记录 tools/call 入参 */
function mockMcpFetch(handlers: {
  tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[];
  callResult?: unknown;
}) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
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
  return { calls, fetchImpl };
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
});
