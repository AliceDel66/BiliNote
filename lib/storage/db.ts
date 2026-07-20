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

export type NotionSyncStatus = 'pending' | 'syncing' | 'synced' | 'error' | 'conflict';

/** 本地笔记 ↔ Notion 页面树映射（PRD 6.3 / F-07） */
export interface NotionMappingRow {
  id?: number;
  noteId: number;
  /** 课程页（视频标题）；首次同步前可能尚未创建 */
  coursePageId?: string;
  /** 章节页（分 P 标题）；单 P 视频无章节页，内容直接写在课程页下 */
  chapterPageId?: string;
  /** 上次同步完成时间（本地 ms） */
  lastSyncedAt: number;
  /** 上次同步后 Notion 页面的 last_edited_time（ISO 字符串原样保存） */
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
  await db.subtitles.where('[bvid+cid]').equals([row.bvid, row.cid]).delete();
  await db.subtitles.add(row);
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
  await db.summaries
    .where('[bvid+cid+modelId]')
    .equals([row.bvid, row.cid, row.modelId])
    .delete();
  await db.summaries.add(row);
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
    createdAt: now,
    updatedAt: now,
  };
  const id = (await db.notes.add(row)) as number;
  await db.noteVersions.add({ noteId: id, contentMd: row.contentMd, createdAt: now });
  return { ...row, id };
}

/**
 * 保存笔记内容（自动保存防抖在 UI 侧处理）。内容变化时写入版本历史，
 * 每份笔记只保留最近 10 版；保存会把笔记标记为 dirty（待同步）。
 */
export async function saveNote(
  id: number,
  patch: Partial<Pick<NoteRow, 'title' | 'contentMd'>>,
): Promise<void> {
  const existing = await db.notes.get(id);
  if (!existing) throw new Error('笔记不存在');
  const now = Date.now();
  const contentChanged =
    patch.contentMd !== undefined && patch.contentMd !== existing.contentMd;
  await db.notes.update(id, { ...patch, dirty: true, updatedAt: now });
  if (contentChanged) {
    await db.noteVersions.add({ noteId: id, contentMd: patch.contentMd!, createdAt: now });
    const versions = await db.noteVersions.where('noteId').equals(id).sortBy('createdAt');
    const excess = versions.length - NOTE_VERSIONS_KEEP;
    if (excess > 0) {
      await db.noteVersions.bulkDelete(versions.slice(0, excess).map((v) => v.id!));
    }
  }
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

/** 同视频其他笔记已建过的课程页 id（避免每个分 P 各建一棵课程页） */
export async function findCoursePageId(bvid: string): Promise<string | undefined> {
  const notes = await db.notes.where('bvid').equals(bvid).primaryKeys();
  if (notes.length === 0) return undefined;
  const mapping = await db.notionMappings
    .where('noteId')
    .anyOf(notes as number[])
    .first();
  return mapping?.coursePageId;
}
