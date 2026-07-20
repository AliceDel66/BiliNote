import { describe, expect, it } from 'vitest';
import {
  syncNoteToNotion,
  type NotionClient,
  type SyncStorage,
} from '../lib/notion';
import type { NoteRow, NotionMappingRow } from '../lib/storage';

// ---------- 内存存储 ----------

function memStorage() {
  const notes = new Map<number, NoteRow>();
  const mappings = new Map<number, NotionMappingRow>();
  const videos = new Map<string, { title: string; pages: { cid: number; part: string }[] }>();
  const storage: SyncStorage = {
    getNote: async (id) => notes.get(id),
    getVideo: async (bvid) => videos.get(bvid),
    getMapping: async (id) => mappings.get(id),
    saveMapping: async (row) => {
      mappings.set(row.noteId, { ...row });
    },
    findCoursePageId: async (bvid) => {
      for (const n of notes.values()) {
        if (n.bvid === bvid) {
          const m = mappings.get(n.id!);
          if (m?.coursePageId) return m.coursePageId;
        }
      }
      return undefined;
    },
    markNoteClean: async (id) => {
      const n = notes.get(id);
      if (n) notes.set(id, { ...n, dirty: false });
    },
  };
  return { notes, mappings, videos, storage };
}

function makeNote(patch: Partial<NoteRow>): NoteRow {
  return {
    id: 1,
    bvid: 'BV1test',
    cid: 2,
    title: '操作系统课程 · P2 进程管理',
    contentMd: '## 课程大纲\n\n- 12:35 进程与线程\n',
    template: 'blank',
    source: 'ai',
    dirty: true,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

// ---------- mock NotionClient ----------

function mockClient(opts?: { editedTime?: string }) {
  const calls = {
    createPage: [] as { parentPageId: string; title: string }[],
    archive: [] as string[],
    append: [] as { pageId: string; count: number }[],
  };
  let seq = 0;
  const client: NotionClient = {
    validateToken: async () => ({ id: 'u', botName: 'bot' }),
    searchPages: async () => [],
    getPage: async (id) => ({
      id,
      lastEditedTime: opts?.editedTime ?? new Date(0).toISOString(),
    }),
    createPage: async ({ parentPageId, title }) => {
      calls.createPage.push({ parentPageId, title });
      return { id: `page-${++seq}` };
    },
    listChildren: async () => [{ id: 'old-1' }, { id: 'old-2' }],
    archiveBlock: async (id) => {
      calls.archive.push(id);
    },
    appendBlocks: async (pageId, blocks) => {
      calls.append.push({ pageId, count: blocks.length });
    },
  };
  return { client, calls };
}

const iso = (t: number) => new Date(t).toISOString();

describe('syncNoteToNotion 页面树同步', () => {
  it('首次同步（多 P）：建课程页 + 章节页，内容写入章节页', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({}));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage).toEqual([
      { parentPageId: 'root-1', title: '操作系统课程' },
      { parentPageId: 'page-1', title: 'P2 进程管理' },
    ]);
    // 内容写在章节页（page-2）下
    expect(calls.append).toEqual([{ pageId: 'page-2', count: 2 }]);
    expect(row.coursePageId).toBe('page-1');
    expect(row.chapterPageId).toBe('page-2');
    expect(row.lastSyncedAt).toBeGreaterThan(0);
    expect(m.notes.get(1)?.dirty).toBe(false);
  });

  it('首次同步（单 P）：不建章节页，内容直接写课程页', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ cid: 1 }));
    m.videos.set('BV1test', {
      title: '单P视频',
      pages: [{ cid: 1, part: '完整视频' }],
    });
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage).toEqual([{ parentPageId: 'root-1', title: '单P视频' }]);
    expect(calls.append[0].pageId).toBe('page-1');
    expect(row.chapterPageId).toBeUndefined();
  });

  it('再次同步：整页替换（先归档旧块再追加），不重建页面', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, {
      noteId: 1,
      coursePageId: 'course-1',
      chapterPageId: 'chap-1',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'synced',
    });
    // 远端停留在上次同步时的状态（4000 < lastSyncedAt 5000）→ 不冲突
    const { client, calls } = mockClient({ editedTime: iso(4000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage).toEqual([]);
    expect(calls.archive).toEqual(['old-1', 'old-2']);
    expect(calls.append).toEqual([{ pageId: 'chap-1', count: 2 }]);
  });

  it('冲突：远端与本地都在上次同步后改过 → conflict，不写任何内容', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, {
      noteId: 1,
      coursePageId: 'course-1',
      chapterPageId: 'chap-1',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'synced',
    });
    // 远端 7000 > lastSyncedAt 5000，本地 updatedAt 6000 > 5000 → 双方都改过
    const { client, calls } = mockClient({ editedTime: iso(7000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('conflict');
    expect(row.error).toContain('冲突');
    expect(calls.archive).toEqual([]);
    expect(calls.append).toEqual([]);
  });

  it('force:true 强制覆盖冲突', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, {
      noteId: 1,
      coursePageId: 'course-1',
      chapterPageId: 'chap-1',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'conflict',
    });
    const { client, calls } = mockClient({ editedTime: iso(7000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      force: true,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.archive).toEqual(['old-1', 'old-2']);
    expect(calls.append).toHaveLength(1);
  });

  it('仅远端改过（本地未动）不算冲突，按本地内容覆盖', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 4500 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, {
      noteId: 1,
      coursePageId: 'course-1',
      chapterPageId: 'chap-1',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'synced',
    });
    const { client, calls } = mockClient({ editedTime: iso(7000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.append).toHaveLength(1);
  });

  it('接口错误 → status=error 并记录中文错误', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({}));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [{ cid: 2, part: 'P2 进程管理' }],
    });
    const { client } = mockClient();
    client.createPage = async () => {
      throw new Error('boom');
    };

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('error');
    expect(row.error).toBe('boom');
  });

  it('同视频第二份笔记复用已有课程页', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({}));
    m.notes.set(2, makeNote({ id: 2, cid: 1, title: '操作系统课程 · P1 导论' }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, {
      noteId: 1,
      coursePageId: 'course-existing',
      chapterPageId: 'chap-1',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'synced',
    });
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 2,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(row.coursePageId).toBe('course-existing');
    // 只建了章节页（复用课程页）
    expect(calls.createPage).toEqual([
      { parentPageId: 'course-existing', title: 'P1 导论' },
    ]);
  });
});
