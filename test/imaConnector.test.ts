// ima OpenAPI connector：鉴权头 / 可写知识库 / 首次建档 / 幂等与 append-only 保护
import { describe, expect, it } from 'vitest';
import {
  createImaConnector,
  listImaKnowledgeBases,
  type ConnectorProfile,
} from '../lib/connectors';

function profile(overrides?: Partial<ConnectorProfile['config']>): ConnectorProfile {
  return {
    id: 'ima-1',
    kind: 'ima',
    name: 'ima 知识库',
    status: 'beta',
    config: {
      clientId: 'client-id',
      apiKey: 'api-key',
      knowledgeBaseId: 'kb-1',
      knowledgeBaseName: '课程库',
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

describe('listImaKnowledgeBases', () => {
  it('使用官方双 Header 鉴权并按 cursor 拉取全部可写知识库', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body,
      });
      return body.cursor === ''
        ? json({
            retcode: 0,
            data: {
              addable_knowledge_base_list: [{ id: 'kb-1', name: '课程库' }],
              next_cursor: 'next',
              is_end: false,
            },
          })
        : json({
            retcode: 0,
            data: {
              addable_knowledge_base_list: [{ id: 'kb-2', name: '资料库' }],
              next_cursor: '',
              is_end: true,
            },
          });
    }) as typeof fetch;

    await expect(
      listImaKnowledgeBases(
        { clientId: ' client-id ', apiKey: ' api-key ' },
        { fetchImpl },
      ),
    ).resolves.toEqual([
      { id: 'kb-1', name: '课程库' },
      { id: 'kb-2', name: '资料库' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(
      'https://ima.qq.com/openapi/wiki/v1/get_addable_knowledge_base_list',
    );
    expect(calls[0].headers['ima-openapi-clientid']).toBe('client-id');
    expect(calls[0].headers['ima-openapi-apikey']).toBe('api-key');
    expect(calls[1].body.cursor).toBe('next');
  });
});

describe('createImaConnector', () => {
  it('连接测试确认所选知识库仍可写', async () => {
    const fetchImpl = (async () =>
      json({
        retcode: 0,
        data: {
          addable_knowledge_base_list: [{ id: 'kb-1', name: '课程库' }],
          is_end: true,
        },
      })) as typeof fetch;
    await expect(createImaConnector(profile(), { fetchImpl }).testConnection()).resolves.toEqual({
      ok: true,
      detail: '已连接 ima，可写入「课程库」',
    });
  });

  it('首次同步先 import_doc，再把笔记加入所选知识库', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('/import_doc')) return json({ retcode: 0, data: { doc_id: 'doc-1' } });
      return json({ retcode: 0, data: { media_id: 'media-1' } });
    }) as typeof fetch;
    const connector = createImaConnector(profile(), { fetchImpl });

    const result = await connector.upsertCourseNote({
      courseTitle: '操作系统',
      partLabel: 'P2 进程管理',
      contentMd: '# 课程笔记\n\n内容',
    });

    expect(calls.map((call) => call.path)).toEqual([
      '/openapi/note/v1/import_doc',
      '/openapi/wiki/v1/add_knowledge',
    ]);
    expect(calls[0].body).toEqual({ content_format: 1, content: '# 课程笔记\n\n内容' });
    expect(calls[1].body).toEqual({
      media_type: 11,
      title: '操作系统 · P2 进程管理',
      knowledge_base_id: 'kb-1',
      note_info: { content_id: 'doc-1' },
    });
    expect(JSON.parse(result.externalId)).toMatchObject({
      v: 1,
      docId: 'doc-1',
      knowledgeBaseId: 'kb-1',
      contentLength: '# 课程笔记\n\n内容'.length,
    });
  });

  it('内容未变化时不发写请求；纯尾部新增只 append 差量', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      if (path.endsWith('/import_doc')) return json({ retcode: 0, data: { doc_id: 'doc-1' } });
      if (path.endsWith('/append_doc')) return json({ retcode: 0, data: { doc_id: 'doc-1' } });
      return json({ retcode: 0, data: { media_id: 'media-1' } });
    }) as typeof fetch;
    const connector = createImaConnector(profile(), { fetchImpl });
    const base = '# 笔记';
    const first = await connector.upsertCourseNote({ courseTitle: '课', contentMd: base });
    calls.length = 0;

    const unchanged = await connector.upsertCourseNote({
      courseTitle: '课',
      contentMd: base,
      externalId: first.externalId,
    });
    expect(calls).toEqual([]);

    await connector.upsertCourseNote({
      courseTitle: '课',
      contentMd: `${base}\n\n新增`,
      externalId: unchanged.externalId,
    });
    expect(calls).toEqual([
      {
        path: '/openapi/note/v1/append_doc',
        body: { doc_id: 'doc-1', content_format: 1, content: '\n\n新增' },
      },
    ]);
  });

  it('已同步前缀被改写时拒绝写入，避免重复或静默丢改动', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/import_doc')) return json({ retcode: 0, data: { doc_id: 'doc-1' } });
      return json({ retcode: 0, data: { media_id: 'media-1' } });
    }) as typeof fetch;
    const connector = createImaConnector(profile(), { fetchImpl });
    const first = await connector.upsertCourseNote({ courseTitle: '课', contentMd: '原内容' });

    await expect(
      connector.upsertCourseNote({
        courseTitle: '课',
        contentMd: '改写内容',
        externalId: first.externalId,
      }),
    ).rejects.toThrow(/暂不支持整篇覆盖/);
  });

  it('API 鉴权错误不泄露凭据', async () => {
    const fetchImpl = (async () =>
      json({ retcode: 20004, errmsg: 'apiKey invalid', data: {} })) as typeof fetch;
    const result = await createImaConnector(profile(), { fetchImpl }).testConnection();
    expect(result).toEqual({
      ok: false,
      detail: 'ima OpenAPI 鉴权失败，请检查 Client ID 与 API Key 是否有效',
    });
    expect(JSON.stringify(result)).not.toContain('api-key');
    expect(JSON.stringify(result)).not.toContain('client-id');
  });
});
