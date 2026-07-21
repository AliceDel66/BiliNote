// bridge mcp-proxy（scripts/bridge.mjs mcp-proxy）真实子进程测试：
// 随机端口起代理 + fixture stdio MCP 服务，覆盖 initialize/tools/list/tools/call
// 往返、鉴权 401、子进程崩溃 → JSON-RPC error、子进程超时 → JSON-RPC error、
// 非 JSON 杂讯行容忍、请求格式非法 → -32600。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const TOKEN = 'proxy-test-token';
const RPC_TIMEOUT_MS = 500; // 测试加速；CLI 默认 15000
let child: ChildProcess | null = null;
let base = '';

beforeAll(async () => {
  const fixture = path.resolve('test/fixtures/stdioMcpFixture.mjs');
  child = spawn(
    process.execPath,
    [
      'scripts/bridge.mjs',
      'mcp-proxy',
      '--command',
      `${process.execPath} ${fixture}`,
      '--port',
      '0',
      '--token',
      TOKEN,
      '--rpc-timeout',
      String(RPC_TIMEOUT_MS),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mcp-proxy 启动超时')), 8000);
    let buf = '';
    child!.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child!.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`mcp-proxy 提前退出：${buf}`));
    });
  });
}, 15000);

afterAll(() => {
  child?.kill('SIGTERM');
  child = null;
});

async function rpc(
  body: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

describe('scripts/bridge.mjs mcp-proxy（真实子进程）', () => {
  it('鉴权：无 token / 错 token → 401', async () => {
    const noAuth = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null);
    expect(noAuth.status).toBe(401);
    const wrong = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, 'nope');
    expect(wrong.status).toBe(401);
  });

  it('initialize 往返：忽略子进程 stdout 杂讯行，返回 serverInfo', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.status).toBe(200);
    const result = r.json.result as { serverInfo?: { name?: string } };
    expect(result.serverInfo?.name).toBe('fixture-mcp');
  });

  it('tools/list 与 tools/call 透传往返', async () => {
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = (list.json.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(['create_document_with_toc', 'get_document']);

    const call = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_document_with_toc', arguments: { title: 't' } },
    });
    const content = (call.json.result as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text).documentId).toBe('doc-1');
  });

  it('未知方法透传子进程的 JSON-RPC error', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    const err = r.json.error as { code: number; message: string };
    expect(err.code).toBe(-32601);
  });

  it('请求格式非法（缺 method）→ -32600', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 5 });
    const err = r.json.error as { code: number };
    expect(err.code).toBe(-32600);
  });

  it('子进程超时 → JSON-RPC error（-32001）', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 6, method: 'hang' });
    expect(r.status).toBe(200);
    const err = r.json.error as { code: number; message: string };
    expect(err.code).toBe(-32001);
    expect(err.message).toContain('超时');
    // 超时不弄坏后续请求
    const after = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(after.json.result).toBeTruthy();
  });

  it('子进程崩溃 → 挂起请求与后续请求都返回 JSON-RPC error', async () => {
    const dying = await rpc({ jsonrpc: '2.0', id: 8, method: 'die' });
    const err1 = dying.json.error as { code: number; message: string };
    expect(err1.message).toContain('退出');

    const after = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    const err2 = after.json.error as { code: number; message: string };
    expect(err2.message).toContain('退出');
  });
});
