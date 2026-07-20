import { describe, expect, it } from 'vitest';
import { chunkCues, cuesText, estimateTokens } from '../lib/summarize/chunk';
import { extractJson, validateResult } from '../lib/summarize/pipeline';
import type { Cue } from '../lib/bilibili/types';

function makeCues(count: number, charsPerCue: number, stepSeconds = 2): Cue[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * stepSeconds,
    end: i * stepSeconds + stepSeconds,
    text: '字'.repeat(charsPerCue),
  }));
}

describe('estimateTokens', () => {
  it('按 2 字符 ≈ 1 token 估算', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcde')).toBe(3);
  });
});

describe('chunkCues 分块', () => {
  it('小输入单块返回', () => {
    const cues = makeCues(10, 10);
    const chunks = chunkCues(cues, { budgetTokens: 1000 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].cues).toHaveLength(10);
    expect(chunks[0].start).toBe(0);
  });

  it('超出预算时切块，且每块不超预算（单 cue 除外）', () => {
    // 100 条 × 每条 20 字符(≈10 token) = 1000 token，预算 200 → 应多块
    const cues = makeCues(100, 20);
    const chunks = chunkCues(cues, { budgetTokens: 200, overlapSeconds: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(cuesText(c.cues))).toBeLessThanOrEqual(220);
    }
  });

  it('切块覆盖全部 cue 且按时间顺序', () => {
    const cues = makeCues(100, 20);
    const chunks = chunkCues(cues, { budgetTokens: 200, overlapSeconds: 0 });
    const total = chunks.reduce((n, c) => n + c.cues.length, 0);
    expect(total).toBe(100);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBeGreaterThanOrEqual(chunks[i - 1].start);
    }
  });

  it('重叠：下一块包含上一块末尾 overlap 秒内的 cue，且起点保持前进', () => {
    // 每 cue 2 秒；重叠 30 秒 ≈ 15 条 cue
    const cues = makeCues(100, 20);
    const overlap = 30;
    const chunks = chunkCues(cues, { budgetTokens: 200, overlapSeconds: overlap });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      // 起点不后退到无限循环
      expect(cur.cues[0].start).toBeGreaterThan(prev.cues[0].start);
      // 存在重叠：当前块起点落在上一块窗口内（不超过 prev.end）
      expect(cur.start).toBeLessThan(prev.end);
      expect(prev.end - cur.start).toBeLessThanOrEqual(overlap + 2);
    }
  });

  it('空输入返回空数组', () => {
    expect(chunkCues([], { budgetTokens: 100 })).toEqual([]);
  });
});

describe('extractJson / validateResult', () => {
  it('容忍 ```json 围栏', () => {
    const raw = extractJson(
      '```json\n{"outline":[{"title":"开场","time":"00:30"}],"sections":[],"keyPoints":[]}\n```',
    );
    const result = validateResult(raw, 600);
    expect(result?.outline).toEqual([{ title: '开场', time: 30 }]);
  });

  it('越界时间戳被丢弃', () => {
    const raw = extractJson(
      JSON.stringify({
        outline: [
          { title: '合法', time: '10:00' },
          { title: '越界', time: '99:00' },
        ],
        sections: [
          { title: 'A', start: '00:00', end: '05:00', points: ['p1'] },
          { title: 'B', start: '80:00', end: '90:00', points: [] },
        ],
        keyPoints: [{ point: 'k', explanation: 'e', time: '70:00' }],
      }),
    );
    const result = validateResult(raw, 3600);
    expect(result).not.toBeNull();
    expect(result!.outline).toEqual([{ title: '合法', time: 600 }]);
    expect(result!.sections).toHaveLength(1);
    expect(result!.keyPoints[0].time).toBeUndefined();
  });

  it('完全非 JSON 抛错（由管线走修复/降级）', () => {
    expect(() => extractJson('这不是 JSON')).toThrow();
    expect(validateResult({ outline: [], sections: [] }, 100)).toBeNull();
  });
});
