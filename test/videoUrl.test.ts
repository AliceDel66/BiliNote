import { describe, expect, it } from 'vitest';
import { parseVideoUrl } from '../lib/bilibili/url';

describe('parseVideoUrl', () => {
  it('标准播放页（无分 P 参数）', () => {
    expect(parseVideoUrl('https://www.bilibili.com/video/BV1hv411x7we/')).toEqual({
      bvid: 'BV1hv411x7we',
      p: 1,
    });
  });

  it('带分 P 与追踪参数', () => {
    expect(
      parseVideoUrl(
        'https://bilibili.com/video/BV1hv411x7we/?spm_id_from=333.1387&p=3&vd_source=abc',
      ),
    ).toEqual({ bvid: 'BV1hv411x7we', p: 3 });
  });

  it('p 非法时回退为 1', () => {
    expect(parseVideoUrl('https://www.bilibili.com/video/BV1xx?p=0')?.p).toBe(1);
    expect(parseVideoUrl('https://www.bilibili.com/video/BV1xx?p=abc')?.p).toBe(1);
  });

  it('非视频页返回 null', () => {
    expect(parseVideoUrl('https://www.bilibili.com/')).toBeNull();
    expect(parseVideoUrl('https://www.bilibili.com/bangumi/play/ep123')).toBeNull();
  });

  it('非法 URL 返回 null', () => {
    expect(parseVideoUrl('not-a-url')).toBeNull();
    expect(parseVideoUrl('')).toBeNull();
  });
});
