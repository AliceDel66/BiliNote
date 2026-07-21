// 语雀官方 OpenAPI connector：Host/鉴权/知识库选择/首次创建/Markdown 全量更新
import { describe, expect, it } from 'vitest';
import {
  createYuqueConnector,
  listYuqueKnowledgeBases,
  normalizeYuqueHost,
  type ConnectorProfile,
} from '../lib/connectors';

function profile(overrides?: Partial<ConnectorProfile['config']>): ConnectorProfile {
  return {
    id: 'yuque-1',
    kind: 'yuque',
    name: '语雀知识库',
    status: 'beta',
    config: {
      token: 'yuque-token',
      host: 'https://www.yuque.com',
      repoId: '42',
      repoName: '课程库',
      ...overrides,
    },
    createdAt: 1,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('normalizeYuqueHost', () => {
  it('接受语雀官方云域名并剥离 API 路径', () => {
    expect(normalizeYuqueHost('')).toBe('https://www.yuque.com');
    expect(normalizeYuqueHost('https://team.yuque.com/api/v2/')).toBe(
      'https://team.yuque.com',
    );
  });

  it('拒绝 HTTP、非语雀域名与 URL 内凭据', () => {
    expect(() => normalizeYuqueHost('http://www.yuque.com')).toThrow(/HTTPS/);
    expect(() => normalizeYuqueHost('https://yuque.com.example.com')).toThrow(/yuque\.com/);
    expect(() => normalizeYuqueHost('https://token@www.yuque.com')).toThrow(/用户名|密码/);
  });
});

describe('listYuqueKnowledgeBases', () => {
  it('用 X-Auth-Token 验证用户，并按 offset 拉取知识库', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `知识库 ${index + 1}`,
      namespace: `user/repo-${index + 1}`,
    }));
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
      });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/user')) return json({ data: { login: 'alice' } });
      return parsed.searchParams.get('offset') === '0'
        ? json({ data: firstPage })
        : json({ data: [{ id: 101, name: '最后一库', namespace: 'alice/last' }] });
    }) as typeof fetch;

    const repos = await listYuqueKnowledgeBases(
      { token: ' token-value ', host: 'https://team.yuque.com/api/v2' },
      { fetchImpl },
    );

    expect(repos).toHaveLength(101);
    expect(repos[100]).toEqual({ id: '101', name: '最后一库', namespace: 'alice/last' });
    expect(calls.map((call) => call.url)).toEqual([
      'https://team.yuque.com/api/v2/user',
      'https://team.yuque.com/api/v2/users/alice/repos?limit=100&offset=0',
      'https://team.yuque.com/api/v2/users/alice/repos?limit=100&offset=100',
    ]);
    expect(calls.every((call) => call.headers['X-Auth-Token'] === 'token-value')).toBe(true);
  });
});

describe('createYuqueConnector', () => {
  it('连接测试确认所选知识库仍可访问', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/user')
        ? json({ data: { login: 'alice' } })
        : json({ data: [{ id: 42, name: '课程库' }] });
    }) as typeof fetch;

    await expect(createYuqueConnector(profile(), { fetchImpl }).testConnection()).resolves.toEqual({
      ok: true,
      detail: '已连接语雀，可写入「课程库」',
    });
  });

  it('首次同步创建 Markdown 文档，并 best-effort 追加到 TOC', async () => {
    const calls: {
      path: string;
      method: string;
      headers: Record<string, string>;
      body?: unknown;
    }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        path,
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string>,
        body,
      });
      return path.endsWith('/docs')
        ? json({ data: { id: 123, url: 'https://www.yuque.com/alice/course/doc' } })
        : json({ data: [] });
    }) as typeof fetch;

    const result = await createYuqueConnector(profile(), { fetchImpl }).upsertCourseNote({
      courseTitle: '操作系统',
      partLabel: 'P2 进程管理',
      contentMd: '# 课程笔记\n\n内容',
    });

    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ['POST', '/api/v2/repos/42/docs'],
      ['PUT', '/api/v2/repos/42/toc'],
    ]);
    expect(calls[0].headers['X-Auth-Token']).toBe('yuque-token');
    expect(calls[0].body).toEqual({
      title: '操作系统 · P2 进程管理',
      body: '# 课程笔记\n\n内容',
      format: 'markdown',
      public: 0,
    });
    expect(calls[1].body).toMatchObject({
      action: 'appendNode',
      action_mode: 'child',
      type: 'DOC',
      doc_id: 123,
    });
    expect(JSON.parse(result.externalId)).toEqual({
      v: 1,
      docId: 123,
      repoId: '42',
      host: 'https://www.yuque.com',
      title: '操作系统 · P2 进程管理',
    });
    expect(result.externalUrl).toBe('https://www.yuque.com/alice/course/doc');
  });

  it('后续同步用 YFM API 全量覆盖；标题变化另走 metadata API', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method: init?.method ?? 'GET', body });
      return json({ data: { id: 123 } });
    }) as typeof fetch;
    const connector = createYuqueConnector(profile(), { fetchImpl });
    const externalId = JSON.stringify({
      v: 1,
      docId: 123,
      repoId: '42',
      host: 'https://www.yuque.com',
      title: '旧标题',
    });

    const result = await connector.upsertCourseNote({
      courseTitle: '新标题',
      contentMd: '# 改写后的完整内容',
      externalId,
    });

    expect(calls).toEqual([
      {
        path: '/api/v2/yfm/docs',
        method: 'PUT',
        body: { doc_id: 123, yfm: '# 改写后的完整内容' },
      },
      {
        path: '/api/v2/repos/42/docs/123',
        method: 'PUT',
        body: { title: '新标题' },
      },
    ]);
    expect(JSON.parse(result.externalId).title).toBe('新标题');
  });

  it('目标知识库变化时在新目标创建，不更新旧文档', async () => {
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return path.endsWith('/docs') ? json({ data: { id: 456 } }) : json({ data: [] });
    }) as typeof fetch;
    const connector = createYuqueConnector(profile({ repoId: '99', repoName: '新库' }), {
      fetchImpl,
    });

    const result = await connector.upsertCourseNote({
      courseTitle: '课程',
      contentMd: '内容',
      externalId: JSON.stringify({
        v: 1,
        docId: 123,
        repoId: '42',
        host: 'https://www.yuque.com',
        title: '课程',
      }),
    });

    expect(paths).toEqual(['/api/v2/repos/99/docs', '/api/v2/repos/99/toc']);
    expect(JSON.parse(result.externalId)).toMatchObject({ docId: 456, repoId: '99' });
  });

  it('TOC 追加失败不把已创建文档判失败，避免重试时重复创建', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/docs')
        ? json({ data: { id: 123 } })
        : json({ message: 'toc denied' }, 403);
    }) as typeof fetch;

    await expect(
      createYuqueConnector(profile(), { fetchImpl }).upsertCourseNote({
        courseTitle: '课程',
        contentMd: '内容',
      }),
    ).resolves.toMatchObject({ externalId: expect.stringContaining('"docId":123') });
  });

  it('鉴权错误不泄露 Token', async () => {
    const fetchImpl = (async () => json({ message: 'yuque-token invalid' }, 401)) as typeof fetch;
    const result = await createYuqueConnector(profile(), { fetchImpl }).testConnection();
    expect(result).toEqual({
      ok: false,
      detail: '语雀 OpenAPI 鉴权失败，请检查 API Token、空间 Host 与知识库权限',
    });
    expect(JSON.stringify(result)).not.toContain('yuque-token');
  });
});
