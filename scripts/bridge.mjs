#!/usr/bin/env node
/**
 * BiliNote Local Markdown Bridge（参考实现 · Node ≥20 · 零依赖，仅 node:http + node:fs）
 *
 * 用法：
 *   node scripts/bridge.mjs --root <vaultDir> [--port 27183] [--token <token>]
 *   --token 省略时自动生成并在启动时打印（仅本次启动有效）。
 *
 * 协议（JSON in/out；所有请求需 Authorization: Bearer <token>；仅监听 127.0.0.1）：
 *   GET  /v1/health                  → {ok, name, version, root}
 *   POST /v1/search  {query}         → {results: [{path, snippet}]}（.md 文件名 + 全文子串匹配，≤50 条）
 *   POST /v1/read    {path}          → {path, content}
 *   POST /v1/create  {path, content} → 全量写入（存在即覆盖，自动建目录）→ {path, mode: 'created'|'overwritten'}
 *   POST /v1/append  {path, content} → 幂等追加：已有内容是 incoming 的前缀 → 只补后缀；
 *                                      内容一致 → 不变；否则全量覆盖 → {path, mode}
 *   （BiliNote 同步永远整篇发送，该语义保证重复同步不产生重复内容。）
 *
 * 安全：path 一律相对 --root，拒绝绝对路径与 `..` 逃逸；请求体上限 1 MB。
 * 一个 bridge 同时覆盖 Obsidian / Logseq / 纯 Markdown vault。
 * 语雀本地 MCP 可经扩展内「Custom Remote MCP」或未来的 Bridge 插件接入。
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const MAX_BODY = 1024 * 1024; // 1 MB
const SEARCH_FILE_CAP = 2000;
const SEARCH_RESULT_CAP = 50;

// ---------- 参数 ----------

function parseArgs(argv) {
  const args = { root: '', port: 27183, token: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i] ?? '';
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--token') args.token = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') {
      console.log('node scripts/bridge.mjs --root <vaultDir> [--port 27183] [--token <token>]');
      process.exit(0);
    } else {
      console.error(`未知参数：${a}`);
      process.exit(2);
    }
  }
  return args;
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

// ---------- 启动 ----------

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const args = parseArgs(process.argv);
  if (!args.root) {
    console.error('缺少 --root <笔记目录>，例如：node scripts/bridge.mjs --root ~/Documents/vault');
    process.exit(2);
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    console.error('--port 必须是 0–65535 的整数（0 = 随机端口）');
    process.exit(2);
  }
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
