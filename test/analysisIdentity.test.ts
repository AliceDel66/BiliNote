import { describe, expect, it } from 'vitest';
import { canSaveAnalysisToVideo, isStaleAnalyzeEvent } from '../lib/summarize';

// C1：ANALYZE_PORT 事件携带 {bvid, cid, p}；切视频后旧端口的迟到事件必须整体丢弃，
// 防止 A 视频的分析结果落到 B 视频（笔记 / 结果视图）。
describe('isStaleAnalyzeEvent（分析事件身份校验）', () => {
  const current = { bvid: 'BV1a', cid: 100 };

  it('事件不带身份字段（chunk 进度 / 旧版本后台）→ 不拦截', () => {
    expect(isStaleAnalyzeEvent({}, current)).toBe(false);
    expect(isStaleAnalyzeEvent({}, null)).toBe(false);
  });

  it('bvid 不匹配 → 丢弃（切视频后旧端口迟到）', () => {
    expect(isStaleAnalyzeEvent({ bvid: 'BV1b', cid: 100 }, current)).toBe(true);
  });

  it('bvid 匹配但 cid 不匹配 → 丢弃（同视频不同分P）', () => {
    expect(isStaleAnalyzeEvent({ bvid: 'BV1a', cid: 200 }, current)).toBe(true);
  });

  it('bvid + cid 均匹配 → 接受', () => {
    expect(isStaleAnalyzeEvent({ bvid: 'BV1a', cid: 100 }, current)).toBe(false);
  });

  it('当前无视频上下文 → 带身份的事件一律丢弃', () => {
    expect(isStaleAnalyzeEvent({ bvid: 'BV1a', cid: 100 }, null)).toBe(true);
    expect(isStaleAnalyzeEvent({ cid: 100 }, null)).toBe(true);
  });

  it('仅带 bvid 且匹配 → 接受（cid 缺省不参与校验）', () => {
    expect(isStaleAnalyzeEvent({ bvid: 'BV1a' }, current)).toBe(false);
  });
});

// saveAsNote 身份守卫：结果与当前视频 bvid + cid 完全一致才允许保存。
describe('canSaveAnalysisToVideo（存为笔记身份守卫）', () => {
  const current = { bvid: 'BV1a', cid: 100 };

  it('结果与当前视频一致 → 允许', () => {
    expect(canSaveAnalysisToVideo({ bvid: 'BV1a', cid: 100 }, current)).toBe(true);
  });

  it('bvid 不一致 → 拒绝（A 视频结果存成 B 的笔记）', () => {
    expect(canSaveAnalysisToVideo({ bvid: 'BV1b', cid: 100 }, current)).toBe(false);
  });

  it('cid 不一致 → 拒绝（分P 已切换）', () => {
    expect(canSaveAnalysisToVideo({ bvid: 'BV1a', cid: 200 }, current)).toBe(false);
  });

  it('结果或当前上下文缺失 → 拒绝', () => {
    expect(canSaveAnalysisToVideo(null, current)).toBe(false);
    expect(canSaveAnalysisToVideo(undefined, current)).toBe(false);
    expect(canSaveAnalysisToVideo({ bvid: 'BV1a', cid: 100 }, null)).toBe(false);
  });
});
