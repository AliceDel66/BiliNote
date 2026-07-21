// 「我的」统计聚合测试：totals / streaks / daily(26 周热力图) / courseProgress / insights
// 时区安全：固定 now 为本地构造的 Date；事件 day 直接给 'YYYY-MM-DD' 字符串。
import { describe, expect, it } from 'vitest';
import { computeStats, HEAT_WEEKS, type StudyStats } from '../lib/stats/compute';
import { addDays, parseDay, type StudyEvent } from '../lib/stats/events';

/** 固定「今天」：本地 2026-06-21 中午 */
const NOW = new Date(2026, 5, 21, 12, 0, 0);
const TODAY = '2026-06-21';

const ev = (day: string, kind: StudyEvent['kind'] = 'analyze', bvid?: string): StudyEvent => ({
  day,
  kind,
  ...(bvid ? { bvid } : {}),
});

/** 本地某日某时刻的时间戳（构造 summaries.createdAt 用） */
const at = (day: string, h = 12) => parseDay(day).getTime() + h * 3600_000;

const statsOf = (
  events: StudyEvent[],
  videos: Parameters<typeof computeStats>[1] = [],
  summaries: Parameters<typeof computeStats>[2] = [],
): StudyStats => computeStats(events, videos, summaries, NOW);

describe('totals', () => {
  it('distinct 计数 + 仅已分析 cid 计入 coveredMinutes', () => {
    const videos = [
      {
        bvid: 'BV1',
        title: '课程A',
        parts: [
          { cid: 1, duration: 600 },
          { cid: 2, duration: 900 },
        ],
        lastViewedAt: 100,
      },
      { bvid: 'BV2', title: '课程B', parts: [{ cid: 5, duration: 1800 }], lastViewedAt: 200 },
    ];
    const summaries = [
      { bvid: 'BV1', cid: 1, createdAt: at('2026-06-20') },
      { bvid: 'BV1', cid: 1, createdAt: at('2026-06-21') }, // 同 cid 重复分析 → 只计 1 个分 P
      { bvid: 'BV1', cid: 999, createdAt: at('2026-06-21') }, // 计入 analyzedParts，但 parts 中无此 cid → 0 时长
      { bvid: 'BV2', cid: 5, createdAt: at('2026-06-19') },
    ];
    const events = [
      ev('2026-06-20', 'analyze', 'BV1'),
      ev('2026-06-21', 'note', 'BV1'),
      ev('2026-06-21', 'note', 'BV2'),
      ev('2026-06-21', 'qa', 'BV1'),
    ];
    const s = statsOf(events, videos, summaries);
    expect(s.totals.analyzedVideos).toBe(2);
    expect(s.totals.analyzedParts).toBe(3); // BV1: cid 1/999；BV2: cid 5
    expect(s.totals.notes).toBe(2);
    expect(s.totals.qaTurns).toBe(1);
    // (600 + 1800) / 60 = 40；未分析的 cid 2（900s）不计
    expect(s.totals.coveredMinutes).toBe(40);
  });

  it('空数据全为 0', () => {
    const s = statsOf([]);
    expect(s.totals).toEqual({
      analyzedVideos: 0,
      analyzedParts: 0,
      notes: 0,
      qaTurns: 0,
      coveredMinutes: 0,
    });
  });
});

describe('streaks 连续天数', () => {
  it('今天有活动：从今天往前数', () => {
    const s = statsOf([ev(TODAY), ev('2026-06-20'), ev('2026-06-19'), ev('2026-06-17')]);
    expect(s.streaks.current).toBe(3);
    expect(s.streaks.longest).toBe(3);
  });

  it('今天暂无活动：不清零，取截至昨天的连续天数', () => {
    const s = statsOf([ev('2026-06-20'), ev('2026-06-19')]);
    expect(s.streaks.current).toBe(2);
  });

  it('今天和昨天都无活动：current = 0', () => {
    const s = statsOf([ev('2026-06-19'), ev('2026-06-18')]);
    expect(s.streaks.current).toBe(0);
    expect(s.streaks.longest).toBe(2);
  });

  it('间断即断：昨天缺勤，current 只算今天', () => {
    const s = statsOf([ev(TODAY), ev('2026-06-19'), ev('2026-06-18'), ev('2026-06-17')]);
    expect(s.streaks.current).toBe(1);
    expect(s.streaks.longest).toBe(3);
  });

  it('longest 取全部历史（含 26 周窗口之外）', () => {
    const s = statsOf([
      ev('2025-01-01'),
      ev('2025-01-02'),
      ev('2025-01-03'),
      ev('2025-01-04'),
      ev('2025-01-05'),
      ev(TODAY),
      ev('2026-06-20'),
    ]);
    expect(s.streaks.current).toBe(2);
    expect(s.streaks.longest).toBe(5);
  });

  it('同一天多个事件只算一天', () => {
    const s = statsOf([ev(TODAY), ev(TODAY, 'note'), ev(TODAY, 'qa'), ev('2026-06-20')]);
    expect(s.streaks.current).toBe(2);
  });

  it('无事件：0 / 0', () => {
    expect(statsOf([]).streaks).toEqual({ current: 0, longest: 0 });
  });
});

describe('daily 热力图（最近 26 周）', () => {
  it('恰好 26*7 = 182 天，末项为今天，首项为今天-181', () => {
    const s = statsOf([]);
    expect(s.daily.size).toBe(HEAT_WEEKS * 7);
    const keys = [...s.daily.keys()];
    expect(keys[keys.length - 1]).toBe(TODAY);
    expect(keys[0]).toBe(addDays(TODAY, -(HEAT_WEEKS * 7 - 1)));
    expect(keys[0]).toBe('2025-12-22');
    expect([...s.daily.values()].every((n) => n === 0)).toBe(true);
  });

  it('活动计数落格，无活动日为 0，窗口外事件不入图', () => {
    const s = statsOf([ev(TODAY), ev(TODAY, 'note'), ev('2026-06-01', 'qa'), ev('2020-01-01')]);
    expect(s.daily.size).toBe(HEAT_WEEKS * 7);
    expect(s.daily.get(TODAY)).toBe(2);
    expect(s.daily.get('2026-06-01')).toBe(1);
    expect(s.daily.get('2026-06-02')).toBe(0);
    expect([...s.daily.values()].reduce((a, b) => a + b, 0)).toBe(3); // 2020 年事件不在窗口内
  });
});

describe('courseProgress 课程进度', () => {
  const makeVideo = (bvid: string, lastViewedAt: number, partCount = 2) => ({
    bvid,
    title: `课程-${bvid}`,
    parts: Array.from({ length: partCount }, (_, i) => ({ cid: i + 1, duration: 60 })),
    lastViewedAt,
  });

  it('聚合已分析分 P / 总分 P，按 lastViewedAt 倒序', () => {
    const videos = [makeVideo('BV1', 100), makeVideo('BV2', 300), makeVideo('BV3', 200, 3)];
    const summaries = [
      { bvid: 'BV1', cid: 1, createdAt: at('2026-06-10') },
      { bvid: 'BV1', cid: 2, createdAt: at('2026-06-10') },
      { bvid: 'BV2', cid: 2, createdAt: at('2026-06-10') },
      { bvid: 'BV3', cid: 1, createdAt: at('2026-06-10') },
    ];
    const s = statsOf([], videos, summaries);
    expect(s.courseProgress.map((p) => p.bvid)).toEqual(['BV2', 'BV3', 'BV1']);
    expect(s.courseProgress[2]).toMatchObject({
      analyzedParts: 2,
      totalParts: 2,
      lastViewedAt: 100,
    });
    expect(s.courseProgress[1]).toMatchObject({ analyzedParts: 1, totalParts: 3 });
  });

  it('零进度视频排除，且最多取前 5', () => {
    const videos = Array.from({ length: 6 }, (_, i) => makeVideo(`BV${i + 1}`, 1000 + i));
    const zeroProgress = makeVideo('BV0', 9999); // 最新但无分析记录
    const summaries = videos.map((v) => ({ bvid: v.bvid, cid: 1, createdAt: at('2026-06-10') }));
    const s = statsOf([], [...videos, zeroProgress], summaries);
    expect(s.courseProgress).toHaveLength(5);
    expect(s.courseProgress.map((p) => p.bvid)).toEqual(['BV6', 'BV5', 'BV4', 'BV3', 'BV2']);
    expect(s.courseProgress.find((p) => p.bvid === 'BV0')).toBeUndefined();
  });
});

describe('insights 活动洞察（最近 7 天）', () => {
  it('本周笔记/问答计数含边界日，窗口外不计', () => {
    const s = statsOf([
      ev(TODAY, 'note', 'BV1'),
      ev('2026-06-15', 'note', 'BV1'), // 窗口首日（今天-6）
      ev('2026-06-14', 'note', 'BV1'), // 窗口外
      ev('2026-06-16', 'qa', 'BV1'),
      ev('2026-06-17', 'qa', 'BV2'),
    ]);
    expect(s.insights.weekNotes).toBe(2);
    expect(s.insights.weekQa).toBe(2);
  });

  it('最常学习课程 = 窗口内事件最多的课程，标题取 videos 表', () => {
    const videos = [
      { bvid: 'BV1', title: 'TypeScript 入门', parts: [], lastViewedAt: 1 },
      { bvid: 'BV2', title: '高数', parts: [], lastViewedAt: 2 },
    ];
    const s = statsOf(
      [
        ev(TODAY, 'note', 'BV1'),
        ev('2026-06-16', 'qa', 'BV1'),
        ev('2026-06-18', 'analyze', 'BV1'),
        ev('2026-06-17', 'qa', 'BV2'),
      ],
      videos,
    );
    expect(s.insights.topCourse).toEqual({ title: 'TypeScript 入门', events: 3 });
  });

  it('窗口内无事件：topCourse = null', () => {
    const s = statsOf([ev('2026-06-14', 'analyze', 'BV1')]);
    expect(s.insights.topCourse).toBeNull();
  });

  it('videos 表缺失时标题回退为 bvid', () => {
    const s = statsOf([ev(TODAY, 'qa', 'BV-X')]);
    expect(s.insights.topCourse).toEqual({ title: 'BV-X', events: 1 });
  });
});
