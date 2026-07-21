/**
 * OpenAI 兼容语音转写（POST {baseURL}/audio/transcriptions）客户端。
 * 纯 TS（fetch 可注入），无浏览器依赖，可单测。
 * Phase 1：仅单文件 ≤25MB；更长音频的分段转写留待后续阶段（在此拒绝，信息明确）。
 */
import type { Cue } from '../bilibili/types';

/** OpenAI 兼容转写端点普遍的单文件上限（whisper 系） */
export const MAX_STT_FILE_BYTES = 25 * 1024 * 1024;

export type SttErrorKind =
  | 'file_too_large'
  | 'auth'
  | 'quota'
  | 'timeout'
  | 'network'
  | 'bad_response'
  | 'aborted';

export class SttError extends Error {
  constructor(
    readonly kind: SttErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SttError';
  }

  /** 面向用户的可操作提示（中文） */
  get userMessage(): string {
    switch (this.kind) {
      case 'file_too_large':
        return `音频文件过大（${this.message}），超过 25MB 单文件上限，暂无法转写；更长音频的分段转写将在后续版本支持`;
      case 'auth':
        return '转写服务 API Key 无效或已过期（401），请检查设置页中的语音转写配置';
      case 'quota':
        return '转写服务额度不足或触发限流（429），请稍后重试或检查账户额度';
      case 'timeout':
        return '转写请求超时，请检查网络或稍后重试';
      case 'aborted':
        return '已取消';
      case 'network':
        return `无法连接转写服务：${this.message}，请检查 baseURL 与网络连接`;
      default:
        return `转写服务响应异常：${this.message}`;
    }
  }
}

export interface TranscribeParams {
  baseURL: string;
  apiKey: string;
  model: string;
  bytes: ArrayBuffer;
  /** 上传文件名（端点常按扩展名推断格式，需与 mimeType 匹配） */
  filename: string;
  mimeType: string;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  cues: Cue[];
  /** 端点返回的整段文本（verbose_json.text）；调用方在 cues 为空时自行降级 */
  text: string;
}

/** STT 配置完整性校验（三项都非空才可用） */
export function isSttConfig(baseURL?: string, apiKey?: string, model?: string): boolean {
  return Boolean(baseURL?.trim() && apiKey?.trim() && model?.trim());
}

function normalizeBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

interface VerboseJsonSegment {
  start?: number | string;
  end?: number | string;
  text?: string;
}

interface VerboseJson {
  text?: string;
  duration?: number;
  segments?: VerboseJsonSegment[];
}

/**
 * multipart/form-data 上传音频并解析 verbose_json。
 * 注意：不手动设置 Content-Type（浏览器/undici 会自动带 boundary）。
 * 返回 { cues, text }：segments 缺失但 text 非空时 cues 为空数组，由调用方决定降级策略。
 */
export async function transcribeAudio(params: TranscribeParams): Promise<TranscribeResult> {
  if (params.bytes.byteLength > MAX_STT_FILE_BYTES) {
    throw new SttError(
      'file_too_large',
      `约 ${(params.bytes.byteLength / (1024 * 1024)).toFixed(1)}MB`,
    );
  }
  const f = params.fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  form.append('file', new Blob([params.bytes], { type: params.mimeType }), params.filename);
  form.append('model', params.model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');

  let resp: Response;
  try {
    resp = await f(`${normalizeBase(params.baseURL)}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${params.apiKey}` },
      body: form,
      signal: params.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new SttError('aborted', err.message);
    throw new SttError('network', err.message);
  }
  if (!resp.ok) {
    const short = (await readErrorBody(resp)).slice(0, 200);
    if (resp.status === 401 || resp.status === 403) throw new SttError('auth', short, resp.status);
    if (resp.status === 429) throw new SttError('quota', short, resp.status);
    if (resp.status === 408 || resp.status === 504) {
      throw new SttError('timeout', short, resp.status);
    }
    if (resp.status === 413) throw new SttError('file_too_large', '服务端拒绝（413）', resp.status);
    throw new SttError('bad_response', `HTTP ${resp.status}: ${short}`, resp.status);
  }

  let json: VerboseJson;
  try {
    json = (await resp.json()) as VerboseJson;
  } catch {
    throw new SttError('bad_response', '响应不是合法 JSON');
  }
  const cues: Cue[] = (json.segments ?? [])
    .map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      text: String(s.text ?? '').trim(),
    }))
    .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.text.length > 0);
  return { cues, text: String(json.text ?? '').trim() };
}

/** 生成 seconds 秒静音 WAV（16kHz mono 16-bit PCM），设置页连通性测试用 */
export function buildSilentWav(seconds = 1): ArrayBuffer {
  const sampleRate = 16000;
  const dataSize = sampleRate * 2 * Math.max(0, Math.round(seconds));
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt 块长度
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byteRate
  v.setUint16(32, 2, true); // blockAlign
  v.setUint16(34, 16, true); // bitsPerSample
  writeStr(36, 'data');
  v.setUint32(40, dataSize, true);
  // 数据区保持全 0 = 静音
  return buf;
}
