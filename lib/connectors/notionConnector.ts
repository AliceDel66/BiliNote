/**
 * Notion 官方预设连接器（stable）：既有 lib/notion token 流 + 页面树同步的薄适配。
 *
 * 不重写 Notion 内部逻辑：
 * - testConnection 包装既有 validateToken（令牌仍存于 NotionConfig，profile 只持引用）；
 * - upsertCourseNote 复用 syncNoteToNotion 既有路径（课程/章节页面树 + 整页替换 +
 *   冲突检测），返回章节页 id 作为 externalId。
 *
 * 注意：常规同步路由（syncTarget）对 notion 直接调 syncNoteWithStoredConfig，
 * 不经过本适配器的 upsertCourseNote —— 后者是为统一 KnowledgeConnector 接口
 * 保留的便捷入口（需要 input.noteId 定位本地笔记）。
 */
import {
  createNotionClient,
  syncNoteToNotion,
  NotionError,
  type SyncStorage,
} from '../notion';
import {
  db,
  getNote,
  getNotionConfig,
  getNotionMapping,
  saveNotionMapping,
  findCoursePageId,
  markNoteSynced,
  type NotionMappingRow,
} from '../storage';
import type {
  ConnectorDeps,
  ConnectorProfile,
  ConnectorTestResult,
  KnowledgeConnector,
  UpsertNoteInput,
  UpsertNoteResult,
} from './types';

/** 既有 background 里的 SyncStorage 接线（原样迁移，行为不变） */
export function createNotionSyncStorage(): SyncStorage {
  return {
    getNote,
    getVideo: async (bvid) => {
      const v = await db.videos.get(bvid);
      if (!v) return undefined;
      return {
        title: v.title,
        pages: v.parts.map((p) => ({ cid: p.cid, page: p.page, part: p.part })),
      };
    },
    getMapping: getNotionMapping,
    saveMapping: saveNotionMapping,
    findCoursePageId,
    markNoteClean: markNoteSynced,
  };
}

/** 用存储的 NotionConfig 跑既有整页同步路径（原 background.doSyncNote，行为不变） */
export async function syncNoteWithStoredConfig(
  noteId: number,
  force?: boolean,
): Promise<NotionMappingRow> {
  const config = await getNotionConfig();
  if (!config?.token || !config.rootPageId) {
    throw new Error('请先在设置页完成 Notion 集成配置（令牌 + 同步根页面）');
  }
  const client = createNotionClient({ token: config.token });
  return syncNoteToNotion({
    client,
    rootPageId: config.rootPageId,
    // botId 仅当配置期缓存过（users/me）才有值；缺省时按 rootPageId 单维度 scope
    botId: config.botId,
    noteId,
    force,
    storage: createNotionSyncStorage(),
  });
}

export function createNotionConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const runSync = deps?.notionSync ?? syncNoteWithStoredConfig;

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const config = await getNotionConfig();
        if (!config?.token) {
          return { ok: false, detail: '尚未配置 Notion 令牌，请展开配置完成集成' };
        }
        const info = await createNotionClient({ token: config.token }).validateToken();
        const root = config.rootPageTitle
          ? `，根页面「${config.rootPageTitle}」`
          : '（尚未选择同步根页面）';
        return {
          ok: true,
          detail: `已连接集成「${info.botName}」${info.workspaceName ? `（工作区：${info.workspaceName}）` : ''}${root}`,
        };
      } catch (e) {
        return {
          ok: false,
          detail: e instanceof NotionError ? e.userMessage : (e as Error).message,
        };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      if (input.noteId == null) {
        throw new Error('Notion 连接器需要 noteId（走既有整页同步路径）');
      }
      const row = await runSync(input.noteId);
      if (row.syncStatus !== 'synced') {
        throw new Error(row.error ?? `Notion 同步未成功（${row.syncStatus}）`);
      }
      return {
        externalId: row.chapterPageId ?? row.coursePageId ?? '',
        editedAt: row.lastSyncedAt,
      };
    },
  };
}
