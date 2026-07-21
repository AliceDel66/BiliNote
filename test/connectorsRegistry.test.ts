// Connector Profile 注册表：CRUD / 默认写入切换 / 旧版 NotionConfig 一次性迁移
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

vi.mock('wxt/browser', async () => (await import('./mockBrowser')).createBrowserMock());

import {
  buildConnector,
  getActiveConnectorProfile,
  getActiveConnectorProfileId,
  listConnectorProfiles,
  removeConnectorProfile,
  saveConnectorProfile,
  setActiveConnectorProfileId,
  updateConnectorProfile,
} from '../lib/connectors/registry';

function mcpInput(name = '自定义 MCP') {
  return {
    kind: 'custom-mcp' as const,
    name,
    status: 'custom' as const,
    config: { endpoint: 'https://mcp.example.com' },
  };
}

beforeEach(async () => {
  await browser.storage.local.clear();
  await browser.storage.sync.clear();
});

describe('registry CRUD', () => {
  it('新增 / 列表 / 更新 / 移除', async () => {
    const p1 = await saveConnectorProfile(mcpInput('A'));
    const p2 = await saveConnectorProfile(mcpInput('B'));
    expect((await listConnectorProfiles()).map((p) => p.name)).toEqual(['A', 'B']);
    expect(p1.id).not.toBe(p2.id);
    expect(p1.createdAt).toBeGreaterThan(0);

    await updateConnectorProfile(p1.id, { name: 'A2', config: { endpoint: 'https://x.com', lastTest: { ok: true, detail: 'd' } } });
    const after = (await listConnectorProfiles()).find((p) => p.id === p1.id);
    expect(after?.name).toBe('A2');
    expect((after?.config.lastTest as { ok: boolean }).ok).toBe(true);

    await removeConnectorProfile(p1.id);
    expect((await listConnectorProfiles()).map((p) => p.name)).toEqual(['B']);
  });

  it('带 id 的 save 走更新分支；id 不存在时报错', async () => {
    const p = await saveConnectorProfile(mcpInput('A'));
    const updated = await saveConnectorProfile({ ...mcpInput('A3'), id: p.id });
    expect(updated.id).toBe(p.id);
    expect((await listConnectorProfiles())).toHaveLength(1);
    await expect(saveConnectorProfile({ ...mcpInput(), id: 'missing' })).rejects.toThrow(
      /不存在/,
    );
  });
});

describe('默认写入目标（active）', () => {
  it('首个 profile 自动成为默认；显式切换生效', async () => {
    const p1 = await saveConnectorProfile(mcpInput('A'));
    expect(await getActiveConnectorProfileId()).toBe(p1.id);
    const p2 = await saveConnectorProfile(mcpInput('B'));
    expect(await getActiveConnectorProfileId()).toBe(p1.id); // 不被新 profile 顶掉

    await setActiveConnectorProfileId(p2.id);
    const active = await getActiveConnectorProfile();
    expect(active?.id).toBe(p2.id);
  });

  it('移除默认 profile 后回退到剩余第一个', async () => {
    const p1 = await saveConnectorProfile(mcpInput('A'));
    const p2 = await saveConnectorProfile(mcpInput('B'));
    await removeConnectorProfile(p1.id);
    expect(await getActiveConnectorProfileId()).toBe(p2.id);
    await removeConnectorProfile(p2.id);
    expect(await getActiveConnectorProfile()).toBeNull();
  });
});

describe('旧版 NotionConfig 迁移', () => {
  it('已有 NotionConfig 且无 profile → 自动生成 notion profile（引用不复制 token）', async () => {
    await browser.storage.local.set({
      notionConfig: { token: 'ntn_secret', botName: 'bot', rootPageId: 'root-1' },
    });
    const profiles = await listConnectorProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].kind).toBe('notion');
    expect(profiles[0].status).toBe('stable');
    expect(profiles[0].config).toEqual({ binding: 'notionConfig' });
    expect(JSON.stringify(profiles[0].config)).not.toContain('ntn_secret');
    // 迁移产物自动成为默认写入目标
    expect(await getActiveConnectorProfileId()).toBe(profiles[0].id);
  });

  it('迁移只发生一次：删除 notion profile 不会被复活', async () => {
    await browser.storage.local.set({ notionConfig: { token: 'ntn_secret' } });
    const [p] = await listConnectorProfiles();
    await removeConnectorProfile(p.id);
    expect(await listConnectorProfiles()).toEqual([]);
  });

  it('无 NotionConfig 时不产生任何 profile', async () => {
    expect(await listConnectorProfiles()).toEqual([]);
    expect(await getActiveConnectorProfile()).toBeNull();
  });
});

describe('V2 迁移：存量腾讯文档 profile 补官方端点 + raw 鉴权', () => {
  const OFFICIAL = 'https://docs.qq.com/openapi/mcp';

  async function seed(profiles: Record<string, unknown>[]) {
    await browser.storage.local.set({
      connectorProfiles: profiles,
      connectorMigrationDone: true, // 跳过 V1（本组用例与 NotionConfig 无关）
    });
  }

  it('endpoint 为空 → 补官方 URL；缺 authScheme → 补 raw', async () => {
    await seed([
      {
        id: 't1',
        kind: 'remote-mcp',
        name: '腾讯文档（Beta）',
        status: 'beta',
        config: { endpoint: '', token: 'tok-x' },
        createdAt: 1,
      },
    ]);
    const [p] = await listConnectorProfiles();
    expect(p.config.endpoint).toBe(OFFICIAL);
    expect(p.config.authScheme).toBe('raw');
    expect(p.config.token).toBe('tok-x'); // 凭据原样保留
  });

  it('已填写的字段不覆盖（用户自定义端点 / 飞书 none 保持原样）', async () => {
    await seed([
      {
        id: 't2',
        kind: 'remote-mcp',
        name: '腾讯文档',
        status: 'beta',
        config: { endpoint: 'https://custom.example.com/mcp', token: 'a' },
        createdAt: 1,
      },
      {
        id: 'f1',
        kind: 'remote-mcp',
        name: '飞书文档（Beta）',
        status: 'beta',
        config: { endpoint: 'https://open.feishu.cn/mcp/stream/mcp_abc', authScheme: 'none' },
        createdAt: 2,
      },
      {
        id: 'c1',
        kind: 'custom-mcp',
        name: '自定义',
        status: 'custom',
        config: { endpoint: 'https://mcp.example.com' },
        createdAt: 3,
      },
    ]);
    const profiles = await listConnectorProfiles();
    expect(profiles[0].config.endpoint).toBe('https://custom.example.com/mcp');
    expect(profiles[0].config.authScheme).toBe('raw'); // 旧腾讯 profile 只补缺的 authScheme
    expect(profiles[1].config).toEqual({
      endpoint: 'https://open.feishu.cn/mcp/stream/mcp_abc',
      authScheme: 'none',
    });
    expect(profiles[2].config).toEqual({ endpoint: 'https://mcp.example.com' }); // custom-mcp 不动
  });

  it('幂等：迁移只跑一次，之后用户对配置的修改不被回改', async () => {
    await seed([
      {
        id: 't1',
        kind: 'remote-mcp',
        name: '腾讯文档（Beta）',
        status: 'beta',
        config: {},
        createdAt: 1,
      },
    ]);
    const [migrated] = await listConnectorProfiles();
    expect(migrated.config.endpoint).toBe(OFFICIAL);
    // 用户随后改了自己的端点与 scheme
    await updateConnectorProfile(migrated.id, {
      config: { endpoint: 'https://custom.example.com/mcp', authScheme: 'bearer' },
    });
    const again = await listConnectorProfiles();
    expect(again[0].config.endpoint).toBe('https://custom.example.com/mcp');
    expect(again[0].config.authScheme).toBe('bearer');
    // 再次调用结果稳定（flag 已置位，不重跑）
    const third = await listConnectorProfiles();
    expect(third[0].config).toEqual(again[0].config);
  });
});

describe('401 鉴权兜底：默认持久化经 registry 真实写回', () => {
  it('raw profile 遇 401 自动切 bearer，写回 storage 且不覆盖 config 其他键', async () => {
    const p = await saveConnectorProfile({
      kind: 'remote-mcp',
      name: '腾讯文档（Beta）',
      status: 'beta',
      config: {
        endpoint: 'https://docs.qq.com/openapi/mcp',
        token: 'tk',
        authScheme: 'raw',
        lastTest: { ok: false, detail: '旧测试结果' },
      },
    });
    // 裸值 401、Bearer 放行的 mock 端点
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      const body = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (headers.Authorization === 'tk') return new Response('x', { status: 401 });
      const result =
        body.method === 'initialize' ? { serverInfo: { name: 'srv' } } : { tools: [] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    // 不注入 persistAuthScheme → 走默认 registry 写回路径
    const conn = buildConnector(p, { fetchImpl });
    const result = await conn.testConnection();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('已自动切换为 Bearer 鉴权');

    const after = (await listConnectorProfiles()).find((x) => x.id === p.id);
    expect(after?.config.authScheme).toBe('bearer');
    expect(after?.config.token).toBe('tk'); // 其余 config 键原样保留
    expect(after?.config.lastTest).toEqual({ ok: false, detail: '旧测试结果' });
  });
});
