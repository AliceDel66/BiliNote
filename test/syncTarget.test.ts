// 同步路由：notion 委托既有整页同步；bridge 写 connectorSync 表；统一状态查询
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

vi.mock('wxt/browser', async () => (await import('./mockBrowser')).createBrowserMock());

import {
  db,
  getConnectorSync,
  saveNotionMapping,
  type NotionMappingRow,
} from '../lib/storage';
import {
  saveConnectorProfile,
  setActiveConnectorProfileId,
} from '../lib/connectors/registry';
import { getTargetSyncRow, syncNoteToTarget } from '../lib/connectors/syncTarget';

const NOTE_ID = 1;

async function seedNote() {
  await db.notes.put({
    id: NOTE_ID,
    bvid: 'BV1x',
    cid: 2,
    title: '操作系统课程 · P2 进程管理',
    contentMd: '# 笔记内容',
    template: 'blank',
    source: 'ai',
    dirty: true,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await db.videos.put({
    bvid: 'BV1x',
    aid: 1,
    title: '操作系统课程',
    cover: '',
    owner: 'up主',
    duration: 100,
    parts: [
      { cid: 1, page: 1, part: '导论', duration: 50 },
      { cid: 2, page: 2, part: '进程管理', duration: 50 },
    ],
    firstSeenAt: 1,
    lastViewedAt: 1,
  });
}

async function seedBridgeProfile() {
  const p = await saveConnectorProfile({
    kind: 'local-bridge',
    name: '本地 Markdown 库',
    status: 'stable',
    config: { port: 27183, token: 'tok' },
  });
  await setActiveConnectorProfileId(p.id);
  return p;
}

function bridgeFetchOk() {
  const calls: { path: string; body: { path: string; content: string } }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      path: new URL(String(url)).pathname,
      body: JSON.parse(String(init?.body)) as { path: string; content: string },
    });
    return new Response(JSON.stringify({ path: 'p', mode: 'created' }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

beforeEach(async () => {
  await browser.storage.local.clear();
  await browser.storage.sync.clear();
  await db.notes.clear();
  await db.videos.clear();
  await db.connectorSync.clear();
  await db.notionMappings.clear();
});

describe('syncNoteToTarget 路由', () => {
  it('未配置任何连接 → 抛错提示', async () => {
    await seedNote();
    await expect(syncNoteToTarget(NOTE_ID)).rejects.toThrow(/配置知识库连接/);
  });

  it('notion profile → 委托既有 syncNoteToNotion 路径（不写 connectorSync 表）', async () => {
    await seedNote();
    const notionProfile = await saveConnectorProfile({
      kind: 'notion',
      name: 'Notion（官方预设）',
      status: 'stable',
      config: { binding: 'notionConfig' },
    });
    const notionSync = vi.fn(
      async (noteId: number, force?: boolean): Promise<NotionMappingRow> => ({
        noteId,
        coursePageId: 'cp',
        chapterPageId: 'ch',
        lastSyncedAt: force ? 200 : 100,
        notionLastEditedTime: '2026-07-21T00:00:00.000Z',
        syncStatus: 'synced',
      }),
    );
    const row = await syncNoteToTarget(NOTE_ID, { deps: { notionSync } });
    expect(notionSync).toHaveBeenCalledWith(NOTE_ID, undefined);
    expect(row.syncStatus).toBe('synced');
    expect(row.connectorId).toBe(notionProfile.id);
    expect(row.notionLastEditedTime).toBe('2026-07-21T00:00:00.000Z');

    await syncNoteToTarget(NOTE_ID, { force: true, deps: { notionSync } });
    expect(notionSync).toHaveBeenLastCalledWith(NOTE_ID, true);
    expect(await db.connectorSync.count()).toBe(0);
  });

  it('bridge profile → create 写入并落 connectorSync 行，笔记 dirty 清除', async () => {
    await seedNote();
    const bridge = await seedBridgeProfile();
    const { calls, fetchImpl } = bridgeFetchOk();

    const row = await syncNoteToTarget(NOTE_ID, {
      deps: { connectorDeps: { fetchImpl } },
    });
    expect(row.syncStatus).toBe('synced');
    expect(row.connectorId).toBe(bridge.id);
    expect(calls[0].path).toBe('/v1/create');
    expect(calls[0].body.path).toBe('BiliNote/操作系统课程/P2 进程管理.md');
    expect(calls[0].body.content).toBe('# 笔记内容');

    const persisted = await getConnectorSync(NOTE_ID, bridge.id);
    expect(persisted?.syncStatus).toBe('synced');
    expect(persisted?.externalId).toBe('BiliNote/操作系统课程/P2 进程管理.md');
    expect(persisted?.lastSyncedAt).toBeGreaterThan(0);
    expect((await db.notes.get(NOTE_ID))?.dirty).toBe(false);
  });

  it('bridge 二次同步 → 走 /v1/append（沿用上次的 externalId）', async () => {
    await seedNote();
    await seedBridgeProfile();
    const { calls, fetchImpl } = bridgeFetchOk();
    const deps = { connectorDeps: { fetchImpl } };
    await syncNoteToTarget(NOTE_ID, { deps });
    await syncNoteToTarget(NOTE_ID, { deps });
    expect(calls.map((c) => c.path)).toEqual(['/v1/create', '/v1/append']);
    expect(calls[1].body.path).toBe('BiliNote/操作系统课程/P2 进程管理.md');
  });

  it('bridge 失败 → connectorSync 落 error 行（不抛异常）', async () => {
    await seedNote();
    const bridge = await seedBridgeProfile();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'disk full' }), { status: 500 })) as typeof fetch;
    const row = await syncNoteToTarget(NOTE_ID, {
      deps: { connectorDeps: { fetchImpl } },
    });
    expect(row.syncStatus).toBe('error');
    expect(row.error).toContain('disk full');
    const persisted = await getConnectorSync(NOTE_ID, bridge.id);
    expect(persisted?.syncStatus).toBe('error');
  });
});

describe('getTargetSyncRow 统一状态查询', () => {
  it('notion → 读 notionMappings；其他 → 读 connectorSync', async () => {
    await seedNote();
    const notionProfile = await saveConnectorProfile({
      kind: 'notion',
      name: 'Notion',
      status: 'stable',
      config: { binding: 'notionConfig' },
    });
    await saveNotionMapping({
      noteId: NOTE_ID,
      lastSyncedAt: 42,
      notionLastEditedTime: 't',
      syncStatus: 'conflict',
      error: '冲突提示',
    });
    const notionRow = await getTargetSyncRow(NOTE_ID);
    expect(notionRow?.syncStatus).toBe('conflict');
    expect(notionRow?.connectorId).toBe(notionProfile.id);

    const bridge = await saveConnectorProfile({
      kind: 'local-bridge',
      name: 'bridge',
      status: 'stable',
      config: { port: 1, token: 't' },
    });
    await setActiveConnectorProfileId(bridge.id);
    const { fetchImpl } = bridgeFetchOk();
    await syncNoteToTarget(NOTE_ID, { deps: { connectorDeps: { fetchImpl } } });
    const bridgeRow = await getTargetSyncRow(NOTE_ID);
    expect(bridgeRow?.syncStatus).toBe('synced');
    expect(bridgeRow?.connectorId).toBe(bridge.id);
    expect(bridgeRow?.notionLastEditedTime).toBe('');
  });

  it('无记录 → null', async () => {
    await seedNote();
    await seedBridgeProfile();
    expect(await getTargetSyncRow(NOTE_ID)).toBeNull();
  });
});
