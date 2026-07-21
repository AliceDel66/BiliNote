/**
 * 知识库连接器（Knowledge Connector）核心类型，见讨论稿 §2.3 / §2.4。
 *
 * 设计原则（§2.1）：
 * - Notion 只是内置预设之一，不是核心数据模型；
 * - 每个项目一个默认写入目标（active profile），用户可在设置页单选切换；
 * - MCP 是扩展边界，不是统一数据模型 —— 连接器只做能力映射（create/append/update 等）。
 */

export type ConnectorKind =
  | 'notion'
  | 'ima'
  | 'remote-mcp'
  | 'custom-mcp'
  | 'local-bridge'
  | 'local-mcp';

/** stable = 官方预设/成熟路径；beta = 能力以端点实际返回为准；custom = 用户自建端点 */
export type ConnectorStatus = 'stable' | 'beta' | 'custom';

/**
 * MCP 系连接器的鉴权方式（config.authScheme，缺省 = 'bearer' 以兼容旧 profile）：
 * - raw：Authorization 头直接放原始 token 值，不加 Bearer 前缀
 *   （腾讯文档官方要求，见 developer.cloud.tencent.com/mcp/server/11803 的配置示例
 *   {"url":"https://docs.qq.com/openapi/mcp","headers":{"Authorization":"你的Token值"}}）；
 * - bearer：Authorization: Bearer <token>（通用远程 MCP / 本机 bridge）；
 * - none：不带任何鉴权头（飞书个人 MCP，凭据内嵌在 URL 路径里）。
 */
export type ConnectorAuthScheme = 'raw' | 'bearer' | 'none';

/** 腾讯文档官方 MCP 端点（streamable HTTP），见 docs.qq.com/open/document/mcp/get-token/ */
export const TENCENT_DOCS_MCP_ENDPOINT = 'https://docs.qq.com/openapi/mcp';

/** local-mcp（语雀等 stdio MCP 经 bridge mcp-proxy 接入）的本机默认端口 */
export const DEFAULT_LOCAL_MCP_PORT = 27184;

/**
 * 连接器配置档案。token 等凭据直接放在 config 内（chrome.storage.local，永不同步），
 * 例外：kind === 'notion' 时 config = { binding: 'notionConfig' }，凭据沿用既有
 * NotionConfig 存储（迁移不复制 token）。
 *
 * config 约定（按 kind）：
 * - ima：{ clientId, apiKey, knowledgeBaseId, knowledgeBaseName }
 * - remote-mcp / custom-mcp：{ endpoint, token?, authScheme? }
 * - local-mcp：{ port, token }（端点固定为 http://127.0.0.1:<port>/mcp，token 即 bridge token）
 * - local-bridge：{ port, token }
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
  ima: {
    label: 'ima',
    status: 'beta',
    defaultName: 'ima 知识库（Beta）',
    desc: '官方 OpenAPI：Markdown 笔记新建与增量追加，写入指定 ima 知识库',
  },
  'remote-mcp': {
    label: 'Remote MCP',
    status: 'beta',
    defaultName: '远程 MCP（Beta）',
    desc: '经远程 MCP 写入在线文档，能力以端点实际返回为准',
  },
  'custom-mcp': {
    label: 'Custom Remote MCP',
    status: 'custom',
    defaultName: '自定义 MCP',
    desc: '连接任意公网 HTTPS MCP 端点（保存时申请域名权限）',
  },
  'local-bridge': {
    label: 'Obsidian',
    status: 'stable',
    defaultName: 'Obsidian Vault',
    desc: '经本机 bridge 写入 Obsidian Vault，Markdown 文件保留在本地',
  },
  'local-mcp': {
    label: 'Local MCP',
    status: 'beta',
    defaultName: '语雀（本地 MCP）',
    desc: '经本机 bridge mcp-proxy 接入 stdio MCP 服务（语雀等）',
  },
};

/** 设置页「添加连接」目录卡的预设（一个 kind 可对应多个预设，如 remote-mcp = 腾讯文档 / 飞书文档） */
export interface ConnectorPreset {
  id:
    | 'notion'
    | 'ima'
    | 'tencent-docs'
    | 'feishu-docs'
    | 'custom-mcp'
    | 'obsidian'
    | 'yuque';
  kind: ConnectorKind;
  label: string;
  status: ConnectorStatus;
  defaultName: string;
  desc: string;
}

/** 目录卡展示顺序（2 列网格） */
export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'notion',
    kind: 'notion',
    label: 'Notion',
    status: 'stable',
    defaultName: 'Notion（官方预设）',
    desc: '官方内部集成：课程 / 章节页面树，整页替换同步',
  },
  {
    id: 'ima',
    kind: 'ima',
    label: 'ima',
    status: 'beta',
    defaultName: 'ima 知识库（Beta）',
    desc: '官方 OpenAPI：选择可写知识库，保存课程 Markdown 笔记',
  },
  {
    id: 'tencent-docs',
    kind: 'remote-mcp',
    label: '腾讯文档',
    status: 'beta',
    defaultName: '腾讯文档（Beta）',
    desc: '官方 MCP 端点（docs.qq.com/openapi/mcp），原始 Token 鉴权（无 Bearer 前缀）',
  },
  {
    id: 'feishu-docs',
    kind: 'remote-mcp',
    label: '飞书文档',
    status: 'beta',
    defaultName: '飞书文档（Beta）',
    desc: '粘贴飞书 MCP 配置页生成的个人 URL（open.feishu.cn），URL 本身即凭据',
  },
  {
    id: 'custom-mcp',
    kind: 'custom-mcp',
    label: 'Custom Remote MCP',
    status: 'custom',
    defaultName: '自定义 MCP',
    desc: '连接任意公网 HTTPS MCP 端点（保存时申请域名权限）',
  },
  {
    id: 'obsidian',
    kind: 'local-bridge',
    label: 'Obsidian',
    status: 'stable',
    defaultName: 'Obsidian Vault',
    desc: '经本机 bridge 写入 Obsidian Vault，Markdown 文件保留在本地',
  },
  {
    id: 'yuque',
    kind: 'local-mcp',
    label: '语雀',
    status: 'beta',
    defaultName: '语雀（本地 MCP）',
    desc: '经本机 bridge mcp-proxy 运行 yuque-mcp（Python stdio → HTTP）',
  },
];

/** 各连接器共用的构造依赖（测试注入用） */
export interface ConnectorDeps {
  fetchImpl?: typeof fetch;
  /** notion 专用：替换既有整页同步入口（默认 syncNoteWithStoredConfig） */
  notionSync?: (noteId: number, force?: boolean) => Promise<import('../storage/db').NotionMappingRow>;
  /**
   * MCP 401 鉴权兜底重试成功后的 scheme 持久化出口（默认经 registry 写回 profile，
   * 见 mcpConnector.withAuthFallback）；测试注入 mock 以避免触碰 storage。
   */
  persistAuthScheme?: (profile: ConnectorProfile, scheme: 'raw' | 'bearer') => Promise<void>;
}
