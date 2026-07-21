/**
 * IndexedDB 本地库（Dexie），见 PRD 6.3。
 * 表：videos / subtitles / summaries / notes（noteVersions 等随笔记功能再加）。
 */
import Dexie, { type EntityTable } from 'dexie';
import type { Cue, VideoPage } from '../bilibili/types';
import type { AnalysisResult } from '../summarize/types';
import type { ChatSession, ChatTopic, ChatTurn } from '../chat/types';

export interface VideoRow {
  bvid: string;
  aid: number;
  title: string;
  cover: string;
  owner: string;
  duration: number;
  parts: VideoPage[];
  firstSeenAt: number;
  lastViewedAt: number;
}

export interface SubtitleRow {
  id?: number;
  bvid: string;
  cid: number;
  lang: string;
  source: 'human' | 'ai';
  cues: Cue[];
  fetchedAt: number;
}

export interface SummaryRow {
  id?: number;
  bvid: string;
  cid: number;
  modelId: string;
  result: AnalysisResult;
  createdAt: number;
}

export interface NoteRow {
  id?: number;
  bvid: string;
  cid: number;
  title: string;
  contentMd: string;
  template: 'study' | 'work' | 'blank';
  source: 'ai' | 'manual' | 'mixed';
  dirty: boolean;
  /** 乐观锁版本号（C3）：每次成功写入 +1；升级前的旧行运行时缺失，一律按 1 处理 */
  rev: number;
  createdAt: number;
  updatedAt: number;
}

/** 笔记编辑历史（每份笔记保留最近 10 版，PRD F-05） */
export interface NoteVersionRow {
  id?: number;
  noteId: number;
  contentMd: string;
  createdAt: number;
}

/** Notion 专用同步状态（含 conflict）；其他连接器无冲突检测（last-write-wins） */
export type NotionSyncStatus = 'pending' | 'syncing' | 'synced' | 'error' | 'conflict';

/** 本地笔记 ↔ Notion 页面树映射（PRD 6.3 / F-07） */
export interface NotionMappingRow {
  id?: number;
  noteId: number;
  /** 课程页（视频标题）；首次同步前可能尚未创建 */
  coursePageId?: string;
  /** 章节页（分 P 标题）；单 P 视频无章节页，内容直接写在课程页下 */
  chapterPageId?: string;
  /** 映射所属 scope（C4）：同步根页面。仅在 rootPageId 与当前配置一致时复用页面 id */
  rootPageId?: string;
  /** 映射所属 scope（C4）：集成 bot id；双侧都已知时才参与校验 */
  botId?: string;
  /** 上次同步完成时间（本地 ms） */
  lastSyncedAt: number;
  /** 上次同步后 Notion 页面的 last_edited_time（ISO 字符串原样保存，冲突检测基线） */
  notionLastEditedTime: string;
  syncStatus: NotionSyncStatus;
  error?: string;
}

export const db = new Dexie('bilinote') as Dexie & {
  videos: EntityTable<VideoRow, 'bvid'>;
  subtitles: EntityTable<SubtitleRow, 'id'>;
  summaries: EntityTable<SummaryRow, 'id'>;
  notes: EntityTable<NoteRow, 'id'>;
  noteVersions: EntityTable<NoteVersionRow, 'id'>;
  notionMappings: EntityTable<NotionMappingRow, 'id'>;
  chatSessions: EntityTable<ChatSession, 'id'>;
  chatTopics: EntityTable<ChatTopic, 'id'>;
  chatTurns: EntityTable<ChatTurn, 'id'>;
  connectorSync: EntityTable<ConnectorSyncRow, 'id'>;
};

db.version(1).stores({
  videos: 'bvid, lastViewedAt',
  subtitles: '++id, &[bvid+cid], bvid',
  summaries: '++id, &[bvid+cid+modelId], [bvid+cid]',
  notes: '++id, bvid, updatedAt',
});

// v2：新增笔记版本历史与 Notion 同步映射（纯加表，无数据迁移）
db.version(2).stores({
  noteVersions: '++id, noteId, createdAt',
  notionMappings: '++id, noteId, syncStatus',
});

// v3：新增 AI Chat 持久化（纯加表，无数据迁移）。
// chatSessions 按 [bvid+cid] 唯一；chatTurns.clientRequestId 唯一（重连/重发去重）。
db.version(3).stores({
  chatSessions: 'id, &[bvid+cid]',
  chatTopics: 'id, sessionId',
  chatTurns: 'id, topicId, &clientRequestId',
});

// ---------- 便捷读写 ----------

const SUBTITLE_TTL = 24 * 60 * 60 * 1000;

export async function getCachedSubtitle(
  bvid: string,
  cid: number,
): Promise<SubtitleRow | undefined> {
  const row = await db.subtitles.where('[bvid+cid]').equals([bvid, cid]).first();
  if (!row) return undefined;
  if (Date.now() - row.fetchedAt > SUBTITLE_TTL) return undefined;
  return row;
}

export async function saveSubtitle(
  row: Omit<SubtitleRow, 'id'>,
): Promise<void> {
  // 单事务内 读旧行 → put（自然唯一键 [bvid+cid]）：不做 delete→add，避免中途丢数据
  await db.transaction('rw', db.subtitles, async () => {
    const old = await db.subtitles.where('[bvid+cid]').equals([row.bvid, row.cid]).first();
    await db.subtitles.put({ ...row, id: old?.id });
  });
}

export async function getCachedSummary(
  bvid: string,
  cid: number,
  modelId: string,
): Promise<SummaryRow | undefined> {
  return db.summaries
    .where('[bvid+cid+modelId]')
    .equals([bvid, cid, modelId])
    .first();
}

/** 当前 cid 最近一次缓存的分析结果（不限模型；AI Chat 上下文用） */
export async function getLatestSummary(
  bvid: string,
  cid: number,
): Promise<SummaryRow | undefined> {
  const rows = await db.summaries.where('[bvid+cid]').equals([bvid, cid]).sortBy('createdAt');
  return rows[rows.length - 1];
}

export async function saveSummary(row: Omit<SummaryRow, 'id'>): Promise<void> {
  // 单事务内 读旧行 → put（自然唯一键 [bvid+cid+modelId]）：不做 delete→add
  await db.transaction('rw', db.summaries, async () => {
    const old = await db.summaries
      .where('[bvid+cid+modelId]')
      .equals([row.bvid, row.cid, row.modelId])
      .first();
    await db.summaries.put({ ...row, id: old?.id });
  });
}

export async function upsertVideo(video: Omit<VideoRow, 'firstSeenAt' | 'lastViewedAt'>): Promise<void> {
  const existing = await db.videos.get(video.bvid);
  await db.videos.put({
    ...video,
    firstSeenAt: existing?.firstSeenAt ?? Date.now(),
    lastViewedAt: Date.now(),
  });
}

// ---------- 笔记（F-05） ----------

const NOTE_VERSIONS_KEEP = 10;

export async function createNote(
  input: Pick<NoteRow, 'bvid' | 'cid' | 'title' | 'contentMd'> &
    Partial<Pick<NoteRow, 'template' | 'source'>>,
): Promise<NoteRow> {
  const now = Date.now();
  const row: Omit<NoteRow, 'id'> = {
    template: 'blank',
    source: 'manual',
    ...input,
    dirty: true,
    rev: 1,
    createdAt: now,
    updatedAt: now,
  };
  const id = (await db.notes.add(row)) as number;
  await db.noteVersions.add({ noteId: id, contentMd: row.contentMd, createdAt: now });
  return { ...row, id };
}

/** 笔记 CAS 版本冲突（saveNoteCAS 抛出）：携带冲突时刻的最新行，调用方据此重放或提示 */
export class NoteRevConflict extends Error {
  constructor(readonly latest: NoteRow) {
    super('笔记已被其他写入修改（版本冲突）');
    this.name = 'NoteRevConflict';
  }
}

/**
 * 单事务持久化笔记补丁：内容变化时写版本历史（只留最近 10 版），
 * 成功写入一律 rev+1 并标记 dirty（待同步）。
 * expectedRev 提供时做 CAS 校验，不匹配抛 NoteRevConflict。
 */
async function persistNotePatch(
  id: number,
  patch: Partial<Pick<NoteRow, 'title' | 'contentMd'>>,
  expectedRev?: number,
): Promise<NoteRow> {
  return db.transaction('rw', db.notes, db.noteVersions, async () => {
    const existing = await db.notes.get(id);
    if (!existing) throw new Error('笔记不存在');
    const currentRev = existing.rev ?? 1; // 升级前的旧行按 1 处理
    if (expectedRev !== undefined && currentRev !== expectedRev) {
      throw new NoteRevConflict(existing);
    }
    const now = Date.now();
    const contentChanged =
      patch.contentMd !== undefined && patch.contentMd !== existing.contentMd;
    const changes = { ...patch, dirty: true, updatedAt: now, rev: currentRev + 1 };
    await db.notes.update(id, changes);
    if (contentChanged) {
      await db.noteVersions.add({ noteId: id, contentMd: patch.contentMd!, createdAt: now });
      const versions = await db.noteVersions.where('noteId').equals(id).sortBy('createdAt');
      const excess = versions.length - NOTE_VERSIONS_KEEP;
      if (excess > 0) {
        await db.noteVersions.bulkDelete(versions.slice(0, excess).map((v) => v.id!));
      }
    }
    return { ...existing, ...changes, id };
  });
}

/**
 * 保存笔记内容（自动保存防抖在 UI 侧处理）。内容变化时写入版本历史，
 * 每份笔记只保留最近 10 版；保存会把笔记标记为 dirty（待同步）。
 * 非 CAS 旧路径：不做版本校验（rev 照常 +1），新写入方请用 saveNoteCAS。
 */
export async function saveNote(
  id: number,
  patch: Partial<Pick<NoteRow, 'title' | 'contentMd'>>,
): Promise<void> {
  await persistNotePatch(id, patch);
}

/**
 * CAS 保存（C3）：仅当当前 rev === expectedRev 时写入，否则抛 NoteRevConflict
 * （携带最新行）。成功返回写入后的最新行（rev 已 +1）。
 */
export async function saveNoteCAS(
  id: number,
  patch: Partial<Pick<NoteRow, 'title' | 'contentMd'>>,
  expectedRev: number,
): Promise<NoteRow> {
  return persistNotePatch(id, patch, expectedRev);
}

export async function getNote(id: number): Promise<NoteRow | undefined> {
  return db.notes.get(id);
}

export async function listNotesByVideo(bvid: string): Promise<NoteRow[]> {
  const rows = await db.notes.where('bvid').equals(bvid).sortBy('updatedAt');
  return rows.reverse();
}

export async function listNoteVersions(noteId: number): Promise<NoteVersionRow[]> {
  const rows = await db.noteVersions.where('noteId').equals(noteId).sortBy('createdAt');
  return rows.reverse();
}

export async function deleteNote(id: number): Promise<void> {
  await db.notes.delete(id);
  await db.noteVersions.where('noteId').equals(id).delete();
  await db.notionMappings.where('noteId').equals(id).delete();
  await db.connectorSync.where('noteId').equals(id).delete();
}

/** 同步成功后清除 dirty 标记 */
export async function markNoteSynced(id: number): Promise<void> {
  await db.notes.update(id, { dirty: false });
}

// ---------- Notion 同步映射（F-07） ----------

export async function getNotionMapping(noteId: number): Promise<NotionMappingRow | undefined> {
  return db.notionMappings.where('noteId').equals(noteId).first();
}

export async function saveNotionMapping(row: NotionMappingRow): Promise<void> {
  const existing = await db.notionMappings.where('noteId').equals(row.noteId).first();
  const { id: _omit, ...changes } = row;
  if (existing) {
    await db.notionMappings.update(existing.id!, changes);
  } else {
    await db.notionMappings.add(row);
  }
}

/** 非 Notion 连接器的同步状态（无 conflict：last-write-wins，§2.1 不承诺双向同步） */
export type ConnectorSyncStatus = 'pending' | 'syncing' | 'synced' | 'error';

/** 本地笔记 ↔ 非 Notion 连接器外部文档映射（知识连接 v1，讨论稿 §2） */
export interface ConnectorSyncRow {
  id?: number;
  noteId: number;
  /** ConnectorProfile.id */
  connectorId: string;
  /** 外部文档 id（MCP 返回的 pageId/docId，或 bridge 文件相对路径） */
  externalId: string;
  lastSyncedAt: number;
  syncStatus: ConnectorSyncStatus;
  error?: string;
}

// v4：新增知识连接器同步映射（纯加表，无数据迁移）。
// connectorSync 按 (noteId, connectorId) 逻辑唯一（见 saveConnectorSync）。
db.version(4).stores({
  connectorSync: '++id, noteId, connectorId',
});

// ---------- 知识连接器同步映射 ----------

export async function getConnectorSync(
  noteId: number,
  connectorId?: string,
): Promise<ConnectorSyncRow | undefined> {
  const rows = await db.connectorSync.where('noteId').equals(noteId).toArray();
  return connectorId ? rows.find((r) => r.connectorId === connectorId) : rows[0];
}

export async function saveConnectorSync(row: ConnectorSyncRow): Promise<void> {
  const existing = await getConnectorSync(row.noteId, row.connectorId);
  const { id: _omit, ...changes } = row;
  if (existing) {
    await db.connectorSync.update(existing.id!, changes);
  } else {
    await db.connectorSync.add(row);
  }
}

/** 指定连接器最近一次同步记录（设置页「上次同步状态」用） */
export async function getLatestConnectorSync(
  connectorId: string,
): Promise<ConnectorSyncRow | undefined> {
  const rows = await db.connectorSync.where('connectorId').equals(connectorId).toArray();
  return rows.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt)[0];
}

/** 同视频其他笔记已建过的课程页 id（避免每个分 P 各建一棵课程页）。
 *  传 scope 时只认同一同步根页面（及同一 bot，双侧已知时）下的映射（C4）。 */
export async function findCoursePageId(
  bvid: string,
  scope?: { rootPageId: string; botId?: string },
): Promise<string | undefined> {
  const notes = await db.notes.where('bvid').equals(bvid).primaryKeys();
  if (notes.length === 0) return undefined;
  const mappings = await db.notionMappings
    .where('noteId')
    .anyOf(notes as number[])
    .toArray();
  const hit = mappings.find((m) => {
    if (!m.coursePageId) return false;
    if (!scope) return true;
    if (m.rootPageId !== scope.rootPageId) return false;
    if (scope.botId && m.botId && m.botId !== scope.botId) return false;
    return true;
  });
  return hit?.coursePageId;
}
