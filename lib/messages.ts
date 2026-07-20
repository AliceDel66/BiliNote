/** UI ↔ Background 消息协议 */
import type { AnalysisResult, ProgressEvent } from './summarize/types';

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
  /** 当前分 P 的 cid 与时长 */
  cid: number;
  duration: number;
  pages: PageInfo[];
}

export type BgRequest =
  | { type: 'getVideoContext' }
  | { type: 'seek'; seconds: number; p?: number }
  | { type: 'fetchModels'; baseURL: string; apiKey: string }
  | { type: 'testConnection'; baseURL: string; apiKey: string; model: string }
  | {
      type: 'reportVideoContext';
      context: { bvid: string; p: number; title: string; url: string };
    };

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
