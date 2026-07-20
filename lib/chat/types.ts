/** AI Chat（在线答疑）领域类型与持久化实体，见讨论稿 §5 / §7.1 */

/** 工具模式（讨论稿 §5.4）：v1 未接检索服务，auto/force 均降级为仅课程 */
export type ToolMode = 'course' | 'auto' | 'force';

/** 上下文完整度（讨论稿 §5.1） */
export type Completeness = 'full' | 'partial' | 'none';

export type ChatTurnStatus = 'streaming' | 'done' | 'cancelled' | 'error';

export type NoteWriteStatus =
  | 'pending'
  | 'written'
  | 'undone'
  | 'skipped'
  | 'failed';

/** 发送问题那一刻的不可变播放快照（讨论稿 §5.2） */
export interface ChatSnapshot {
  bvid: string;
  cid: number;
  /** 分 P 序号（1 起） */
  p: number;
  title: string;
  /** 秒；读取失败时为 0（UI 另给提示） */
  playbackTime: number;
  pageUrl: string;
}

/** 课程会话：按 bvid + cid 隔离，与浏览器 Tab 无关 */
export interface ChatSession {
  id: string;
  bvid: string;
  cid: number;
  /** 当前 cid 的目标课程笔记（首个问答写入时确定） */
  targetNoteId?: number;
  /** Session 级自动记录开关（叠加全局 prefs.chatAutoRecord） */
  autoRecord: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 话题：连续追问默认沿用同一话题与原始时间锚点 */
export interface ChatTopic {
  id: string;
  sessionId: string;
  title: string;
  /** 秒；该话题的课程时间锚点 */
  anchorTime: number;
  createdAt: number;
  updatedAt: number;
}

/** 单轮问答。稳定 id 同时作为笔记里的 chatEntryId，保证幂等写入与定点撤销 */
export interface ChatTurn {
  id: string;
  /** UI 每次发送生成；重连/重发去重依据 */
  clientRequestId: string;
  topicId: string;
  question: string;
  answerMd: string;
  /** 秒；本轮使用的课程时间锚点 */
  anchorTime: number;
  status: ChatTurnStatus;
  noteWriteStatus: NoteWriteStatus;
  /** 写入笔记时使用的 chatEntryId（= turn.id） */
  noteEntryId?: string;
  error?: string;
  createdAt: number;
}
