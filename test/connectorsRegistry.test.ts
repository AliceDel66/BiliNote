// Connector Profile 注册表：CRUD / 默认写入切换 / 旧版 NotionConfig 一次性迁移
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

vi.mock('wxt/browser', async () => (await import('./mockBrowser')).createBrowserMock());

import {
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
