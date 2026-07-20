/** 字幕分块：按 token 预算切块，块间携带 ~30s 重叠防割裂 */
import type { Cue } from '../bilibili/types';

/** 粗略 token 估算：中英文混合按 2 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

export function cuesText(cues: Cue[]): string {
  return cues.map((c) => c.text).join(' ');
}

export interface CueChunk {
  index: number;
  cues: Cue[];
  /** 秒 */
  start: number;
  /** 秒 */
  end: number;
}

export interface ChunkOptions {
  /** 单块 token 上限 */
  budgetTokens: number;
  /** 块间重叠秒数 */
  overlapSeconds?: number;
}

/**
 * 贪心切块：累计 cue 文本 token，达到预算即开新块；
 * 新块从上一块末尾向前回溯 overlapSeconds 秒的 cue 开始。
 */
export function chunkCues(cues: Cue[], opts: ChunkOptions): CueChunk[] {
  const overlap = opts.overlapSeconds ?? 30;
  if (cues.length === 0) return [];

  const chunks: CueChunk[] = [];
  let startIdx = 0;

  while (startIdx < cues.length) {
    let tokens = 0;
    let endIdx = startIdx;
    while (endIdx < cues.length) {
      const t = estimateTokens(cues[endIdx].text) + 1;
      if (tokens + t > opts.budgetTokens && endIdx > startIdx) break;
      tokens += t;
      endIdx++;
    }
    const chunkCuesList = cues.slice(startIdx, endIdx);
    chunks.push({
      index: chunks.length,
      cues: chunkCuesList,
      start: chunkCuesList[0].start,
      end: chunkCuesList[chunkCuesList.length - 1].end,
    });
    if (endIdx >= cues.length) break;

    // 下一块起点：从本块结尾向前回溯 overlap 秒
    const chunkEnd = cues[endIdx - 1].end;
    let nextIdx = endIdx;
    while (nextIdx > startIdx && cues[nextIdx - 1].end > chunkEnd - overlap) {
      nextIdx--;
    }
    // 防御：重叠不得导致起点不前进
    if (nextIdx <= startIdx) nextIdx = startIdx + 1;
    startIdx = nextIdx;
  }

  return chunks;
}
