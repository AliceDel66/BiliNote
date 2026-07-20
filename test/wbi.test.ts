import { describe, expect, it } from 'vitest';
import { getMixinKey, md5Hex, signWbi } from '../lib/bilibili/wbi';

describe('wbi 签名', () => {
  it('mixin key 社区公开测试向量', () => {
    // 来自 bilibili-API-collect 文档的知名测试向量
    const imgKey = '7cd084941338484aae1ad9425b84077c';
    const subKey = '4932caff0ff746eab6f01bf08b70ac45';
    expect(getMixinKey(imgKey, subKey)).toBe('ea1db124af3c7062474693fa704f4ff8');
  });

  it('md5Hex 正确性', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('signWbi：参数按 key 排序、附带 wts、w_rid 可复算', () => {
    const imgKey = '7cd084941338484aae1ad9425b84077c';
    const subKey = '4932caff0ff746eab6f01bf08b70ac45';
    const wts = 1700000000;
    const { query, signedQuery, wRid } = signWbi(
      { bvid: 'BV1xx411c7mD', cid: 123, aid: 456 },
      imgKey,
      subKey,
      wts,
    );
    // 排序：aid < bvid < cid < wts
    expect(query).toBe('aid=456&bvid=BV1xx411c7mD&cid=123&wts=1700000000');
    const mixinKey = getMixinKey(imgKey, subKey);
    expect(wRid).toBe(md5Hex(query + mixinKey));
    expect(signedQuery).toBe(`${query}&w_rid=${wRid}`);
    expect(wRid).toMatch(/^[0-9a-f]{32}$/);
  });

  it('signWbi：过滤特殊字符并 URL 编码', () => {
    const { query } = signWbi(
      { foo: "a!b'c(d)e*f 中文" },
      'a'.repeat(32),
      'b'.repeat(32),
      1700000000,
    );
    expect(query.startsWith('foo=abcdef%20%E4%B8%AD%E6%96%87&wts=')).toBe(true);
  });
});
