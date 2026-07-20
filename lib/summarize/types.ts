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

export interface ExtensionItem {
  title: string;
  detail: string;
}

export interface AnalysisResult {
  /** 结构化结果（模型输出合法 JSON 时存在） */
  outline: OutlineItem[];
  sections: SectionSummary[];
  keyPoints: KeyPoint[];
  /** 拓展知识：与视频内容强相关的延伸概念 / 进阶方向（2–4 条，可超出字幕范围但不得编造） */
  extensions: ExtensionItem[];
  /** 注意事项：易错点 / 常见误区 / 实践建议（2–4 条） */
  caveats: ExtensionItem[];
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
