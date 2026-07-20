import { describe, expect, it } from 'vitest';
import type { Cue } from '../lib/bilibili/types';
import type { AnalysisResult } from '../lib/summarize/types';
import {
  buildChatContext,
  detectCompleteness,
  findCurrentSection,
  selectSubtitleWindow,
  assembleUserMessage,
  fitContextToBudget,
  type ChatSnapshot,
} from '../lib/chat';
import { estimateTokens } from '../lib/summarize';

const snapshot: ChatSnapshot = {
  bvid: 'BV1test',
  cid: 123,
  p: 2,
  title: '测试课程',
  playbackTime: 300,
  pageUrl: 'https://www.bilibili.com/BV1test?p=2',
};

/** 每 30s 一条 cue：t0=00:00 … t20=10:00 */
function makeCues(): Cue[] {
  return Array.from({ length: 21 }, (_, i) => ({
    start: i * 30,
    end: i * 30 + 5,
    text: `t${i}`,
  }));
}

const analysis: AnalysisResult = {
  outline: [
    { title: '开场', time: 0 },
    { title: '内存管理', time: 240 },
    { title: '总结', time: 600 },
  ],
  sections: [
    { title: '开场', start: 0, end: 240, points: ['介绍'] },
    { title: '内存管理', start: 240, end: 600, points: ['栈', '堆'] },
  ],
  keyPoints: [
    { point: '指针', explanation: '...', time: 300 },
    { point: '引用', explanation: '...' },
  ],
  extensions: [],
  caveats: [],
};

describe('selectSubtitleWindow（±60s 时间邻域）', () => {
  it('只取窗口内有交集的 cue，带 mm:ss 标记', () => {
    const win = selectSubtitleWindow(makeCues(), 300);
    // [240, 360] → t8(04:00)…t12(06:00)
    expect(win).toContain('[04:00] t8');
    expect(win).toContain('[06:00] t12');
    expect(win).not.toContain('t7');
    expect(win).not.toContain('t13');
  });

  it('视频开头不越过 0 边界', () => {
    const win = selectSubtitleWindow(makeCues(), 10);
    expect(win).toContain('[00:00] t0');
    expect(win).toContain('[01:00] t2'); // start=60 ≤ 70 仍在窗口
    expect(win).not.toContain('t3');
  });
});

describe('completeness 检测（§5.1）', () => {
  it('full / partial / none', () => {
    expect(detectCompleteness(makeCues(), analysis)).toBe('full');
    expect(detectCompleteness(makeCues(), null)).toBe('partial');
    expect(detectCompleteness(undefined, null)).toBe('none');
    expect(detectCompleteness([], undefined)).toBe('none');
  });
});

describe('buildChatContext', () => {
  it('组装窗口字幕 / 紧凑大纲 / 当前章节 / 重点 / 笔记摘录 / 最近轮次', () => {
    const ctx = buildChatContext({
      snapshot,
      cues: makeCues(),
      analysis,
      noteContent: '  我的笔记内容  ',
      recentTurns: Array.from({ length: 8 }, (_, i) => ({
        question: `q${i}`,
        answerMd: `a${i}${'x'.repeat(500)}`,
      })),
    });
    expect(ctx.completeness).toBe('full');
    expect(ctx.subtitleWindow).toContain('[05:00] t10');
    expect(ctx.compactOutline).toContain('- 04:00 内存管理');
    expect(ctx.currentSection?.title).toBe('内存管理');
    expect(ctx.keyPointsBrief).toEqual(['指针', '引用']);
    expect(ctx.noteExcerpt).toBe('我的笔记内容');
    // 最近 ≤6 轮，回答截断 200 字符
    expect(ctx.recentTurns).toHaveLength(6);
    expect(ctx.recentTurns[0].question).toBe('q2');
    expect(ctx.recentTurns[0].answerMd.length).toBe(200);
  });

  it('笔记摘录超过 800 字符时截断', () => {
    const ctx = buildChatContext({
      snapshot,
      cues: makeCues(),
      noteContent: 'n'.repeat(1200),
    });
    expect(ctx.noteExcerpt).toHaveLength(800);
  });

  it('findCurrentSection：取 start ≤ t 的最后一章', () => {
    expect(findCurrentSection(analysis, 300)?.title).toBe('内存管理');
    expect(findCurrentSection(analysis, 0)?.title).toBe('开场');
    expect(findCurrentSection(null, 300)).toBeUndefined();
  });
});

describe('上下文预算裁剪（§5.3：noteExcerpt → keyPointsBrief → outline）', () => {
  const question = '这里为什么？';

  function fatCtx() {
    return buildChatContext({
      snapshot,
      cues: makeCues(),
      analysis,
      noteContent: `笔记${'很'.repeat(300)}`,
    });
  }

  it('预算足够时不裁剪', () => {
    const ctx = fatCtx();
    const fitted = fitContextToBudget(ctx, question, 100000);
    expect(fitted.noteExcerpt).toBeDefined();
    expect(fitted.keyPointsBrief).toBeDefined();
    expect(fitted.compactOutline).toBeDefined();
  });

  it('先砍笔记摘录，保留重点与大纲', () => {
    const ctx = fatCtx();
    const withoutNote = assembleUserMessage({ ...ctx, noteExcerpt: undefined }, question);
    const budget = estimateTokens(withoutNote);
    const fitted = fitContextToBudget(ctx, question, budget);
    expect(fitted.noteExcerpt).toBeUndefined();
    expect(fitted.keyPointsBrief).toBeDefined();
    expect(fitted.compactOutline).toBeDefined();
  });

  it('极小预算按顺序全部裁掉，但窗口字幕与播放快照保留', () => {
    const ctx = fatCtx();
    const fitted = fitContextToBudget(ctx, question, 1);
    expect(fitted.noteExcerpt).toBeUndefined();
    expect(fitted.keyPointsBrief).toBeUndefined();
    expect(fitted.compactOutline).toBeUndefined();
    expect(fitted.subtitleWindow).toBe(ctx.subtitleWindow);
    expect(fitted.snapshot).toBe(ctx.snapshot);
  });
});
