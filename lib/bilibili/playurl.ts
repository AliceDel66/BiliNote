/**
 * B站播放地址（playurl）适配器：为语音转写拉取视频音轨。
 * 纯 TS（fetch 可注入），无浏览器依赖，可单测。
 * 在扩展中运行于 background worker，host permission 覆盖 *.bilivideo.com CDN。
 */
import { BiliApiError, getVideoInfo, getWbiKeys, type BiliClientOptions } from './api';
import { signWbi } from './wbi';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com';

/** dash 与 durl 均无音频条目时抛出（如纯画面视频） */
export class NoAudioTrackError extends Error {
  constructor(message = '该视频没有可用音轨') {
    super(message);
    this.name = 'NoAudioTrackError';
  }
}

export interface AudioTrack {
  url: string;
  /** 码率（bps；durl 回退无码率信息时为 0） */
  bandwidth: number;
  /** 估算大小（MB；未知为 0，由下载后的实际字节数兜底校验） */
  sizeMB: number;
  mimeType: string;
}

export interface GetAudioTrackOptions extends BiliClientOptions {
  /** 分 P 时长（秒）；缺省时内部走 getVideoInfo 查询 */
  duration?: number;
}

interface PlayurlResp {
  code: number;
  message?: string;
  data?: {
    dash?: {
      audio?: {
        baseUrl?: string;
        base_url?: string;
        bandwidth?: number;
        mimeType?: string;
        mime_type?: string;
      }[];
    };
    durl?: { url?: string; size?: number }[];
  };
}

/** 与 api.ts biliFetchJson 同款头部（UA + Referer + cookie） */
async function playurlFetchJson(
  signedQuery: string,
  opts?: BiliClientOptions,
): Promise<PlayurlResp> {
  const f = (opts?.fetchImpl ?? globalThis.fetch)?.bind(globalThis) as typeof fetch;
  if (!f) throw new BiliApiError('当前环境无可用 fetch');
  let resp: Response;
  try {
    resp = await f(`https://api.bilibili.com/x/player/playurl?${signedQuery}`, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      credentials: 'include',
    });
  } catch (e) {
    throw new BiliApiError(`网络请求失败: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    throw new BiliApiError(`HTTP ${resp.status}`, resp.status);
  }
  return (await resp.json()) as PlayurlResp;
}

async function fetchPlayurl(
  bvid: string,
  cid: number,
  fnval: number,
  opts?: BiliClientOptions,
): Promise<PlayurlResp> {
  const keys = await getWbiKeys(opts);
  // 只传 fnval=16 即返回 dash；加 platform=html5 / high_quality=1 会被服务端
  // 降级为 durl（mp4 混流无独立音轨）——实网验证过的行为，勿加这两个参数。
  const params: Record<string, string | number> = { bvid, cid, fnval };
  const { signedQuery } = signWbi(params, keys.imgKey, keys.subKey);
  return playurlFetchJson(signedQuery, opts);
}

/**
 * 取视频的最低码率音轨（单文件 ≤25MB 的转写上限下，最低码率最有机会装下）。
 * 优先 DASH（fnval=16）音频流；无 dash 时回退 fnval=1 的 durl（mp4 混流）。
 * 大小估算：dash 按 bandwidth(bps) ÷ 8 × 时长；durl 用接口 size 字段（缺失则 0 = 未知）。
 */
export async function getAudioTrack(
  bvid: string,
  cid: number,
  opts?: GetAudioTrackOptions,
): Promise<AudioTrack> {
  const resp = await fetchPlayurl(bvid, cid, 16, opts);
  if (resp.code !== 0) {
    throw new BiliApiError(
      `获取播放地址失败: ${resp.message ?? `code=${resp.code}`}`,
      resp.code,
    );
  }
  const audio = (resp.data?.dash?.audio ?? [])
    .map((a) => ({
      url: a.baseUrl ?? a.base_url ?? '',
      bandwidth: a.bandwidth ?? 0,
      mimeType: a.mimeType ?? a.mime_type ?? 'audio/mp4',
    }))
    .filter((a) => a.url.length > 0);

  if (audio.length > 0) {
    // 选最低码率；缺失码率（0）的排最后，无法估算大小时由下载后字节数兜底
    audio.sort(
      (x, y) =>
        (x.bandwidth || Number.MAX_SAFE_INTEGER) -
        (y.bandwidth || Number.MAX_SAFE_INTEGER),
    );
    const pick = audio[0];
    let duration = opts?.duration ?? 0;
    if (!(duration > 0)) {
      const info = await getVideoInfo(bvid, opts);
      duration = info.pages.find((p) => p.cid === cid)?.duration ?? info.duration;
    }
    const sizeMB = pick.bandwidth > 0 ? (pick.bandwidth / 8) * duration / (1024 * 1024) : 0;
    return { url: pick.url, bandwidth: pick.bandwidth, sizeMB, mimeType: pick.mimeType };
  }

  // 回退：fnval=1 → durl（mp4 混流，非纯音频，体积更大）
  const fallback = await fetchPlayurl(bvid, cid, 1, opts);
  if (fallback.code !== 0) {
    throw new BiliApiError(
      `获取播放地址失败: ${fallback.message ?? `code=${fallback.code}`}`,
      fallback.code,
    );
  }
  const durl = (fallback.data?.durl ?? []).filter((d) => d.url);
  if (durl.length === 0) throw new NoAudioTrackError();
  const first = durl[0];
  return {
    url: first.url!,
    bandwidth: 0,
    sizeMB: first.size ? first.size / (1024 * 1024) : 0,
    mimeType: 'video/mp4',
  };
}

export interface DownloadAudioOptions extends BiliClientOptions {
  signal?: AbortSignal;
  /** 下载进度回调（0–100；仅在响应带 content-length 时上报） */
  onProgress?: (percent: number) => void;
}

export interface DownloadedAudio {
  bytes: ArrayBuffer;
  sizeMB: number;
}

/** 下载音轨字节（B站 CDN 要求 Referer）；提供 onProgress 时走流式读取上报百分比 */
export async function downloadAudio(
  url: string,
  opts?: DownloadAudioOptions,
): Promise<DownloadedAudio> {
  const f = (opts?.fetchImpl ?? globalThis.fetch)?.bind(globalThis) as typeof fetch;
  if (!f) throw new BiliApiError('当前环境无可用 fetch');
  let resp: Response;
  try {
    resp = await f(url, {
      headers: { 'User-Agent': UA, Referer: REFERER },
      signal: opts?.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw err; // 取消原样上抛，调用方按 aborted 处理
    throw new BiliApiError(`音频下载失败: ${err.message}`);
  }
  if (!resp.ok) {
    throw new BiliApiError(`音频下载失败: HTTP ${resp.status}`, resp.status);
  }
  const total = Number(resp.headers.get('content-length')) || 0;
  if (resp.body && opts?.onProgress) {
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        if (total > 0) {
          opts.onProgress(Math.min(100, Math.round((received / total) * 100)));
        }
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { bytes: bytes.buffer, sizeMB: received / (1024 * 1024) };
  }
  const buf = await resp.arrayBuffer();
  return { bytes: buf, sizeMB: buf.byteLength / (1024 * 1024) };
}
