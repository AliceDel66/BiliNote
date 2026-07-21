// Local Markdown Bridge 连接器：路径清洗 / create-vs-append / 健康检查与错误提示
import { describe, expect, it } from 'vitest';
import {
  bridgeNotePath,
  createBridgeConnector,
  sanitizePathSegment,
} from '../lib/connectors/bridgeConnector';
import type { ConnectorProfile } from '../lib/connectors/types';

function profile(): ConnectorProfile {
  return {
    id: 'b1',
    kind: 'local-bridge',
    name: '本地 Markdown 库',
    status: 'stable',
    config: { port: 27183, token: 'tok-1' },
    createdAt: 0,
  };
}

function captureFetch(route: (path: string, body?: Record<string, unknown>) => Response) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    return route(u.pathname, body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const okJson = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

describe('sanitizePathSegment / bridgeNotePath', () => {
  it('清洗非法文件名字符并折叠空白', () => {
    expect(sanitizePathSegment('A/B\\C:D*E?F"G<H>I|J')).toBe('A B C D E F G H I J');
    expect(sanitizePathSegment('  多重   空格  ')).toBe('多重 空格');
    expect(sanitizePathSegment('|||')).toBe('未命名');
  });

  it('笔记路径：BiliNote/<课程>/<分P或课程>.md', () => {
    expect(bridgeNotePath({ courseTitle: '操作系统课程', partLabel: 'P2 进程管理' })).toBe(
      'BiliNote/操作系统课程/P2 进程管理.md',
    );
    expect(bridgeNotePath({ courseTitle: '操作系统课程' })).toBe(
      'BiliNote/操作系统课程/操作系统课程.md',
    );
    expect(bridgeNotePath({ courseTitle: 'A/B: 课程?' })).toBe('BiliNote/A B 课程/A B 课程.md');
  });
});

describe('bridgeConnector.testConnection', () => {
  it('GET /v1/health 带 Bearer token；成功返回目录信息', async () => {
    const { calls, fetchImpl } = captureFetch((path) =>
      path === '/v1/health' ? okJson({ ok: true, root: '/vault' }) : new Response('nf', { status: 404 }),
    );
    const conn = createBridgeConnector(profile(), { fetchImpl });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('/vault');
    expect(result.detail).toContain('27183');
    expect(calls[0].url).toBe('http://127.0.0.1:27183/v1/health');
    expect(calls[0].headers.Authorization).toBe('Bearer tok-1');
  });

  it('连接失败 → 提示启动 bridge；401 → 提示 token 核对', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const r1 = await createBridgeConnector(profile(), { fetchImpl: down }).testConnection();
    expect(r1.ok).toBe(false);
    expect(r1.detail).toContain('scripts/bridge.mjs');

    const unauthorized = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    const r2 = await createBridgeConnector(profile(), { fetchImpl: unauthorized }).testConnection();
    expect(r2.ok).toBe(false);
    expect(r2.detail).toContain('token');
  });
});

describe('bridgeConnector.upsertCourseNote', () => {
  it('无 externalId → POST /v1/create（全量写入）', async () => {
    const { calls, fetchImpl } = captureFetch(() => okJson({ path: 'p', mode: 'created' }));
    const conn = createBridgeConnector(profile(), { fetchImpl });
    const result = await conn.upsertCourseNote({
      courseTitle: '操作系统课程',
      partLabel: 'P2 进程管理',
      contentMd: '# 内容',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://127.0.0.1:27183/v1/create');
    expect(calls[0].body).toEqual({
      path: 'BiliNote/操作系统课程/P2 进程管理.md',
      content: '# 内容',
    });
    expect(result.externalId).toBe('BiliNote/操作系统课程/P2 进程管理.md');
  });

  it('有 externalId → POST /v1/append（幂等追加到原路径）', async () => {
    const { calls, fetchImpl } = captureFetch(() => okJson({ path: 'p', mode: 'appended' }));
    const conn = createBridgeConnector(profile(), { fetchImpl });
    const result = await conn.upsertCourseNote({
      courseTitle: '新课程名',
      contentMd: '# 更长的内容',
      externalId: 'BiliNote/旧课程/旧分P.md',
    });
    expect(calls[0].url).toBe('http://127.0.0.1:27183/v1/append');
    expect(calls[0].body?.path).toBe('BiliNote/旧课程/旧分P.md');
    expect(result.externalId).toBe('BiliNote/旧课程/旧分P.md');
  });

  it('HTTP 500 → 抛出带服务端信息的错误', async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })) as typeof fetch;
    const conn = createBridgeConnector(profile(), { fetchImpl: failing });
    await expect(
      conn.upsertCourseNote({ courseTitle: 'x', contentMd: 'y' }),
    ).rejects.toThrow(/disk full/);
  });
});
