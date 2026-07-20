/**
 * Notion 页面树同步（PRD F-07 / 6.2）。
 *
 * 页面树：根页面（用户在设置页选定）→ 课程页（视频标题）→ 章节页（P{n} · 分 P 标题，
 * 单 P 视频跳过该层）→ 笔记内容块写在章节页（或课程页）下。
 *
 * 存量改名：复用已有课程页 / 章节页时，先 GET 页面读当前标题，与期望标题不一致
 * 则调 updatePageTitle 改名（章节页命名从裸分 P 标题升级为 P{n} · 标题的迁移靠此
 * 完成）；冲突判定通过的同步才会触发改名，冲突时保持「不写任何内容」。
 *
 * 更新策略：整页替换 —— 归档目标页下全部现有子块，再按最新笔记 Markdown
 * 重新生成并追加块。不做逐块 diff：实现简单、结果可预期，代价是该页在
 * Notion 侧的块历史会随每次同步重建。
 *
 * 冲突检测：写入前 GET 目标页；若其 last_edited_time 晚于上次同步时间，
 * 且本地笔记在上次同步后也有修改（note.updatedAt > lastSyncedAt），判定
 * 双方都改过 → 状态置为 conflict，不写任何内容；调用方传 force:true 可
 * 强制覆盖。仅远端改过（本地未动）不算冲突，按本地内容覆盖。
 */
import type { NoteRow, NotionMappingRow } from '../storage/db';
import { NotionError, type NotionClient } from './client';
import { markdownToNotionBlocks } from './markdown';

/** 同步所需的存储操作（background 用 Dexie 实现；测试用内存实现） */
export interface SyncStorage {
  getNote(noteId: number): Promise<NoteRow | undefined>;
  getVideo(
    bvid: string,
  ): Promise<
    { title: string; pages: { cid: number; page?: number; part: string }[] } | undefined
  >;
  getMapping(noteId: number): Promise<NotionMappingRow | undefined>;
  saveMapping(row: NotionMappingRow): Promise<void>;
  /** 同视频已有笔记建过的课程页（避免每个分 P 重复建课程页） */
  findCoursePageId(bvid: string): Promise<string | undefined>;
  /** 同步成功后清除笔记 dirty 标记 */
  markNoteClean(noteId: number): Promise<void>;
}

export interface SyncNoteParams {
  client: NotionClient;
  rootPageId: string;
  noteId: number;
  force?: boolean;
  storage: SyncStorage;
}

function errorText(e: unknown): string {
  if (e instanceof NotionError) return e.userMessage;
  return (e as Error).message ?? String(e);
}

/**
 * 同步单份笔记到 Notion。任何结果（含冲突 / 失败）都会写入映射表并返回；
 * 不会因业务错误抛异常（存储异常除外）。
 */
export async function syncNoteToNotion(
  params: SyncNoteParams,
): Promise<NotionMappingRow> {
  const { client, rootPageId, force, storage } = params;
  const note = await storage.getNote(params.noteId);
  if (!note?.id) throw new Error('笔记不存在或已被删除');
  const noteId = note.id;

  const existing = await storage.getMapping(noteId);
  const base: NotionMappingRow = existing ?? {
    noteId,
    lastSyncedAt: 0,
    notionLastEditedTime: '',
    syncStatus: 'pending',
  };

  let coursePageId = base.coursePageId;
  let chapterPageId = base.chapterPageId;
  const fail = async (e: unknown): Promise<NotionMappingRow> => {
    const row: NotionMappingRow = {
      ...base,
      coursePageId,
      chapterPageId,
      syncStatus: 'error',
      error: errorText(e),
    };
    await storage.saveMapping(row);
    return row;
  };

  await storage.saveMapping({ ...base, syncStatus: 'syncing', error: undefined });

  try {
    const video = await storage.getVideo(note.bvid);
    const courseTitle = video?.title || note.title;
    // 多 P 视频才建章节页；分 P 按 cid 匹配
    const pageInfo =
      video && video.pages.length > 1
        ? video.pages.find((p) => p.cid === note.cid)
        : undefined;
    const partTitle = pageInfo?.part ?? '';
    // 章节页标题：P{n} · {分P标题}；无分 P 号时退化为分 P 标题
    const chapterTitle = partTitle
      ? pageInfo?.page
        ? `P${pageInfo.page} · ${partTitle}`
        : partTitle
      : '';

    // 1. 确保课程页存在（优先复用同视频其他笔记建过的）
    let courseReused = !!coursePageId;
    if (!coursePageId) {
      coursePageId = await storage.findCoursePageId(note.bvid);
      courseReused = !!coursePageId;
    }
    if (!coursePageId) {
      coursePageId = (
        await client.createPage({ parentPageId: rootPageId, title: courseTitle })
      ).id;
    }

    // 2. 多 P 时确保章节页存在
    const chapterReused = !!(chapterTitle && chapterPageId);
    if (chapterTitle && !chapterPageId) {
      chapterPageId = (
        await client.createPage({ parentPageId: coursePageId, title: chapterTitle })
      ).id;
    }
    const targetPageId = chapterPageId ?? coursePageId;

    // 3. 冲突检测（仅针对已同步过的页面；新建的页面不可能有外部编辑）
    if (existing && base.lastSyncedAt > 0 && !force) {
      const page = await client.getPage(targetPageId);
      const remoteEditedAt = Date.parse(page.lastEditedTime);
      if (
        Number.isFinite(remoteEditedAt) &&
        remoteEditedAt > base.lastSyncedAt &&
        note.updatedAt > base.lastSyncedAt
      ) {
        const row: NotionMappingRow = {
          ...base,
          coursePageId,
          chapterPageId,
          syncStatus: 'conflict',
          error: '检测到冲突：Notion 页面在本地修改后又被远端编辑，已保留双方版本；可手动强制覆盖',
        };
        await storage.saveMapping(row);
        return row;
      }
    }

    // 4. 存量页面改名：复用的课程页 / 章节页标题与期望不一致时更新
    // （冲突已在上方判过，这里只会落在确定要写入的同步上；404 等错误走外层 fail）
    const ensurePageTitle = async (pageId: string, expected: string): Promise<void> => {
      const page = await client.getPage(pageId);
      if (page.title !== expected) await client.updatePageTitle(pageId, expected);
    };
    if (courseReused) await ensurePageTitle(coursePageId, courseTitle);
    if (chapterReused && chapterPageId) {
      await ensurePageTitle(chapterPageId, chapterTitle);
    }

    // 5. 整页替换：归档现有子块 → 追加新块
    const children = await client.listChildren(targetPageId);
    for (const child of children) {
      await client.archiveBlock(child.id);
    }
    const blocks = markdownToNotionBlocks(note.contentMd);
    await client.appendBlocks(targetPageId, blocks);

    const page = await client.getPage(targetPageId);
    const done: NotionMappingRow = {
      ...base,
      coursePageId,
      chapterPageId,
      lastSyncedAt: Date.now(),
      notionLastEditedTime: page.lastEditedTime,
      syncStatus: 'synced',
      error: undefined,
    };
    await storage.saveMapping(done);
    await storage.markNoteClean(noteId);
    return done;
  } catch (e) {
    return fail(e);
  }
}
