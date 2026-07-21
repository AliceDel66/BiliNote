// 学习事件统一层测试：本地时区日分桶 + 三类表 → StudyEvent
// 时区安全：所有时间戳用本地 Date 构造器生成，dayKey 同样走本地时区，任意 TZ 下一致。
import { describe, expect, it } from 'vitest';
import { addDays, collectEvents, dayKey, parseDay } from '../lib/stats/events';

describe('dayKey 本地日分桶', () => {
  it('同一本地日的早晚时刻归为同一天', () => {
    expect(dayKey(new Date(2026, 0, 15, 0, 30).getTime())).toBe('2026-01-15');
    expect(dayKey(new Date(2026, 0, 15, 12, 0).getTime())).toBe('2026-01-15');
    expect(dayKey(new Date(2026, 0, 15, 23, 59).getTime())).toBe('2026-01-15');
  });

  it('跨午夜分为不同天', () => {
    expect(dayKey(new Date(2026, 0, 15, 23, 59).getTime())).toBe('2026-01-15');
    expect(dayKey(new Date(2026, 0, 16, 0, 1).getTime())).toBe('2026-01-16');
  });

  it('跨月/跨年且月日零填充', () => {
    expect(dayKey(new Date(2026, 11, 31, 23, 59).getTime())).toBe('2026-12-31');
    expect(dayKey(new Date(2027, 0, 1, 0, 0).getTime())).toBe('2027-01-01');
    expect(dayKey(new Date(2026, 2, 5, 9).getTime())).toBe('2026-03-05');
  });
});

describe('parseDay / addDays', () => {
  it('parseDay 回到本地零点，与 dayKey 互逆', () => {
    expect(dayKey(parseDay('2026-06-21').getTime())).toBe('2026-06-21');
  });

  it('addDays 跨月/跨年安全', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-06-21', -181)).toBe('2025-12-22');
  });
});

describe('collectEvents', () => {
  it('三类表统一为事件，按日期升序，带 bvid 归属', () => {
    const events = collectEvents({
      summaries: [{ bvid: 'BV1', createdAt: new Date(2026, 5, 20, 10).getTime() }],
      notes: [
        { bvid: 'BV1', createdAt: new Date(2026, 5, 21, 9).getTime() },
        { bvid: 'BV2', createdAt: new Date(2026, 5, 19, 9).getTime() },
      ],
      chatTurns: [
        { createdAt: new Date(2026, 5, 21, 11).getTime(), status: 'done', bvid: 'BV2' },
      ],
    });
    // 06-19 note → 06-20 analyze → 06-21 note → 06-21 qa
    expect(events.map((e) => [e.day, e.kind])).toEqual([
      ['2026-06-19', 'note'],
      ['2026-06-20', 'analyze'],
      ['2026-06-21', 'note'],
      ['2026-06-21', 'qa'],
    ]);
    expect(events[3].bvid).toBe('BV2');
  });

  it('仅 status=done 的问答计为事件（streaming/cancelled/error 排除）', () => {
    const t = (status: string) => ({
      createdAt: new Date(2026, 5, 21, 12).getTime(),
      status,
    });
    const events = collectEvents({
      summaries: [],
      notes: [],
      chatTurns: [t('done'), t('streaming'), t('cancelled'), t('error')],
    });
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('qa');
  });

  it('笔记事件取 createdAt（编辑旧的 updatedAt 不影响）', () => {
    const events = collectEvents({
      summaries: [],
      notes: [{ bvid: 'BV1', createdAt: new Date(2026, 0, 5, 10).getTime() }],
      chatTurns: [],
    });
    expect(events).toEqual([{ day: '2026-01-05', kind: 'note', bvid: 'BV1' }]);
  });

  it('空输入返回空数组', () => {
    expect(collectEvents({ summaries: [], notes: [], chatTurns: [] })).toEqual([]);
  });
});
