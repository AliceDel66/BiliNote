/**
 * 同步路由：把本地笔记同步到「当前默认写入目标」（active connector profile）。
 *
 * - kind === 'notion'：原样走既有 syncNoteToNotion 路径（页面树 + 整页替换 +
 *   冲突检测），映射写 notionMappings 表，行为与知识连接上线前完全一致；
 * - 其他连接器：解析笔记与课程标题（与 Chat 同规则 —— 调用方传入的 noteId 已是
 *   Chat 侧 resolveTargetNote 的结果），调 connector.upsertCourseNote，映射写
 *   Dexie v4 connectorSync 表；不做冲突检测（last-write-wins，§2.1）。
 *
 * 返回统一形状的 TargetSyncRow（与 NotionMappingRow 字段兼容），
 * 侧边栏同步徽章无需区分目标类型。
 */
import {
  db,
  getConnectorSync,
  getNote,
  getNotionMapping,
  markNoteSynced,
  saveConnectorSync,
  type ConnectorSyncRow,
  type NotionSyncStatus,
} from '../storage';
import { buildConnector, getActiveConnectorProfile } from './registry';
import { syncNoteWithStoredConfig } from './notionConnector';
import type { ConnectorDeps } from './types';

/** 统一同步结果行（侧边栏徽章 / 消息响应共用；notionLastEditedTime 仅 notion 有值） */
export interface TargetSyncRow {
  noteId: number;
  connectorId: string;
  lastSyncedAt: number;
  notionLastEditedTime: string;
  syncStatus: NotionSyncStatus;
  error?: string;
}

export interface SyncTargetDeps {
  /** notion 路径替换入口（测试注入） */
  notionSync?: ConnectorDeps['notionSync'];
  connectorDeps?: ConnectorDeps;
}

function errorText(e: unknown): string {
  return (e as Error).message ?? String(e);
}

/**
 * 同步单份笔记到当前默认写入目标。业务失败不抛异常（落库后返回 error 行，
 * 与 syncNoteToNotion 一致）；笔记不存在 / 未配置连接时抛错。
 */
export async function syncNoteToTarget(
  noteId: number,
  opts?: { force?: boolean; deps?: SyncTargetDeps },
): Promise<TargetSyncRow> {
  const profile = await getActiveConnectorProfile();
  if (!profile) {
    throw new Error('请先在设置页配置知识库连接（Notion / 腾讯文档 / MCP / 本地 Markdown）');
  }

  // ---- Notion：既有路径原样委托 ----
  if (profile.kind === 'notion') {
    const sync = opts?.deps?.notionSync ?? syncNoteWithStoredConfig;
    const row = await sync(noteId, opts?.force);
    return { ...row, connectorId: profile.id };
  }

  // ---- 其他连接器：upsert + connectorSync 表 ----
  const note = await getNote(noteId);
  if (!note?.id) throw new Error('笔记不存在或已被删除');

  const video = await db.videos.get(note.bvid);
  const pageInfo =
    video && video.parts.length > 1
      ? video.parts.find((p) => p.cid === note.cid)
      : undefined;
  const partLabel = pageInfo
    ? pageInfo.page
      ? `P${pageInfo.page} ${pageInfo.part}`
      : pageInfo.part
    : undefined;

  const existing = await getConnectorSync(noteId, profile.id);
  const base: ConnectorSyncRow = existing ?? {
    noteId,
    connectorId: profile.id,
    externalId: '',
    lastSyncedAt: 0,
    syncStatus: 'pending',
  };
  const toRow = (r: ConnectorSyncRow): TargetSyncRow => ({
    noteId,
    connectorId: profile.id,
    lastSyncedAt: r.lastSyncedAt,
    notionLastEditedTime: '',
    syncStatus: r.syncStatus,
    error: r.error,
  });

  await saveConnectorSync({ ...base, syncStatus: 'syncing', error: undefined });
  try {
    const connector = buildConnector(profile, opts?.deps?.connectorDeps);
    const result = await connector.upsertCourseNote({
      noteId,
      courseTitle: video?.title || note.title,
      partLabel,
      contentMd: note.contentMd,
      externalId: base.externalId || undefined,
    });
    const done: ConnectorSyncRow = {
      ...base,
      externalId: result.externalId,
      lastSyncedAt: Date.now(),
      syncStatus: 'synced',
      error: undefined,
    };
    await saveConnectorSync(done);
    await markNoteSynced(noteId);
    return toRow(done);
  } catch (e) {
    const failed: ConnectorSyncRow = {
      ...base,
      syncStatus: 'error',
      error: errorText(e),
    };
    await saveConnectorSync(failed);
    return toRow(failed);
  }
}

/** 侧边栏徽章统一查询：notion → notionMappings；其他 → connectorSync */
export async function getTargetSyncRow(noteId: number): Promise<TargetSyncRow | null> {
  const profile = await getActiveConnectorProfile();
  if (!profile) return null;
  if (profile.kind === 'notion') {
    const m = await getNotionMapping(noteId);
    return m ? { ...m, connectorId: profile.id } : null;
  }
  const row = await getConnectorSync(noteId, profile.id);
  if (!row) return null;
  return {
    noteId,
    connectorId: profile.id,
    lastSyncedAt: row.lastSyncedAt,
    notionLastEditedTime: '',
    syncStatus: row.syncStatus,
    error: row.error,
  };
}
