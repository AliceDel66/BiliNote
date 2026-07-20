/**
 * 清洗模型输出：剥离思考过程 / 计划草稿，只保留结构化回答。
 * 讨论稿 §3.4 的结构约束由 Prompt 保证，本模块是兜底——
 * 推理型/小模型常先输出英文 CoT 或 "Let me structure…" 再进入正题。
 */

/** 结构化起点：markdown 标题 / 编号项 / 加粗标记（不匹配行首裸词，防误伤正文；
 *  标题分支用 (?=[\s：:]|$) 而非 \b —— CJK 字符在 JS 正则里非 word char，\b 恒失败） */
const STRUCT_START_RE =
  /^(?:#{1,4}\s*(?:直接回答|答案|回答)(?=[\s：:]|$)|\d+[.、）)]\s*(?:\*\*)?(?:直接回答|答案|回答)(?:\*\*)?|\*\*(?:直接回答|答案|回答)\*\*)/m;

/** 前导内容短于该长度时视为正常过渡，不剥离（防误伤） */
const MIN_PREAMBLE_LEN = 80;

export interface CleanedAnswer {
  answer: string;
  /** 被剥离的前置思考/计划（仅诊断，不展示、不写库） */
  thinking?: string;
}

export function stripThinking(raw: string): CleanedAnswer {
  const text = raw.trim();
  const m = STRUCT_START_RE.exec(text);
  if (!m || m.index === 0) return { answer: text };
  const preamble = text.slice(0, m.index).trim();
  if (preamble.length < MIN_PREAMBLE_LEN) return { answer: text };
  return { answer: text.slice(m.index).trim(), thinking: preamble };
}
