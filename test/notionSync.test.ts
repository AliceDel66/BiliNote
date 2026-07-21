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
  const videos = new Map<
    string,
    { title: string; pages: { cid: number; page?: number; part: string }[] }
  >();
  const storage: SyncStorage = {
    getNote: async (id) => notes.get(id),
    getVideo: async (bvid) => videos.get(bvid),
    getMapping: async (id) => mappings.get(id),
    saveMapping: async (row) => {
      mappings.set(row.noteId, { ...row });
    },
    findCoursePageId: async (bvid, scope) => {
      for (const n of notes.values()) {
        if (n.bvid === bvid) {
          const m = mappings.get(n.id!);
          if (!m?.coursePageId) continue;
          if (m.rootPageId !== scope.rootPageId) continue;
          if (scope.botId && m.botId && m.botId !== scope.botId) continue;
          return m.coursePageId;
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
    rev: 1,
    createdAt: 100,
    updatedAt: 100,
    ...patch,
  };
}

/** 造一条与当前根页面同 scope 的已同步映射（rootPageId 缺省 = root-1） */
function syncedMapping(patch: Partial<NotionMappingRow>): NotionMappingRow {
  return {
    noteId: 1,
    coursePageId: 'course-1',
    chapterPageId: 'chap-1',
    rootPageId: 'root-1',
    lastSyncedAt: 5000,
    notionLastEditedTime: iso(4000),
    syncStatus: 'synced',
    ...patch,
  };
}

// ---------- mock NotionClient ----------

function mockClient(opts?: { editedTime?: string; titles?: Record<string, string> }) {
  const calls = {
    createPage: [] as { parentPageId: string; title: string }[],
    listChildren: [] as string[],
    archive: [] as string[],
    append: [] as { pageId: string; count: number }[],
    updatePageTitle: [] as { pageId: string; title: string }[],
  };
  let seq = 0;
  const client: NotionClient = {
    validateToken: async () => ({ id: 'u', botName: 'bot' }),
    searchPages: async () => [],
    getPage: async (id) => ({
      id,
      title: opts?.titles?.[id] ?? '',
      lastEditedTime: opts?.editedTime ?? new Date(0).toISOString(),
    }),
    createPage: async ({ parentPageId, title }) => {
      calls.createPage.push({ parentPageId, title });
      return { id: `page-${++seq}` };
    },
    updatePageTitle: async (pageId, title) => {
      calls.updatePageTitle.push({ pageId, title });
    },
    listChildren: async (pageId) => {
      calls.listChildren.push(pageId);
      return [{ id: 'old-1' }, { id: 'old-2' }];
    },
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

function seedOsCourse(m: ReturnType<typeof memStorage>) {
  m.notes.set(1, makeNote({}));
  m.videos.set('BV1test', {
    title: '操作系统课程',
    pages: [
      { cid: 1, part: 'P1 导论' },
      { cid: 2, part: 'P2 进程管理' },
    ],
  });
}

describe('syncNoteToNotion 页面树同步', () => {
  it('首次同步（多 P）：建课程页 + 章节页，内容写入章节页，映射记录 scope', async () => {
    const m = memStorage();
    seedOsCourse(m);
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
    expect(row.rootPageId).toBe('root-1');
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
    m.mappings.set(1, syncedMapping({}));
    // 远端与持久化基线一致（== notionLastEditedTime）→ 远端未改 → 不冲突
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
    // 同步成功后基线刷新为最新 last_edited_time
    expect(row.notionLastEditedTime).toBe(iso(4000));
  });

  it('冲突：远端自基线后被编辑 且 本地在上次同步后改过 → conflict，不写任何内容', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, syncedMapping({}));
    // 远端 last_edited_time != 基线 iso(4000)（远端被改），本地 updatedAt 6000 > lastSyncedAt 5000 → 双方都改过
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
    // 冲突时不写任何内容，包括页面改名
    expect(calls.updatePageTitle).toEqual([]);
  });

  it('时钟偏差不误判：远端时间晚于本地 lastSyncedAt 但等于基线 → 不冲突（P1.4 基线语义）', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    // Notion 服务端时钟远快于本地：基线 iso(90000) > 本地 lastSyncedAt 5000。
    // 旧规则（远端时间 > lastSyncedAt 且本地改过）会误判冲突；基线语义下远端未变 → 不冲突
    m.mappings.set(1, syncedMapping({ notionLastEditedTime: iso(90000) }));
    const { client, calls } = mockClient({ editedTime: iso(90000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.append).toEqual([{ pageId: 'chap-1', count: 2 }]);
  });

  it('远端时间早于基线但不等于基线（远端被重建/回滚）+ 本地 dirty → conflict', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 6000 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, syncedMapping({ notionLastEditedTime: iso(9000) }));
    // 远端 iso(3000) != 基线 iso(9000)：早于基线也算「远端变过」，本地 6000 > 5000 → 冲突
    const { client } = mockClient({ editedTime: iso(3000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('conflict');
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
    m.mappings.set(1, syncedMapping({ syncStatus: 'conflict' }));
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
    m.mappings.set(1, syncedMapping({}));
    // 远端 != 基线（远端被改），但本地 updatedAt 4500 < lastSyncedAt 5000（本地未动）→ 不冲突
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

  it('同视频第二份笔记复用已有课程页（同 scope）', async () => {
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
    m.mappings.set(1, syncedMapping({ coursePageId: 'course-existing' }));
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

  it('章节页命名：带分 P 号时用「P{n} · 标题」，首次同步不调 updatePageTitle', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({}));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, page: 1, part: '导论' },
        { cid: 2, page: 2, part: '进程管理' },
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
      { parentPageId: 'page-1', title: 'P2 · 进程管理' },
    ]);
    // 首次同步：页面刚按期望标题建好，无需改名
    expect(calls.updatePageTitle).toEqual([]);
  });

  it('存量 reconcile：复用页面标题与期望不一致 → updatePageTitle 改名', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 4500 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, page: 1, part: '导论' },
        { cid: 2, page: 2, part: 'slice' },
      ],
    });
    m.mappings.set(1, syncedMapping({}));
    // 远端章节页仍是旧命名（裸分 P 标题）；课程页标题已一致
    const { client, calls } = mockClient({
      editedTime: iso(4000),
      titles: { 'course-1': '操作系统课程', 'chap-1': 'slice' },
    });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage).toEqual([]);
    expect(calls.updatePageTitle).toEqual([{ pageId: 'chap-1', title: 'P2 · slice' }]);
  });

  it('存量 reconcile：标题已一致 → 不调 updatePageTitle', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 4500 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, page: 1, part: '导论' },
        { cid: 2, page: 2, part: '进程管理' },
      ],
    });
    m.mappings.set(1, syncedMapping({}));
    const { client, calls } = mockClient({
      editedTime: iso(4000),
      titles: { 'course-1': '操作系统课程', 'chap-1': 'P2 · 进程管理' },
    });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.updatePageTitle).toEqual([]);
    // 内容照常整页替换
    expect(calls.append).toEqual([{ pageId: 'chap-1', count: 2 }]);
  });
});

describe('syncNoteToNotion 映射 scope（C4）', () => {
  it('切换同步根页面 → 在新根下重建页面树，旧根内容不动，映射写新 scope', async () => {
    const m = memStorage();
    seedOsCourse(m);
    // 旧映射属于 root-old（含已同步基线），当前配置切到 root-new
    m.mappings.set(
      1,
      syncedMapping({ rootPageId: 'root-old', coursePageId: 'old-course', chapterPageId: 'old-chap' }),
    );
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-new',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    // 新根下重建课程页 + 章节页
    expect(calls.createPage).toEqual([
      { parentPageId: 'root-new', title: '操作系统课程' },
      { parentPageId: 'page-1', title: 'P2 进程管理' },
    ]);
    // 旧页面树（old-course/old-chap）零接触：不读子块、不追加、不改名
    expect(calls.listChildren).toEqual(['page-2']);
    expect(calls.append).toEqual([{ pageId: 'page-2', count: 2 }]);
    expect(calls.updatePageTitle).toEqual([]);
    // 映射指向新树 + 新 scope
    expect(row.coursePageId).toBe('page-1');
    expect(row.chapterPageId).toBe('page-2');
    expect(row.rootPageId).toBe('root-new');
  });

  it('升级前的旧映射（无 rootPageId）→ 视为出 scope，重建而不复用', async () => {
    const m = memStorage();
    seedOsCourse(m);
    const legacy: NotionMappingRow = {
      noteId: 1,
      coursePageId: 'legacy-course',
      chapterPageId: 'legacy-chap',
      lastSyncedAt: 5000,
      notionLastEditedTime: iso(4000),
      syncStatus: 'synced',
    };
    m.mappings.set(1, legacy);
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage.length).toBe(2);
    expect(calls.append).toEqual([{ pageId: 'page-2', count: 2 }]);
    expect(row.rootPageId).toBe('root-1');
  });

  it('botId 双侧已知且不一致 → 出 scope，重建页面树', async () => {
    const m = memStorage();
    seedOsCourse(m);
    m.mappings.set(1, syncedMapping({ botId: 'bot-a' }));
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      botId: 'bot-b',
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage.length).toBe(2);
    expect(row.botId).toBe('bot-b');
  });

  it('botId 仅单侧已知 → 不参与校验，按 rootPageId 复用', async () => {
    const m = memStorage();
    m.notes.set(1, makeNote({ updatedAt: 4500 }));
    m.videos.set('BV1test', {
      title: '操作系统课程',
      pages: [
        { cid: 1, part: 'P1 导论' },
        { cid: 2, part: 'P2 进程管理' },
      ],
    });
    m.mappings.set(1, syncedMapping({ botId: 'bot-a' }));
    const { client, calls } = mockClient({ editedTime: iso(4000) });

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      // 当前配置未知 botId → 只按 rootPageId 判断 scope
      noteId: 1,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(calls.createPage).toEqual([]);
    expect(calls.append).toEqual([{ pageId: 'chap-1', count: 2 }]);
  });

  it('第二份笔记不复用其他根页面下建过的课程页', async () => {
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
    // note 1 的课程页建在 root-other 下；note 2 当前用 root-1 同步 → 不得复用
    m.mappings.set(
      1,
      syncedMapping({ rootPageId: 'root-other', coursePageId: 'foreign-course' }),
    );
    const { client, calls } = mockClient();

    const row = await syncNoteToNotion({
      client,
      rootPageId: 'root-1',
      noteId: 2,
      storage: m.storage,
    });

    expect(row.syncStatus).toBe('synced');
    expect(row.coursePageId).not.toBe('foreign-course');
    expect(calls.createPage[0]).toEqual({ parentPageId: 'root-1', title: '操作系统课程' });
  });
});
