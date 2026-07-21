/**
 * 「我的」Tab 统计聚合（纯函数，无副作用；日期相关全部经 now 参数注入以便测试）。
 * 输入为 events.ts 统一后的 StudyEvent + videos/summaries 表行（结构化最小子集）。
 */
import { addDays, dayKey, type StudyEvent } from './events';

/** 热力图周数：最近 26 周（含今天，共 26*7 = 182 天） */
export const HEAT_WEEKS = 26;
/** 洞察窗口：最近 7 天（今天 + 前 6 天） */
export const INSIGHT_DAYS = 7;
/** 课程进度条数上限 */
export const COURSE_PROGRESS_LIMIT = 5;

export interface VideoStatInput {
  bvid: string;
  title: string;
  parts: readonly { cid: number; duration: number }[];
  lastViewedAt: number;
}

export interface SummaryStatInput {
  bvid: string;
  cid: number;
  createdAt: number;
}

export interface StatsTotals {
  /** 分析过的视频数（summaries 中 distinct bvid） */
  analyzedVideos: number;
  /** 分析过的分 P 数（summaries 中 distinct bvid+cid） */
  analyzedParts: number;
  /** 累计笔记数（note 事件数） */
  notes: number;
  /** 累计问答轮数（done 的 qa 事件数） */
  qaTurns: number;
  /** 累计学习时长（分钟）：仅已分析 cid 对应分 P 的 duration 合计 / 60，四舍五入 */
  coveredMinutes: number;
}

export interface Streaks {
  current: number;
  longest: number;
}

export interface CourseProgress {
  bvid: string;
  title: string;
  analyzedParts: number;
  totalParts: number;
  lastViewedAt: number;
}

export interface StatsInsights {
  weekNotes: number;
  weekQa: number;
  topCourse: { title: string; events: number } | null;
}

export interface StudyStats {
  totals: StatsTotals;
  streaks: Streaks;
  /** 最近 26 周逐日活动数：恰好 182 项，按日期升序（首项 = 今天-181，末项 = 今天），无活动日为 0 */
  daily: Map<string, number>;
  courseProgress: CourseProgress[];
  insights: StatsInsights;
}

/**
 * 连续天数规则：
 * - 一天有 ≥1 个事件即记为活跃；
 * - current 从今天往前数；若今天还没有活动，则等于「截至昨天的连续天数」
 *   （今天还没学习不清零，给用户留当天补学的余地）；昨天也无活动则为 0；
 * - longest 为全部历史中的最长连续活跃天数。
 */
function computeStreaks(events: readonly StudyEvent[], today: string): Streaks {
  const activeDays = new Set(events.map((e) => e.day));
  let current = 0;
  let cursor = activeDays.has(today) ? today : addDays(today, -1);
  while (activeDays.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  const sorted = [...activeDays].sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    run = prev !== null && addDays(prev, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }
  return { current, longest };
}

export function computeStats(
  events: readonly StudyEvent[],
  videos: readonly VideoStatInput[],
  summaries: readonly SummaryStatInput[],
  now: Date = new Date(),
): StudyStats {
  const today = dayKey(now.getTime());

  // ---- 已分析集合（distinct）----
  const analyzedBvids = new Set<string>();
  const analyzedCidByVideo = new Map<string, Set<number>>();
  for (const s of summaries) {
    analyzedBvids.add(s.bvid);
    let set = analyzedCidByVideo.get(s.bvid);
    if (!set) {
      set = new Set();
      analyzedCidByVideo.set(s.bvid, set);
    }
    set.add(s.cid);
  }
  const analyzedParts = [...analyzedCidByVideo.values()].reduce((n, s) => n + s.size, 0);

  // ---- 累计学习时长：已分析 cid 的分 P 时长（cid 不在视频 parts 里则无法计时，计 0）----
  let coveredSeconds = 0;
  for (const v of videos) {
    const set = analyzedCidByVideo.get(v.bvid);
    if (!set) continue;
    for (const p of v.parts) {
      if (set.has(p.cid)) coveredSeconds += p.duration;
    }
  }

  const totals: StatsTotals = {
    analyzedVideos: analyzedBvids.size,
    analyzedParts,
    notes: events.filter((e) => e.kind === 'note').length,
    qaTurns: events.filter((e) => e.kind === 'qa').length,
    coveredMinutes: Math.round(coveredSeconds / 60),
  };

  const streaks = computeStreaks(events, today);

  // ---- 热力图：最近 26 周逐日计数（182 项，末项为今天）----
  const countByDay = new Map<string, number>();
  for (const e of events) {
    countByDay.set(e.day, (countByDay.get(e.day) ?? 0) + 1);
  }
  const totalDays = HEAT_WEEKS * 7;
  const daily = new Map<string, number>();
  for (let i = totalDays - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    daily.set(day, countByDay.get(day) ?? 0);
  }

  // ---- 课程进度：有分析进度的课程按最近查看排序，取前 5 ----
  const courseProgress: CourseProgress[] = videos
    .map((v) => {
      const set = analyzedCidByVideo.get(v.bvid);
      const analyzed = set ? v.parts.filter((p) => set.has(p.cid)).length : 0;
      return {
        bvid: v.bvid,
        title: v.title,
        analyzedParts: analyzed,
        totalParts: v.parts.length,
        lastViewedAt: v.lastViewedAt,
      };
    })
    .filter((p) => p.analyzedParts > 0)
    .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
    .slice(0, COURSE_PROGRESS_LIMIT);

  // ---- 活动洞察（最近 7 天，含今天）----
  const weekStart = addDays(today, -(INSIGHT_DAYS - 1));
  let weekNotes = 0;
  let weekQa = 0;
  const eventsByCourse = new Map<string, number>();
  for (const e of events) {
    if (e.day < weekStart) continue;
    if (e.kind === 'note') weekNotes += 1;
    else if (e.kind === 'qa') weekQa += 1;
    if (e.bvid) eventsByCourse.set(e.bvid, (eventsByCourse.get(e.bvid) ?? 0) + 1);
  }
  let top: { bvid: string; events: number } | null = null;
  for (const [bvid, n] of eventsByCourse) {
    if (!top || n > top.events) top = { bvid, events: n };
  }
  const insights: StatsInsights = {
    weekNotes,
    weekQa,
    topCourse: top
      ? {
          title: videos.find((v) => v.bvid === top!.bvid)?.title ?? top.bvid,
          events: top.events,
        }
      : null,
  };

  return { totals, streaks, daily, courseProgress, insights };
}
