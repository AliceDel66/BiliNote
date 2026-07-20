import { describe, expect, it } from 'vitest';
import { validateResult } from '../lib/summarize';

const DURATION = 600; // 10:00

function baseRaw(extra?: Record<string, unknown>) {
  return {
    outline: [{ title: '导论', time: '00:10' }],
    sections: [{ title: '进程概念', start: '00:00', end: '05:00', points: ['要点'] }],
    keyPoints: [{ point: 'PCB', explanation: '进程控制块', time: '01:40' }],
    ...extra,
  };
}

describe('validateResult extensions / caveats', () => {
  it('正常解析：保留合法条目', () => {
    const r = validateResult(
      baseRaw({
        extensions: [{ title: '协程', detail: '用户态轻量线程' }],
        caveats: [
          { title: '误区', detail: '说明' },
          { title: '建议', detail: '实践' },
        ],
      }),
      DURATION,
    );
    expect(r).not.toBeNull();
    expect(r!.extensions).toEqual([{ title: '协程', detail: '用户态轻量线程' }]);
    expect(r!.caveats).toEqual([
      { title: '误区', detail: '说明' },
      { title: '建议', detail: '实践' },
    ]);
  });

  it('字段缺失 → 默认 []（兼容旧缓存结果）', () => {
    const r = validateResult(baseRaw(), DURATION);
    expect(r!.extensions).toEqual([]);
    expect(r!.caveats).toEqual([]);
  });

  it('字段非数组 → 默认 []', () => {
    const r = validateResult(
      baseRaw({ extensions: 'oops', caveats: 42 }),
      DURATION,
    );
    expect(r!.extensions).toEqual([]);
    expect(r!.caveats).toEqual([]);
  });

  it('坏条目丢弃：title/detail 缺失、非字符串或空白', () => {
    const r = validateResult(
      baseRaw({
        extensions: [
          { title: '合法', detail: '保留' },
          { title: '', detail: '空标题' },
          { title: '   ', detail: '空白标题' },
          { title: '缺 detail' },
          { detail: '缺 title' },
          { title: 1, detail: '非字符串' },
          { title: 'detail 空白', detail: '  ' },
          'not-an-object',
          null,
        ],
      }),
      DURATION,
    );
    expect(r!.extensions).toEqual([{ title: '合法', detail: '保留' }]);
  });

  it('超长裁剪：title ≤ 60 字，detail ≤ 300 字', () => {
    const r = validateResult(
      baseRaw({
        caveats: [{ title: 't'.repeat(100), detail: 'd'.repeat(400) }],
      }),
      DURATION,
    );
    expect(r!.caveats[0].title).toHaveLength(60);
    expect(r!.caveats[0].detail).toHaveLength(300);
  });
});

describe('validateResult 时间戳越界校验（回归）', () => {
  it('outline / sections / keyPoints 的越界时间戳处理不受影响', () => {
    const r = validateResult(
      {
        outline: [
          { title: '合法', time: '09:59' },
          { title: '越界', time: '10:01' },
          { title: '负值', time: -1 },
        ],
        sections: [
          { title: 's1', start: '00:00', end: '10:00', points: [] },
          { title: '越界段', start: '11:00', end: '12:00', points: [] },
        ],
        keyPoints: [
          { point: 'k1', explanation: '', time: '10:00' },
          { point: 'k2', explanation: '', time: '10:01' },
        ],
      },
      DURATION,
    );
    expect(r).not.toBeNull();
    expect(r!.outline).toEqual([{ title: '合法', time: 599 }]);
    expect(r!.sections.map((s) => s.title)).toEqual(['s1']);
    expect(r!.keyPoints).toEqual([
      { point: 'k1', explanation: '', time: 600 },
      { point: 'k2', explanation: '' },
    ]);
    // 新字段在旧结构数据上默认 []
    expect(r!.extensions).toEqual([]);
    expect(r!.caveats).toEqual([]);
  });

  it('outline 与 sections 全空 → null（触发修复重试）', () => {
    expect(
      validateResult({ outline: [], sections: [], keyPoints: [] }, DURATION),
    ).toBeNull();
    expect(validateResult('not-json-object', DURATION)).toBeNull();
  });
});
