// MCP streamable-HTTP 客户端：JSON-RPC 帧 / SSE 与 JSON 解析 / 超时与鉴权错误分类
import { describe, expect, it } from 'vitest';
import {
  createMcpClient,
  mapToolCapabilities,
  McpError,
  parseSseForId,
} from '../lib/connectors/mcpClient';

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: { jsonrpc: string; id: number; method: string; params: Record<string, unknown> };
}

function jsonRpc(result: unknown, id: number) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 记录请求并按 method 路由到给定结果 */
function mockFetch(route: (method: string, params: Record<string, unknown>) => unknown) {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as CapturedCall['body'];
    calls.push({ url: String(url), init: init ?? {}, body });
    return jsonRpc(route(body.method, body.params ?? {}), body.id);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('mcpClient JSON-RPC 帧', () => {
  it('initialize → tools/list → tools/call：方法名 / 参数 / 自增 id / 请求头', async () => {
    const { calls, fetchImpl } = mockFetch((method) =>
      method === 'initialize'
        ? { protocolVersion: '2025-03-26', serverInfo: { name: 'srv', version: '1.2' } }
        : method === 'tools/list'
          ? { tools: [{ name: 'create_page' }] }
          : { id: 'p1' },
    );
    const client = createMcpClient({
      endpoint: 'https://mcp.example.com/rpc',
      token: 'secret-token',
      fetchImpl,
    });

    const info = await client.initialize();
    expect(info).toEqual({ serverName: 'srv', serverVersion: '1.2', protocolVersion: '2025-03-26' });
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['create_page']);
    await client.callTool('create_page', { title: 't' });

    expect(calls.map((c) => [c.body.id, c.body.method])).toEqual([
      [1, 'initialize'],
      [2, 'tools/list'],
      [3, 'tools/call'],
    ]);
    expect(calls[0].body.jsonrpc).toBe('2.0');
    expect(calls[0].body.params.protocolVersion).toBe('2025-03-26');
    expect(calls[2].body.params).toEqual({ name: 'create_page', arguments: { title: 't' } });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-token');
    expect(headers.Accept).toContain('application/json');
    expect(headers.Accept).toContain('text/event-stream');
    expect(calls[0].url).toBe('https://mcp.example.com/rpc');
  });

  it('无 token 时不带 Authorization 头', async () => {
    const { calls, fetchImpl } = mockFetch(() => ({}));
    const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
    await client.initialize();
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe('mcpClient 响应解析', () => {
  it('SSE 响应：从 data 帧中取 id 匹配的消息', async () => {
    const sse = [
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"sse-srv"}}}',
      '',
      '',
    ].join('\n');
    const fetchImpl = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch;
    const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
    const info = await client.initialize();
    expect(info.serverName).toBe('sse-srv');
  });

  it('parseSseForId：多帧中只取匹配 id；无匹配返回 null', () => {
    const text =
      'data: {"jsonrpc":"2.0","id":2,"result":{"a":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":7,"result":{"b":2}}\n\n';
    expect(parseSseForId(text, 7)?.result).toEqual({ b: 2 });
    expect(parseSseForId(text, 9)).toBeNull();
  });

  it('RPC error 字段 → protocol 错误', async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
    const err = await client.initialize().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).kind).toBe('protocol');
    expect((err as McpError).message).toContain('Method not found');
  });
});

describe('mcpClient 错误分类', () => {
  it('HTTP 401/403 → auth', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = (async () => new Response('x', { status })) as typeof fetch;
      const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
      const err = await client.initialize().catch((e) => e);
      expect((err as McpError).kind).toBe('auth');
    }
  });

  it('HTTP 500 → connect', async () => {
    const fetchImpl = (async () => new Response('x', { status: 500 })) as typeof fetch;
    const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
    const err = await client.initialize().catch((e) => e);
    expect((err as McpError).kind).toBe('connect');
    expect((err as McpError).message).toContain('500');
  });

  it('fetch 抛错（网络失败）→ connect', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const client = createMcpClient({ endpoint: 'https://mcp.example.com', fetchImpl });
    const err = await client.initialize().catch((e) => e);
    expect((err as McpError).kind).toBe('connect');
  });

  it('超时中止 → timeout', async () => {
    const fetchImpl = (( _url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      })) as typeof fetch;
    const client = createMcpClient({
      endpoint: 'https://mcp.example.com',
      fetchImpl,
      timeoutMs: 20,
    });
    const err = await client.initialize().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).kind).toBe('timeout');
    // 错误信息不携带 token 等敏感信息（§8）
    expect((err as McpError).userMessage).not.toContain('Bearer');
  });
});

describe('mapToolCapabilities 工具名 → 能力映射', () => {
  it('子串匹配（大小写不敏感），按规范顺序去重', () => {
    expect(
      mapToolCapabilities([
        'search_docs',
        'ReadPage',
        'get_block',
        'create_page',
        'APPEND_children',
        'update_title',
        'comment_on',
        'unrelated',
      ]),
    ).toEqual(['search', 'read', 'get', 'create', 'append', 'update']);
  });

  it('一个工具名可命中多个能力；无命中返回空', () => {
    expect(mapToolCapabilities(['create_and_append'])).toEqual(['create', 'append']);
    expect(mapToolCapabilities(['delete_everything'])).toEqual([]);
  });
});
