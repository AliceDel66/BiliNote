#!/usr/bin/env node
/**
 * BiliNote Local Markdown Bridge（参考实现 · Node ≥20 · 零依赖，仅 node:http + node:fs）
 *
 * 用法：
 *   node scripts/bridge.mjs --root <vaultDir> [--port 27183] [--token <token>]
 *   node scripts/bridge.mjs mcp-proxy --command "<cmd...>" [--env K=V ...] [--port 27184]
 *                          [--token <token>] [--rpc-timeout 15000]
 *   --token 省略时自动生成并在启动时打印（仅本次启动有效）。
 *
 * Markdown 协议（JSON in/out；所有请求需 Authorization: Bearer <token>；仅监听 127.0.0.1）：
 *   GET  /v1/health                  → {ok, name, version, root}
 *   POST /v1/search  {query}         → {results: [{path, snippet}]}（.md 文件名 + 全文子串匹配，≤50 条）
 *   POST /v1/read    {path}          → {path, content}
 *   POST /v1/create  {path, content} → 全量写入（存在即覆盖，自动建目录）→ {path, mode: 'created'|'overwritten'}
 *   POST /v1/append  {path, content} → 幂等追加：已有内容是 incoming 的前缀 → 只补后缀；
 *                                      内容一致 → 不变；否则全量覆盖 → {path, mode}
 *   （BiliNote 同步永远整篇发送，该语义保证重复同步不产生重复内容。）
 *
 * mcp-proxy 模式（HTTP ↔ stdio 代理，供扩展内 local-mcp 连接器使用）：
 *   POST /mcp  <JSON-RPC 2.0 单请求> → 转发给子进程 stdin（换行分隔 JSON，FastMCP/stdio
 *   帧格式），等待同 id 的 stdout 行后原样返回单个 JSON-RPC 响应；子进程超时（默认 15s）、
 *   子进程退出或请求格式非法时返回 JSON-RPC error。initialize 成功后自动补发
 *   notifications/initialized。子进程 stderr 加 [mcp-child] 前缀转发到本进程 stderr。
 *
 * 安全：path 一律相对 --root，拒绝绝对路径与 `..` 逃逸；请求体上限 1 MB。
 * 一个 bridge 同时覆盖 Obsidian / Logseq / 纯 Markdown vault。
 * 语雀等 stdio MCP 服务经 mcp-proxy 子命令接入（详见 --help 的语雀示例）。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const MAX_BODY = 1024 * 1024; // 1 MB
const SEARCH_FILE_CAP = 2000;
const SEARCH_RESULT_CAP = 50;
const DEFAULT_PROXY_PORT = 27184;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

const HELP = `用法：
  Markdown 模式：
    node scripts/bridge.mjs --root <vaultDir> [--port 27183] [--token <token>]

  MCP stdio 代理模式（供扩展内 local-mcp 连接器使用）：
    node scripts/bridge.mjs mcp-proxy --command "<cmd...>" [--env K=V ...]
                            [--port ${DEFAULT_PROXY_PORT}] [--token <token>] [--rpc-timeout ${DEFAULT_RPC_TIMEOUT_MS}]

  语雀（yuque-mcp）完整示例：
    ① pip install -e .        # 或 uv pip install -e .，安装 EnglandLobster/yuque-mcp
    ② 从 https://www.yuque.com/settings/tokens 获取 API Token
    ③ node scripts/bridge.mjs mcp-proxy \\
         --command "python -m yuque_mcp.server" \\
         --env YUQUE_API_TOKEN=<你的语雀Token> --port ${DEFAULT_PROXY_PORT}
    ④ 在扩展设置页「语雀」连接中填入端口与 bridge token，点「连接测试」

  --token 省略时自动生成并在启动时打印（仅本次启动有效）。
`;

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { root: '', port: 27183, token: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i] ?? '';
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--token') args.token = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

function parseProxyArgs(argv) {
  const args = {
    command: '',
    env: [],
    port: DEFAULT_PROXY_PORT,
    token: '',
    rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
  };
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--command') args.command = argv[++i] ?? '';
    else if (a === '--env') args.env.push(argv[++i] ?? '');
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--token') args.token = argv[++i] ?? '';
    else if (a === '--rpc-timeout') args.rpcTimeoutMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(HELP);
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
}

/** --env K=V 列表 → 环境变量对象（K 为空或缺 = 视为用法错误） */
export function parseEnvPairs(pairs) {
  const env = {};
  for (const p of pairs) {
    const i = String(p).indexOf('=');
    if (i <= 0) throw new Error(`--env 需要 K=V 形式，收到：${p}`);
    env[String(p).slice(0, i)] = String(p).slice(i + 1);
  }
  return env;
}

// ---------- 工具 ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** path containment：相对 ROOT 解析，拒绝绝对路径与 .. 逃逸 */
export function resolveWithinRoot(root, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new HttpError(400, 'path 不能为空');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    throw new HttpError(400, 'path 必须是相对路径');
  }
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw new HttpError(400, 'path 越界（不允许逃出 root 目录）');
  }
  return abs;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求体超过 1 MB 上限');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

async function pathExists(abs) {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** 幂等追加（协议见文件头注释） */
export function mergeAppend(existing, incoming) {
  if (existing === incoming) return { content: existing, mode: 'unchanged' };
  if (incoming.startsWith(existing)) return { content: incoming, mode: 'appended' };
  return { content: incoming, mode: 'overwritten' };
}

async function walkMarkdown(dir, out, cap) {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= cap) return;
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walkMarkdown(abs, out, cap);
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(abs);
  }
}

// ---------- 路由 ----------

function createHandler(root, token) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      throw new HttpError(401, 'token 无效');
    }

    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return { ok: true, name: 'bilinote-bridge', version: VERSION, root };
    }
    if (req.method !== 'POST') throw new HttpError(404, 'not found');

    const body = await readJsonBody(req);

    if (url.pathname === '/v1/read') {
      const abs = resolveWithinRoot(root, body.path);
      try {
        return { path: body.path, content: await fs.readFile(abs, 'utf8') };
      } catch {
        throw new HttpError(404, `文件不存在：${body.path}`);
      }
    }

    if (url.pathname === '/v1/create') {
      const abs = resolveWithinRoot(root, body.path);
      const content = String(body.content ?? '');
      const existed = await pathExists(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return { path: body.path, mode: existed ? 'overwritten' : 'created' };
    }

    if (url.pathname === '/v1/append') {
      const abs = resolveWithinRoot(root, body.path);
      const incoming = String(body.content ?? '');
      let existing = '';
      try {
        existing = await fs.readFile(abs, 'utf8');
      } catch {
        /* 文件不存在：按新建处理 */
      }
      const merged = mergeAppend(existing, incoming);
      if (merged.mode !== 'unchanged') {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, merged.content, 'utf8');
      }
      return { path: body.path, mode: merged.mode };
    }

    if (url.pathname === '/v1/search') {
      const query = String(body.query ?? '').trim().toLowerCase();
      if (!query) return { results: [] };
      const files = [];
      await walkMarkdown(root, files, SEARCH_FILE_CAP);
      const results = [];
      for (const abs of files) {
        if (results.length >= SEARCH_RESULT_CAP) break;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        let content = '';
        try {
          content = await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const lower = content.toLowerCase();
        const idx = lower.indexOf(query);
        if (!rel.toLowerCase().includes(query) && idx < 0) continue;
        const snippet =
          idx >= 0
            ? content.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ').trim()
            : '';
        results.push({ path: rel, snippet });
      }
      return { results };
    }

    throw new HttpError(404, 'not found');
  };
}

/** 创建 bridge HTTP server（工厂导出，便于测试直接起服务） */
export function createBridgeServer({ root, token }) {
  const handle = createHandler(path.resolve(root), token);
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    try {
      const data = await handle(req, res);
      if (!res.writableEnded) {
        res.writeHead(200);
        res.end(JSON.stringify(data));
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: e.message ?? String(e) }));
    }
  });
}

// ---------- mcp-proxy：HTTP ↔ stdio JSON-RPC 代理 ----------

/**
 * 把 stdio MCP 服务（换行分隔 JSON-RPC 2.0，FastMCP 帧格式）代理成
 * POST /mcp 单请求单响应的 streamable-HTTP 端点（与扩展内 mcpClient 对齐）。
 * - 子进程响应按 id 匹配挂起请求；非 JSON 行（库的 stdout 杂讯）记日志后忽略；
 * - 子进程超时（默认 15s）/ 退出 / 请求非法 → JSON-RPC error；
 * - initialize 成功后自动补发 notifications/initialized（部分 stdio 服务要求）。
 */
export function createMcpProxyServer({ command, envPairs = [], token, rpcTimeoutMs }) {
  const timeoutMs = Number.isFinite(rpcTimeoutMs) && rpcTimeoutMs > 0
    ? rpcTimeoutMs
    : DEFAULT_RPC_TIMEOUT_MS;
  const child = spawn(command, {
    shell: true,
    env: { ...process.env, ...parseEnvPairs(envPairs) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let exited = false;
  let exitCode = null;
  const pending = new Map(); // id → { resolve, timer }

  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  function failAll(message) {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(rpcError(id, -32000, message));
    }
    pending.clear();
  }

  function writeLine(msg) {
    try {
      child.stdin.write(JSON.stringify(msg) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 子进程 stdout 的非 JSON 杂讯（日志 / banner）：忽略，不打断协议
        process.stderr.write(`[mcp-child-stdout] ${line.slice(0, 300)}\n`);
        continue;
      }
      if (msg && msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }
  });
  child.stderr.on('data', (d) => {
    process.stderr.write(`[mcp-child] ${d.toString('utf8')}`);
  });
  const onGone = (code) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    failAll(`MCP 子进程已退出（code ${code ?? '?'}）`);
  };
  child.on('exit', onGone);
  child.on('error', () => onGone(null));

  async function request(msg) {
    // 通知（无 id）：转发即可，无响应体概念
    if (msg.id === undefined || msg.id === null) {
      writeLine(msg);
      return { jsonrpc: '2.0', id: null, result: {} };
    }
    if (exited) return rpcError(msg.id, -32000, `MCP 子进程不可用（已退出，code ${exitCode ?? '?'}）`);
    const resp = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        resolve(rpcError(msg.id, -32001, `MCP 子进程响应超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      pending.set(msg.id, { resolve, timer });
      if (!writeLine(msg)) {
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(rpcError(msg.id, -32000, 'MCP 子进程 stdin 不可写（可能已退出）'));
      }
    });
    if (msg.method === 'initialize' && resp && !resp.error) {
      writeLine({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
    return resp;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        throw new HttpError(401, 'token 无效');
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') throw new HttpError(404, 'not found');
      const body = await readJsonBody(req);
      const data =
        !body || typeof body !== 'object' || typeof body.method !== 'string'
          ? rpcError(body?.id, -32600, 'Invalid JSON-RPC request：需要带 method 的 JSON 对象')
          : await request(body);
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      res.writeHead(status);
      res.end(JSON.stringify({ error: e.message ?? String(e) }));
    }
  });

  server.killChild = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 已退出 */
    }
  };
  return server;
}

// ---------- 启动 ----------

function checkPort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port 必须是 0–65535 的整数（0 = 随机端口）');
    process.exit(2);
  }
}

function startMarkdownBridge(argv) {
  const args = parseArgs(argv);
  if (!args.root) {
    console.error('缺少 --root <笔记目录>，例如：node scripts/bridge.mjs --root ~/Documents/vault');
    process.exit(2);
  }
  checkPort(args.port);
  const root = path.resolve(args.root);
  const token = args.token || crypto.randomBytes(16).toString('hex');
  const server = createBridgeServer({ root, token });
  server.listen(args.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`bilinote-bridge listening on http://127.0.0.1:${port}`);
    console.log(`root: ${root}`);
    if (!args.token) console.log(`token: ${token}（自动生成，仅本次启动有效）`);
  });
}

function startMcpProxy(argv) {
  const args = parseProxyArgs(argv);
  if (!args.command) {
    console.error('缺少 --command "<cmd...>"，例如：--command "python -m yuque_mcp.server"');
    process.exit(2);
  }
  checkPort(args.port);
  if (!Number.isFinite(args.rpcTimeoutMs) || args.rpcTimeoutMs <= 0) {
    console.error('--rpc-timeout 必须是正整数（毫秒）');
    process.exit(2);
  }
  try {
    parseEnvPairs(args.env);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const token = args.token || crypto.randomBytes(16).toString('hex');
  const server = createMcpProxyServer({
    command: args.command,
    envPairs: args.env,
    token,
    rpcTimeoutMs: args.rpcTimeoutMs,
  });
  // 优雅退出：bridge 被杀时带走 MCP 子进程
  const shutdown = () => server.killChild();
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('exit', shutdown);
  server.listen(args.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`bilinote-mcp-proxy listening on http://127.0.0.1:${port}/mcp`);
    console.log(`command: ${args.command}`);
    if (!args.token) console.log(`token: ${token}（自动生成，仅本次启动有效）`);
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  if (process.argv[2] === 'mcp-proxy') startMcpProxy(process.argv);
  else startMarkdownBridge(process.argv);
}
