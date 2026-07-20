import { describe, expect, it } from 'vitest';
import {
  decodeXmlEntities,
  getDanmakuSample,
  parseDanmakuXml,
  sampleDanmaku,
  type DanmakuItem,
} from '../lib/bilibili';

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <d p="12.5,1,25,16777215,1700000000,0,abc,1">第一条</d>
  <d p="20.0,1,25,16777215,1700000001,0,abc,2">HTML &amp; &lt;转义&gt; &quot;引号&quot; &#39;撇号&#39;</d>
  <d p="30.0,1,25,16777215,1700000002,0,abc,3">   </d>
  <d p="65.0,1,25,16777215,1700000003,0,abc,4">第二分钟的弹幕内容比较长一些</d>
  <d p="70.0,1,25,16777215,1700000004,0,abc,5">短</d>
  <d p="75.0,1,25,16777215,1700000005,0,abc,6">中等长度的弹幕</d>
  <d p="80.0,1,25,16777215,1700000006,0,abc,7">第二分钟的弹幕内容比较长一些</d>
  <d p="not-a-number,1,25,16777215,1700000007,0,abc,8">坏时间</d>
</i>`;

describe('decodeXmlEntities', () => {
  it('命名与数值实体；&amp; 最后处理避免二次解码', () => {
    expect(decodeXmlEntities('&lt;a&gt; &amp; &quot;b&quot; &#39;c&#39;')).toBe(
      '<a> & "b" \'c\'',
    );
    expect(decodeXmlEntities('&amp;lt;')).toBe('&lt;');
  });
});

describe('parseDanmakuXml', () => {
  it('解析 <d p="秒,...">文本</d>，丢弃空文本与非法时间', () => {
    const items = parseDanmakuXml(FIXTURE_XML);
    expect(items).toHaveLength(6);
    expect(items[0]).toEqual({ t: 12.5, text: '第一条' });
    expect(items[1].text).toBe('HTML & <转义> "引号" \'撇号\'');
    expect(items.some((d) => d.text === '坏时间')).toBe(false);
    expect(items.some((d) => d.text.trim() === '')).toBe(false);
  });
});

describe('sampleDanmaku 分桶采样', () => {
  const items = parseDanmakuXml(FIXTURE_XML);

  it('每分钟最多 perMinute 条，长文本优先，结果按时间升序', () => {
    const picked = sampleDanmaku(items, { perMinute: 1, maxTotal: 200 });
    // 第 0 分钟：'第一条'(3) vs 'HTML & <转义> "引号" \'撇号\''(长) → 取长者
    // 第 1 分钟：去重后 3 条，取最长 1 条
    expect(picked).toHaveLength(2);
    expect(picked[0].t).toBe(20);
    expect(picked[1].text).toBe('第二分钟的弹幕内容比较长一些');
    expect(picked[0].t).toBeLessThan(picked[1].t);
  });

  it('同文本去重（保留最早一条）', () => {
    const picked = sampleDanmaku(items, { perMinute: 10, maxTotal: 200 });
    const texts = picked.map((d) => d.text);
    expect(new Set(texts).size).toBe(texts.length);
    // t=80 的重复文本被去除，保留 t=65 的
    const dup = picked.find((d) => d.text === '第二分钟的弹幕内容比较长一些');
    expect(dup?.t).toBe(65);
  });

  it('maxTotal 总量上限', () => {
    const many: DanmakuItem[] = Array.from({ length: 100 }, (_, i) => ({
      t: i * 10,
      text: `弹幕${i}`,
    }));
    const picked = sampleDanmaku(many, { perMinute: 10, maxTotal: 5 });
    expect(picked).toHaveLength(5);
  });
});

describe('getDanmakuSample（mock fetch）', () => {
  it('主接口成功：只请求 comment.bilibili.com', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      urls.push(String(url));
      return new Response(FIXTURE_XML, { status: 200 });
    }) as typeof fetch;
    const r = await getDanmakuSample(123, { fetchImpl, perMinute: 1 });
    expect(urls).toEqual(['https://comment.bilibili.com/123.xml']);
    expect(r.total).toBe(5); // 6 条有效 - 1 条重复
    expect(r.samples.length).toBeGreaterThan(0);
  });

  it('主接口失败：回退 api.bilibili.com/x/v1/dm/list.so', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('comment.bilibili.com')) {
        return new Response('blocked', { status: 403 });
      }
      return new Response(FIXTURE_XML, { status: 200 });
    }) as typeof fetch;
    const r = await getDanmakuSample(456, { fetchImpl, perMinute: 2 });
    expect(urls).toEqual([
      'https://comment.bilibili.com/456.xml',
      'https://api.bilibili.com/x/v1/dm/list.so?oid=456',
    ]);
    expect(r.total).toBe(5);
  });

  it('两个接口都失败 → 抛错', async () => {
    const fetchImpl = (async () => new Response('x', { status: 500 })) as typeof fetch;
    await expect(getDanmakuSample(1, { fetchImpl })).rejects.toThrow();
  });
});
