/**
 * IndexedDB 本地库（Dexie），见 PRD 6.3。
 * 表：videos / subtitles / summaries / notes（noteVersions 等随笔记功能再加）。
 */
import Dexie, { type EntityTable } from 'dexie';
import type { Cue, VideoPage } from '../bilibili/types';
import type { AnalysisResult } from '../summarize/types';

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

export const db = new Dexie('bilinote') as Dexie & {
  videos: EntityTable<VideoRow, 'bvid'>;
  subtitles: EntityTable<SubtitleRow, 'id'>;
  summaries: EntityTable<SummaryRow, 'id'>;
  notes: EntityTable<NoteRow, 'id'>;
};

db.version(1).stores({
  videos: 'bvid, lastViewedAt',
  subtitles: '++id, &[bvid+cid], bvid',
  summaries: '++id, &[bvid+cid+modelId], [bvid+cid]',
  notes: '++id, bvid, updatedAt',
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
