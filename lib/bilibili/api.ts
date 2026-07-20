/**
 * B站 API 适配器。
 * 纯 TS（fetch 可注入），无浏览器依赖，可单测。
 * 在扩展中运行于 background worker，带 host permission，B站 cookie 随请求附带。
 */
import { getMixinKey, signWbi } from './wbi';
import type { Cue, SubtitleResult, SubtitleTrack, VideoInfo, VideoPage } from './types';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

export class BiliApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'BiliApiError';
  }
}

export interface BiliClientOptions {
  fetchImpl?: typeof fetch;
}

type FetchLike = typeof fetch;

function getFetch(opts?: BiliClientOptions): FetchLike {
  const f = opts?.fetchImpl ?? globalThis.fetch;
  if (!f) throw new BiliApiError('当前环境无可用 fetch');
  return f.bind(globalThis) as FetchLike;
}

async function biliFetchJson<T>(
  url: string,
  opts?: BiliClientOptions,
): Promise<T> {
  const f = getFetch(opts);
  let resp: Response;
  try {
    resp = await f(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      credentials: 'include',
    });
  } catch (e) {
    throw new BiliApiError(`网络请求失败: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new BiliApiError(`HTTP ${resp.status}`, resp.status);
  }
  return (await resp.json()) as T;
}

// ---------- wbi key 获取与缓存（内存缓存，24h 刷新） ----------

export interface WbiKeys {
  imgKey: string;
  subKey: string;
  fetchedAt: number;
}

const KEY_TTL = 24 * 60 * 60 * 1000;
let cachedKeys: WbiKeys | null = null;

/** 仅供测试：清空内存缓存 */
export function __clearWbiKeyCache(): void {
  cachedKeys = null;
}

function basename(url: string): string {
  const file = url.split('/').pop() ?? '';
  return file.replace(/\.[^.]*$/, '');
}

export async function getWbiKeys(opts?: BiliClientOptions): Promise<WbiKeys> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < KEY_TTL) {
    return cachedKeys;
  }
  interface NavResp {
    code: number;
    data?: { wbi_img?: { img_url?: string; sub_url?: string } };
  }
  const resp = await biliFetchJson<NavResp>(
    'https://api.bilibili.com/x/web-interface/nav',
    opts,
  );
  const imgUrl = resp.data?.wbi_img?.img_url;
  const subUrl = resp.data?.wbi_img?.sub_url;
  if (!imgUrl || !subUrl) {
    throw new BiliApiError('无法获取 wbi key（nav 接口响应异常）', resp.code);
  }
  cachedKeys = {
    imgKey: basename(imgUrl),
    subKey: basename(subUrl),
    fetchedAt: Date.now(),
  };
  return cachedKeys;
}

// ---------- 视频信息 ----------

interface ViewResp {
  code: number;
  message?: string;
  data?: {
    bvid: string;
    aid: number;
    title: string;
    pic: string;
    duration: number;
    owner?: { name?: string; mid?: number };
    pages?: { cid: number; page: number; part: string; duration: number }[];
  };
}

export async function getVideoInfo(
  bvid: string,
  opts?: BiliClientOptions,
): Promise<VideoInfo> {
  const resp = await biliFetchJson<ViewResp>(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    opts,
  );
  if (resp.code !== 0 || !resp.data) {
    throw new BiliApiError(
      `获取视频信息失败: ${resp.message ?? `code=${resp.code}`}`,
      resp.code,
    );
  }
  const d = resp.data;
  const pages: VideoPage[] = (d.pages ?? []).map((p) => ({
    cid: p.cid,
    page: p.page,
    part: p.part,
    duration: p.duration,
  }));
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    cover: d.pic,
    owner: d.owner?.name ?? '',
    ownerMid: d.owner?.mid ?? 0,
    duration: d.duration,
    pages,
  };
}

// ---------- 字幕 ----------

interface WbiV2Resp {
  code: number;
  message?: string;
  data?: {
    subtitle?: {
      subtitles?: {
        id: number;
        lan: string;
        lan_doc: string;
        subtitle_url: string;
        ai_type?: number;
        ai_status?: number;
      }[];
    };
  };
}

interface SubtitleJson {
  body?: { from: number; to: number; content: string }[];
}

/** 从 wbi/v2 响应中挑选字幕轨：优先中文人工字幕 */
export function pickSubtitleTrack(
  tracks: SubtitleTrack[],
): SubtitleTrack | null {
  if (tracks.length === 0) return null;
  const isZh = (t: SubtitleTrack) => t.lan.toLowerCase().includes('zh');
  return (
    tracks.find((t) => isZh(t) && !t.isAi) ??
    tracks.find((t) => !t.isAi) ??
    tracks.find(isZh) ??
    tracks[0]
  );
}

/** 拉取字幕轨 URL 列表（需 wbi 签名） */
export async function getSubtitleTracks(
  bvid: string,
  cid: number,
  aid?: number,
  opts?: BiliClientOptions,
): Promise<SubtitleTrack[]> {
  let realAid = aid;
  if (!realAid) {
    realAid = (await getVideoInfo(bvid, opts)).aid;
  }
  const keys = await getWbiKeys(opts);
  const { signedQuery } = signWbi(
    { aid: realAid, cid, bvid },
    keys.imgKey,
    keys.subKey,
  );
  const resp = await biliFetchJson<WbiV2Resp>(
    `https://api.bilibili.com/x/player/wbi/v2?${signedQuery}`,
    opts,
  );
  if (resp.code !== 0) {
    throw new BiliApiError(
      `获取字幕信息失败: ${resp.message ?? `code=${resp.code}`}`,
      resp.code,
    );
  }
  const subs = resp.data?.subtitle?.subtitles ?? [];
  return subs.map((s) => ({
    id: s.id,
    lan: s.lan,
    lanDoc: s.lan_doc,
    subtitleUrl: s.subtitle_url.startsWith('//')
      ? `https:${s.subtitle_url}`
      : s.subtitle_url,
    isAi:
      s.lan.toLowerCase().startsWith('ai') ||
      (s.ai_type !== undefined && s.ai_type !== 0),
  }));
}

/** 下载字幕 JSON 并归一化为 Cue[]（单位：秒） */
export async function fetchSubtitleCues(
  subtitleUrl: string,
  opts?: BiliClientOptions,
): Promise<Cue[]> {
  const json = await biliFetchJson<SubtitleJson>(subtitleUrl, opts);
  const body = json.body ?? [];
  return body
    .map((c) => ({
      start: Number(c.from),
      end: Number(c.to),
      text: String(c.content ?? '').trim(),
    }))
    .filter((c) => c.text.length > 0 && Number.isFinite(c.start));
}

/**
 * 一站式：取字幕轨（优先中文人工）→ 下载并归一化。
 * 无可用字幕时返回 null。
 */
export async function getSubtitleCues(
  bvid: string,
  cid: number,
  opts?: BiliClientOptions & { aid?: number },
): Promise<SubtitleResult | null> {
  const tracks = await getSubtitleTracks(bvid, cid, opts?.aid, opts);
  const track = pickSubtitleTrack(tracks);
  if (!track) return null;
  const cues = await fetchSubtitleCues(track.subtitleUrl, opts);
  return { track, tracksCount: tracks.length, cues };
}
