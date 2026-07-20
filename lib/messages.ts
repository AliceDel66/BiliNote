/** UI ↔ Background 消息协议 */
import type { AnalysisResult, ProgressEvent } from './summarize/types';
import type {
  ChatSession,
  ChatSnapshot,
  ChatTopic,
  ChatTurn,
  Completeness,
  ToolMode,
} from './chat/types';

export interface PageInfo {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

/** getVideoContext 的返回：content script 上报 + view 接口合并 */
export interface VideoContextInfo {
  bvid: string;
  aid: number;
  /** 当前分 P 序号（1 起） */
  p: number;
  title: string;
  owner: string;
  /** 视频封面 URL（view 接口 pic 字段，侧边栏 hero 卡缩略图用） */
  cover?: string;
  /** 当前分 P 的 cid 与时长 */
  cid: number;
  duration: number;
  pages: PageInfo[];
}

export type BgRequest =
  | { type: 'getVideoContext' }
  | { type: 'seek'; seconds: number; p?: number }
  | { type: 'getPlaybackTime' }
  | { type: 'fetchModels'; baseURL: string; apiKey: string }
  | { type: 'testConnection'; baseURL: string; apiKey: string; model: string }
  | {
      type: 'reportVideoContext';
      context: { bvid: string; p: number; title: string; url: string };
    }
  | { type: 'notionValidateToken'; token: string }
  | { type: 'notionSearchPages'; query: string }
  | { type: 'notionSyncNote'; noteId: number; force?: boolean }
  | { type: 'notionSyncStatus'; noteId: number }
  | { type: 'noteSaved'; noteId: number }
  | { type: 'chatGetState'; bvid: string; cid: number }
  | { type: 'chatUndo'; turnId: string }
  | { type: 'chatSkip'; turnId: string }
  | { type: 'chatRerecord'; turnId: string }
  | { type: 'chatSetAutoRecord'; bvid: string; cid: number; value: boolean };

/** Background → Side Panel 广播（无 sendResponse） */
export type BgBroadcast = { type: 'noteChanged'; noteId: number };

export type BgResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** Side Panel → Background 分析端口消息 */
export type AnalyzePortMsg =
  | { type: 'analyze'; bvid: string; p: number; force?: boolean }
  | { type: 'cancel' };

/** Background → Side Panel 分析端口事件 */
export type AnalyzePortEvent =
  | ProgressEvent
  | { type: 'no-subtitle' }
  | { type: 'done-cached'; result: AnalysisResult };

export const ANALYZE_PORT = 'bilinote-analyze';

// ---------- AI Chat（在线答疑），讨论稿 §7.2 ----------

export const CHAT_PORT = 'bilinote-chat';

/** Side Panel → Background Chat 端口消息 */
export type ChatPortMsg =
  | {
      type: 'ask';
      /** 连续追问的话题；缺省 = 新话题 */
      topicId?: string;
      question: string;
      /** UI 每次发送生成；重连去重依据 */
      clientRequestId: string;
      toolMode: ToolMode;
      /** true = 把当前话题锚点重置为当前播放进度 */
      updateAnchor?: boolean;
    }
  | { type: 'cancel' };

/** Background → Side Panel Chat 端口事件 */
export type ChatPortEvent =
  | { type: 'context-ready'; snapshot: ChatSnapshot; completeness: Completeness }
  | { type: 'answer-delta'; seq: number; delta: string }
  | { type: 'answer-done'; turnId: string; status: 'done' | 'cancelled' }
  | { type: 'note-written'; noteId: number; noteTitle: string; chatEntryId: string }
  | { type: 'note-write-failed'; turnId: string; message: string }
  | { type: 'error'; message: string };

/** chatGetState 响应：重开面板时完整恢复会话（幂等，讨论稿 §9.8） */
export interface ChatStatePayload {
  session: ChatSession | null;
  topics: ChatTopic[];
  /** topicId → 该话题全部轮次（按时间升序） */
  turnsByTopic: Record<string, ChatTurn[]>;
  /** 当前 cid 的上下文完整度（完整分析 / 局部字幕 / 无字幕） */
  completeness: Completeness;
}
