// 参考 bridge（scripts/bridge.mjs）真实 HTTP 测试：随机端口起子进程，
// 覆盖健康检查 / create / 幂等 append / read / search / 路径逃逸拦截 / 1MB 上限。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TOKEN = 'test-token';
let child: ChildProcess | null = null;
let base = '';
let root = '';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bilinote-bridge-test-'));
  child = spawn(
    process.execPath,
    ['scripts/bridge.mjs', '--root', root, '--port', '0', '--token', TOKEN],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('bridge 启动超时')), 8000);
    let buf = '';
    child!.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    });
    child!.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`bridge 提前退出：${buf}`));
    });
  });
}, 15000);

afterAll(async () => {
  child?.kill('SIGTERM');
  child = null;
  await rm(root, { recursive: true, force: true });
});

async function api(
  pathname: string,
  body?: Record<string, unknown>,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`${base}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

describe('scripts/bridge.mjs（真实 HTTP）', () => {
  it('health：无 token 401；有 token 返回 root', async () => {
    const noAuth = await api('/v1/health', undefined, null);
    expect(noAuth.status).toBe(401);
    const wrong = await api('/v1/health', undefined, 'nope');
    expect(wrong.status).toBe(401);
    const ok = await api('/v1/health');
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
    expect(ok.json.root).toBe(root);
  });

  it('create：全量写入并自动建目录；重复 create 覆盖', async () => {
    const r1 = await api('/v1/create', { path: 'BiliNote/课程/P1 导论.md', content: '# v1' });
    expect(r1.status).toBe(200);
    expect(r1.json.mode).toBe('created');
    const onDisk = await readFile(path.join(root, 'BiliNote/课程/P1 导论.md'), 'utf8');
    expect(onDisk).toBe('# v1');

    const r2 = await api('/v1/create', { path: 'BiliNote/课程/P1 导论.md', content: '# v2' });
    expect(r2.json.mode).toBe('overwritten');
    expect(await readFile(path.join(root, 'BiliNote/课程/P1 导论.md'), 'utf8')).toBe('# v2');
  });

  it('append：前缀增长只补后缀；内容一致不变；分叉则覆盖（重复同步不产生重复）', async () => {
    await api('/v1/create', { path: 'n.md', content: '# 笔记' });
    const grown = await api('/v1/append', { path: 'n.md', content: '# 笔记\n\n新增问答' });
    expect(grown.json.mode).toBe('appended');
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('# 笔记\n\n新增问答');

    const same = await api('/v1/append', { path: 'n.md', content: '# 笔记\n\n新增问答' });
    expect(same.json.mode).toBe('unchanged');
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('# 笔记\n\n新增问答');

    const diverged = await api('/v1/append', { path: 'n.md', content: '# 完全不同的笔记' });
    expect(diverged.json.mode).toBe('overwritten');
    expect(await readFile(path.join(root, 'n.md'), 'utf8')).toBe('# 完全不同的笔记');
  });

  it('read：返回内容；不存在 → 404', async () => {
    const ok = await api('/v1/read', { path: 'n.md' });
    expect(ok.status).toBe(200);
    expect(ok.json.content).toBe('# 完全不同的笔记');
    const missing = await api('/v1/read', { path: 'ghost.md' });
    expect(missing.status).toBe(404);
  });

  it('路径逃逸一律 400：.. / 嵌套 .. / 绝对路径', async () => {
    for (const p of ['../evil.md', 'a/../../evil.md', '/etc/evil.md', 'BiliNote/../../evil.md']) {
      const r = await api('/v1/create', { path: p, content: 'x' });
      expect(r.status, p).toBe(400);
    }
    // root 之外没有产生文件
    await expect(readFile(path.join(root, '..', 'evil.md'), 'utf8')).rejects.toThrow();
  });

  it('search：按文件名与全文子串命中', async () => {
    await api('/v1/create', { path: 'BiliNote/操作系统/P2 进程管理.md', content: '进程与线程的区别' });
    const hit = await api('/v1/search', { query: '线程' });
    expect(hit.status).toBe(200);
    const results = hit.json.results as { path: string; snippet: string }[];
    expect(results.some((r) => r.path.includes('P2 进程管理.md'))).toBe(true);
    const miss = await api('/v1/search', { query: '不存在的关键词xyz' });
    expect((miss.json.results as unknown[]).length).toBe(0);
  });

  it('请求体超过 1 MB → 413', async () => {
    const big = await api('/v1/create', { path: 'big.md', content: 'x'.repeat(1024 * 1024) });
    expect(big.status).toBe(413);
  });
});
