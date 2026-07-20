/** 总结管线类型 */
export interface OutlineItem {
  title: string;
  /** 秒 */
  time: number;
}

export interface SectionSummary {
  title: string;
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
  points: string[];
}

export interface KeyPoint {
  point: string;
  explanation: string;
  /** 秒，可选 */
  time?: number;
}

export interface AnalysisResult {
  /** 结构化结果（模型输出合法 JSON 时存在） */
  outline: OutlineItem[];
  sections: SectionSummary[];
  keyPoints: KeyPoint[];
  /** 模型输出非 JSON 且修复失败时的降级原文 */
  rawMarkdown?: string;
  tokenUsage?: { estimatedInput: number };
}

export type ProgressEvent =
  | { type: 'chunk-start'; index: number; total: number }
  | { type: 'chunk-done'; index: number; total: number; preview: string }
  | { type: 'reduce-start' }
  | { type: 'reduce-delta'; text: string }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };
