// STT 客户端测试（全 mock fetch）：multipart 构造 / verbose_json 解析 / 错误类型 / 静音 WAV。
import { describe, expect, it } from 'vitest';
import {
  buildSilentWav,
  isSttConfig,
  MAX_STT_FILE_BYTES,
  SttError,
  transcribeAudio,
  type TranscribeParams,
} from '../lib/transcribe';

const BASE = {
  baseURL: 'https://api.groq.com/openai/v1/', // 末尾斜杠应被归一
  apiKey: 'gsk_test',
  model: 'whisper-large-v3',
};

function params(fetchImpl: typeof fetch, bytes?: ArrayBuffer): TranscribeParams {
  return {
    ...BASE,
    bytes: bytes ?? new Uint8Array([1, 2, 3]).buffer,
    filename: 'audio.m4a',
    mimeType: 'audio/mp4',
    fetchImpl,
  };
}

function capture(handler: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return handler();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('transcribeAudio 请求构造', () => {
  it('multipart 含 file/model/response_format/timestamp_granularities；Bearer 头正确；无手动 Content-Type', async () => {
    const { calls, fetchImpl } = capture(
      () =>
        new Response(
          JSON.stringify({ text: '你好', segments: [{ start: 0, end: 1.5, text: '你好' }] }),
          { status: 200 },
        ),
    );
    const r = await transcribeAudio(params(fetchImpl));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gsk_test');
    expect(headers['Content-Type']).toBeUndefined(); // boundary 由运行时生成
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('timestamp_granularities[]')).toBe('segment');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.m4a');
    expect(file.size).toBe(3);
    expect(file.type).toBe('audio/mp4');
    expect(r.cues).toEqual([{ start: 0, end: 1.5, text: '你好' }]);
    expect(r.text).toBe('你好');
  });
});

describe('transcribeAudio 响应解析', () => {
  it('segments → cues：数字转换、trim、丢空文本与非法时间', async () => {
    const { fetchImpl } = capture(
      () =>
        new Response(
          JSON.stringify({
            segments: [
              { start: '0.5', end: 2, text: '  第一句  ' },
              { start: 2, end: 3, text: '   ' },
              { start: 'x', end: 4, text: '坏时间' },
            ],
          }),
          { status: 200 },
        ),
    );
    const r = await transcribeAudio(params(fetchImpl));
    expect(r.cues).toEqual([{ start: 0.5, end: 2, text: '第一句' }]);
    expect(r.text).toBe('');
  });

  it('无 segments 但有 text → cues 空、text 保留（调用方决定降级）', async () => {
    const { fetchImpl } = capture(
      () => new Response(JSON.stringify({ text: '整段文本' }), { status: 200 }),
    );
    const r = await transcribeAudio(params(fetchImpl));
    expect(r.cues).toEqual([]);
    expect(r.text).toBe('整段文本');
  });

  it('非 JSON 响应 → bad_response', async () => {
    const { fetchImpl } = capture(() => new Response('<html>bad gateway</html>', { status: 200 }));
    const err = await transcribeAudio(params(fetchImpl)).catch((e) => e);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).kind).toBe('bad_response');
  });
});

describe('transcribeAudio 错误类型', () => {
  it('超过 25MB → file_too_large，且在发请求前拒绝', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return new Response('{}');
    }) as typeof fetch;
    const big = new ArrayBuffer(MAX_STT_FILE_BYTES + 1);
    const err = await transcribeAudio(params(fetchImpl, big)).catch((e) => e);
    expect(called).toBe(0);
    expect(err).toBeInstanceOf(SttError);
    expect((err as SttError).kind).toBe('file_too_large');
    expect((err as SttError).userMessage).toContain('25MB');
  });

  it('401→auth / 429→quota / 408→timeout / 413→file_too_large，userMessage 为中文可操作提示', async () => {
    const cases = [
      [401, 'auth'],
      [429, 'quota'],
      [408, 'timeout'],
      [413, 'file_too_large'],
    ] as const;
    for (const [status, kind] of cases) {
      const { fetchImpl } = capture(() => new Response('nope', { status }));
      const err = await transcribeAudio(params(fetchImpl)).catch((e) => e);
      expect(err).toBeInstanceOf(SttError);
      expect((err as SttError).kind).toBe(kind);
      expect((err as SttError).userMessage.length).toBeGreaterThan(0);
    }
  });

  it('网络异常 → network；AbortError → aborted（userMessage=已取消）', async () => {
    const netImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const e1 = await transcribeAudio(params(netImpl)).catch((e) => e);
    expect((e1 as SttError).kind).toBe('network');

    const abImpl = (async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }) as typeof fetch;
    const e2 = await transcribeAudio(params(abImpl)).catch((e) => e);
    expect((e2 as SttError).kind).toBe('aborted');
    expect((e2 as SttError).userMessage).toBe('已取消');
  });
});

describe('buildSilentWav', () => {
  it('RIFF 头：尺寸 / mono / 16kHz / 16bit，数据区全 0', () => {
    const buf = buildSilentWav(1);
    const v = new DataView(buf);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...new Uint8Array(buf, off, len));
    expect(buf.byteLength).toBe(44 + 16000 * 2);
    expect(ascii(0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 16000 * 2);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(1); // channels = 1
    expect(v.getUint32(24, true)).toBe(16000); // sample rate
    expect(v.getUint32(28, true)).toBe(32000); // byte rate
    expect(v.getUint16(34, true)).toBe(16); // bits per sample
    expect(ascii(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(16000 * 2);
    expect(new Uint8Array(buf, 44).every((b) => b === 0)).toBe(true);
  });

  it('seconds=2 → 数据区翻倍', () => {
    expect(buildSilentWav(2).byteLength).toBe(44 + 16000 * 2 * 2);
  });
});

describe('isSttConfig', () => {
  it('baseURL / apiKey / model 三项齐全才算已配置', () => {
    expect(isSttConfig('https://x', 'k', 'm')).toBe(true);
    expect(isSttConfig('', 'k', 'm')).toBe(false);
    expect(isSttConfig('https://x', '   ', 'm')).toBe(false);
    expect(isSttConfig('https://x', 'k', '')).toBe(false);
    expect(isSttConfig()).toBe(false);
  });
});
