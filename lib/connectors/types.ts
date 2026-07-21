/**
 * 知识库连接器（Knowledge Connector）核心类型，见讨论稿 §2.3 / §2.4。
 *
 * 设计原则（§2.1）：
 * - Notion 只是内置预设之一，不是核心数据模型；
 * - 每个项目一个默认写入目标（active profile），用户可在设置页单选切换；
 * - MCP 是扩展边界，不是统一数据模型 —— 连接器只做能力映射（create/append/update 等）。
 */

export type ConnectorKind = 'notion' | 'remote-mcp' | 'custom-mcp' | 'local-bridge';

/** stable = 官方预设/成熟路径；beta = 能力以端点实际返回为准；custom = 用户自建端点 */
export type ConnectorStatus = 'stable' | 'beta' | 'custom';

/**
 * 连接器配置档案。token 等凭据直接放在 config 内（chrome.storage.local，永不同步），
 * 唯二例外：kind === 'notion' 时 config = { binding: 'notionConfig' }，凭据沿用既有
 * NotionConfig 存储（迁移不复制 token）。
 */
export interface ConnectorProfile {
  id: string;
  kind: ConnectorKind;
  name: string;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  createdAt: number;
}

export interface ConnectorTestResult {
  ok: boolean;
  /** 面向用户的一行中文说明（成功：服务器名 + 能力；失败：可操作提示） */
  detail: string;
}

/** 写入目标输入。notion 适配器走既有整页同步路径，需要 noteId 定位本地笔记 */
export interface UpsertNoteInput {
  courseTitle: string;
  chapterTitle?: string;
  /** 分 P 标签（如「P2 进程管理」）；单 P 视频为空 */
  partLabel?: string;
  contentMd: string;
  /** 上次同步记录的外部文档 id；存在时连接器应优先更新而非新建 */
  externalId?: string;
  /** notion 适配器专用：本地笔记 id（走 syncNoteToNotion 既有路径） */
  noteId?: number;
}

export interface UpsertNoteResult {
  externalId: string;
  externalUrl?: string;
  editedAt?: number;
}

export interface KnowledgeConnector {
  readonly profile: ConnectorProfile;
  testConnection(): Promise<ConnectorTestResult>;
  upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult>;
}

/** 各类连接的展示元数据（设置页目录卡用） */
export const CONNECTOR_KIND_INFO: Record<
  ConnectorKind,
  { label: string; status: ConnectorStatus; defaultName: string; desc: string }
> = {
  notion: {
    label: 'Notion',
    status: 'stable',
    defaultName: 'Notion（官方预设）',
    desc: '官方内部集成：课程 / 章节页面树，整页替换同步',
  },
  'remote-mcp': {
    label: '腾讯文档',
    status: 'beta',
    defaultName: '腾讯文档（Beta）',
    desc: '经远程 MCP 写入腾讯文档，能力以端点实际返回为准',
  },
  'custom-mcp': {
    label: 'Custom Remote MCP',
    status: 'custom',
    defaultName: '自定义 MCP',
    desc: '连接任意公网 HTTPS MCP 端点（保存时申请域名权限）',
  },
  'local-bridge': {
    label: 'Local Markdown Bridge',
    status: 'stable',
    defaultName: '本地 Markdown 库',
    desc: '经本机 bridge 写入 Obsidian / Logseq / 纯 Markdown 文件夹',
  },
};

/** 各连接器共用的构造依赖（测试注入用） */
export interface ConnectorDeps {
  fetchImpl?: typeof fetch;
  /** notion 专用：替换既有整页同步入口（默认 syncNoteWithStoredConfig） */
  notionSync?: (noteId: number, force?: boolean) => Promise<import('../storage/db').NotionMappingRow>;
}
