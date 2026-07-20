/**
 * 弹幕采样（PRD F-02）：按分钟分桶，每分钟取若干条代表性弹幕，
 * 作为 AI 分析的「高光定位」辅助上下文（不作为主要内容来源）。
 *
 * 数据源：旧版 XML 接口（SW 无 DOMParser，用正则解析）：
 *   主：https://comment.bilibili.com/{cid}.xml
 *   备：https://api.bilibili.com/x/v1/dm/list.so?oid={cid}
 * 纯 TS（fetch 可注入），可单测。
 */
import { BiliApiError, type BiliClientOptions } from './api';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

export interface DanmakuItem {
  /** 秒（视频内时间） */
  t: number;
  text: string;
}

export interface DanmakuSampleResult {
  samples: DanmakuItem[];
  /** 解析到的有效弹幕总数（去重后、采样前） */
  total: number;
}

export interface DanmakuSampleOptions extends BiliClientOptions {
  /** 每分钟最多取几条，默认 3 */
  perMinute?: number;
  /** 总采样上限，默认 200 */
  maxTotal?: number;
}

/** 解码 XML 实体（&amp; 必须最后处理，避免二次解码） */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

const D_RE = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;

/**
 * 解析弹幕 XML：`<d p="时间,模式,字号,...">文本</d>`（p 第一个字段为秒）。
 * 纯函数，直接可测。
 */
export function parseDanmakuXml(xml: string): DanmakuItem[] {
  const out: DanmakuItem[] = [];
  D_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = D_RE.exec(xml)) !== null) {
    const t = Number(m[1].split(',')[0]);
    const text = decodeXmlEntities(m[2]).trim();
    if (!Number.isFinite(t) || !text) continue;
    out.push({ t, text });
  }
  return out;
}

/**
 * 分桶采样：按分钟分桶，每桶按文本长度降序取 perMinute 条（长文本信息量大），
 * 结果按时间升序，整体不超过 maxTotal。纯函数，直接可测。
 */
export function sampleDanmaku(
  items: DanmakuItem[],
  opts?: { perMinute?: number; maxTotal?: number },
): DanmakuItem[] {
  const perMinute = opts?.perMinute ?? 3;
  const maxTotal = opts?.maxTotal ?? 200;

  // 去重（同文本只保留最早一条）并过滤空文本
  const seen = new Set<string>();
  const unique = items.filter((d) => {
    const key = d.text;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const buckets = new Map<number, DanmakuItem[]>();
  for (const d of unique) {
    const minute = Math.floor(d.t / 60);
    const bucket = buckets.get(minute);
    if (bucket) bucket.push(d);
    else buckets.set(minute, [d]);
  }

  const picked: DanmakuItem[] = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.text.length - a.text.length);
    picked.push(...bucket.slice(0, perMinute));
  }
  picked.sort((a, b) => a.t - b.t);
  return picked.slice(0, maxTotal);
}

async function fetchXml(url: string, opts?: BiliClientOptions): Promise<string> {
  const f = opts?.fetchImpl ?? globalThis.fetch;
  if (!f) throw new BiliApiError('当前环境无可用 fetch');
  const resp = await f(url, {
    headers: { 'User-Agent': UA, Referer: REFERER },
    credentials: 'include',
  });
  if (!resp.ok) throw new BiliApiError(`HTTP ${resp.status}`, resp.status);
  return resp.text();
}

/**
 * 拉取并采样弹幕。主接口失败时回退备用接口；两者都失败抛 BiliApiError。
 */
export async function getDanmakuSample(
  cid: number,
  opts?: DanmakuSampleOptions,
): Promise<DanmakuSampleResult> {
  let xml: string;
  try {
    xml = await fetchXml(`https://comment.bilibili.com/${cid}.xml`, opts);
  } catch {
    xml = await fetchXml(
      `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
      opts,
    );
  }
  const all = parseDanmakuXml(xml);
  const seen = new Set<string>();
  const total = all.filter((d) => {
    if (seen.has(d.text)) return false;
    seen.add(d.text);
    return true;
  }).length;
  return { samples: sampleDanmaku(all, opts), total };
}
