/**
 * ChatContext 组装（讨论稿 §3.3 / §5.3）：
 * 纯函数，数据全部由调用方（background）注入，不直接访问存储 / 网络。
 * 首轮基线：±60s 字幕窗口 + 紧凑大纲 + 当前章节 + ≤5 条重点 + 笔记摘录 + 当前话题最近 ≤6 轮。
 */
import type { Cue } from '../bilibili/types';
import type { AnalysisResult } from '../summarize/types';
import { formatTimestamp } from '../types';
import type { ChatSnapshot, Completeness } from './types';

/** 字幕窗口半径（秒），讨论稿 §5.3 */
export const SUBTITLE_WINDOW_SEC = 60;
export const NOTE_EXCERPT_MAX_CHARS = 800;
export const RECENT_TURNS_MAX = 6;
export const RECENT_ANSWER_MAX_CHARS = 200;
export const KEY_POINTS_MAX = 5;

export interface RecentTurn {
  question: string;
  answerMd: string;
}

/**
 * 数据边界开关（ABC 混合策略 · A 默认最小暴露，全 true 即现状行为）。
 * C 面板在设置页逐源控制；跨域源（MCP 等）落地时走 B 授权记忆流程。
 */
export interface PrivacyToggles {
  /** 允许发送当前时间窗口字幕（关闭后按无字幕降级回答） */
  sendSubtitles: boolean;
  /** 允许发送当前笔记摘录 */
  sendNoteExcerpt: boolean;
  /** 允许发送播放元信息（视频标题 / 页面 URL） */
  sendPlaybackMeta: boolean;
}

export const DEFAULT_PRIVACY: PrivacyToggles = {
  sendSubtitles: true,
  sendNoteExcerpt: true,
  sendPlaybackMeta: true,
};

export interface ChatContextInput {
  snapshot: ChatSnapshot;
  /** 当前 cid 的完整字幕（无则 undefined） */
  cues?: Cue[];
  /** 当前 cid 的缓存分析结果（无则 null/undefined） */
  analysis?: AnalysisResult | null;
  /** 当前 cid 目标笔记全文（无则 undefined） */
  noteContent?: string;
  /** 当前话题最近若干轮（按时间升序） */
  recentTurns?: RecentTurn[];
  /** 数据边界开关（默认 A：全允许 = 最小暴露基线） */
  privacy?: PrivacyToggles;
}

export interface ChatContext {
  snapshot: ChatSnapshot;
  /** ±60s 窗口内字幕，逐行 `[mm:ss] 文本`；无字幕为空串 */
  subtitleWindow: string;
  /** 紧凑版全课大纲：`- mm:ss 标题` 逐行 */
  compactOutline?: string;
  /** 播放时间所在章节（含要点） */
  currentSection?: { title: string; points: string[] };
  /** 重点 / 难点简表（≤5 条） */
  keyPointsBrief?: string[];
  /** 当前笔记摘录（≤800 字符） */
  noteExcerpt?: string;
  /** 当前话题最近 ≤6 轮（回答截断到 200 字符） */
  recentTurns: RecentTurn[];
  completeness: Completeness;
}

/** 选取 playbackTime ±windowSec 内有交集的 cue，拼成带时间戳的文本 */
export function selectSubtitleWindow(
  cues: Cue[],
  playbackTime: number,
  windowSec = SUBTITLE_WINDOW_SEC,
): string {
  const from = Math.max(0, playbackTime - windowSec);
  const to = playbackTime + windowSec;
  return cues
    .filter((c) => c.end >= from && c.start <= to)
    .map((c) => `[${formatTimestamp(c.start)}] ${c.text}`)
    .join('\n');
}

/** 播放时间所在的章节：start ≤ t 的最后一个章节 */
export function findCurrentSection(
  analysis: AnalysisResult | null | undefined,
  playbackTime: number,
): { title: string; points: string[] } | undefined {
  const sections = analysis?.sections;
  if (!sections || sections.length === 0) return undefined;
  let hit: (typeof sections)[number] | undefined;
  for (const s of sections) {
    if (s.start <= playbackTime) hit = s;
    else break;
  }
  if (!hit) return undefined;
  return { title: hit.title, points: hit.points };
}

export function detectCompleteness(
  cues: Cue[] | undefined,
  analysis: AnalysisResult | null | undefined,
): Completeness {
  if (analysis) return 'full';
  if (cues && cues.length > 0) return 'partial';
  return 'none';
}

export function buildChatContext(input: ChatContextInput): ChatContext {
  const { snapshot, cues, analysis, noteContent, recentTurns } = input;
  const privacy = input.privacy ?? DEFAULT_PRIVACY;
  // 字幕开关关闭 = 课程内容整体不出本地：字幕窗口与字幕衍生的大纲/章节/重点全部省略，
  // 完整度按 none 降级（Prompt 明示无法核对讲师原意）
  const courseContentAllowed = privacy.sendSubtitles;
  const ctx: ChatContext = {
    snapshot: privacy.sendPlaybackMeta
      ? snapshot
      : { ...snapshot, title: '', pageUrl: '' },
    subtitleWindow:
      courseContentAllowed && cues
        ? selectSubtitleWindow(cues, snapshot.playbackTime)
        : '',
    recentTurns: (recentTurns ?? []).slice(-RECENT_TURNS_MAX).map((t) => ({
      question: t.question,
      answerMd: t.answerMd.slice(0, RECENT_ANSWER_MAX_CHARS),
    })),
    completeness: courseContentAllowed ? detectCompleteness(cues, analysis) : 'none',
  };

  if (courseContentAllowed && analysis && !analysis.rawMarkdown) {
    if (analysis.outline.length > 0) {
      ctx.compactOutline = analysis.outline
        .map((o) => `- ${formatTimestamp(o.time)} ${o.title}`)
        .join('\n');
    }
    ctx.currentSection = findCurrentSection(analysis, snapshot.playbackTime);
    if (analysis.keyPoints.length > 0) {
      ctx.keyPointsBrief = analysis.keyPoints
        .slice(0, KEY_POINTS_MAX)
        .map((k) => k.point);
    }
  }

  if (privacy.sendNoteExcerpt && noteContent) {
    const trimmed = noteContent.trim();
    if (trimmed) ctx.noteExcerpt = trimmed.slice(0, NOTE_EXCERPT_MAX_CHARS);
  }

  return ctx;
}
