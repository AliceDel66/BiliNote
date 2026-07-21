// playurl 音轨适配器测试（全 mock fetch）：dash 解析 / 最低码率选择 / durl 回退 / 错误类型 / 下载进度。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearWbiKeyCache,
  BiliApiError,
  downloadAudio,
  getAudioTrack,
  NoAudioTrackError,
} from '../lib/bilibili';

const NAV = {
  code: 0,
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

function jsonResp(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200 });
}

function mockFetch(route: (url: string) => Response | null, urls?: string[]) {
  return (async (input: unknown) => {
    const u = String(input);
    urls?.push(u);
    const r = route(u);
    if (!r) throw new Error(`未 mock 的请求: ${u}`);
    return r;
  }) as typeof fetch;
}

function dashResp(audio: unknown[]) {
  return { code: 0, data: { dash: { audio } } };
}

beforeEach(() => __clearWbiKeyCache());

describe('getAudioTrack（dash）', () => {
  it('解析 baseUrl / base_url 两种字段变体，选最低码率音轨', async () => {
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      if (u.includes('/playurl')) {
        return jsonResp(
          dashResp([
            { baseUrl: 'https://cdn/a256.m4s', bandwidth: 256000 },
            { base_url: 'https://cdn/a64.m4s', bandwidth: 64000 },
            { baseUrl: 'https://cdn/a128.m4s', bandwidth: 128000 },
          ]),
        );
      }
      return null;
    });
    const track = await getAudioTrack('BV1x', 100, { fetchImpl, duration: 600 });
    expect(track.url).toBe('https://cdn/a64.m4s');
    expect(track.bandwidth).toBe(64000);
    expect(track.mimeType).toBe('audio/mp4');
  });

  it('sizeMB = bandwidth(bps) / 8 × 时长 / MB', async () => {
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      return jsonResp(dashResp([{ baseUrl: 'https://cdn/a.m4s', bandwidth: 128000 }]));
    });
    const track = await getAudioTrack('BV1x', 100, { fetchImpl, duration: 600 });
    // 128000/8 × 600 = 9_600_000 B ≈ 9.16 MB
    expect(track.sizeMB).toBeCloseTo(9_600_000 / (1024 * 1024), 5);
  });

  it('未传 duration 时经 getVideoInfo 取当前分 P 时长', async () => {
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      if (u.includes('/view')) {
        return jsonResp({
          code: 0,
          data: {
            bvid: 'BV1x',
            aid: 1,
            title: 't',
            pic: '',
            duration: 999,
            pages: [{ cid: 100, page: 1, part: '', duration: 300 }],
          },
        });
      }
      return jsonResp(dashResp([{ baseUrl: 'https://cdn/a.m4s', bandwidth: 128000 }]));
    });
    const track = await getAudioTrack('BV1x', 100, { fetchImpl });
    expect(track.sizeMB).toBeCloseTo(((128000 / 8) * 300) / (1024 * 1024), 5);
  });

  it('dash 音频缺 url 的条目被丢弃；全部缺 url 时回退 durl', async () => {
    const urls: string[] = [];
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      const fnval = new URL(u).searchParams.get('fnval');
      if (fnval === '16') return jsonResp(dashResp([{ bandwidth: 128000 }]));
      if (fnval === '1') {
        return jsonResp({ code: 0, data: { durl: [{ url: 'https://cdn/v.mp4' }] } });
      }
      return null;
    }, urls);
    const track = await getAudioTrack('BV1x', 100, { fetchImpl, duration: 600 });
    expect(track.url).toBe('https://cdn/v.mp4');
  });
});

describe('getAudioTrack（durl 回退与错误）', () => {
  it('无 dash → fnval=1 回退：durl[0]，mimeType=video/mp4，size 字段换算 MB', async () => {
    const urls: string[] = [];
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      const fnval = new URL(u).searchParams.get('fnval');
      if (fnval === '16') return jsonResp({ code: 0, data: {} });
      if (fnval === '1') {
        return jsonResp({
          code: 0,
          data: { durl: [{ url: 'https://cdn/v.mp4', size: 5 * 1024 * 1024 }] },
        });
      }
      return null;
    }, urls);
    const track = await getAudioTrack('BV1x', 100, { fetchImpl, duration: 600 });
    expect(track).toMatchObject({ url: 'https://cdn/v.mp4', mimeType: 'video/mp4', sizeMB: 5 });
    // 先请求 DASH（fnval=16），回退再请求 fnval=1
    const fnvals = urls
      .filter((u) => u.includes('/playurl'))
      .map((u) => new URL(u).searchParams.get('fnval'));
    expect(fnvals).toEqual(['16', '1']);
  });

  it('dash 与 durl 都无音频 → NoAudioTrackError', async () => {
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      if (u.includes('/playurl')) return jsonResp({ code: 0, data: {} });
      return null;
    });
    await expect(getAudioTrack('BV1x', 100, { fetchImpl, duration: 1 })).rejects.toBeInstanceOf(
      NoAudioTrackError,
    );
  });

  it('code !== 0 → BiliApiError（含接口 message）', async () => {
    const fetchImpl = mockFetch((u) => {
      if (u.includes('/nav')) return jsonResp(NAV);
      return jsonResp({ code: -404, message: '啥都木有' });
    });
    const err = await getAudioTrack('BV1x', 100, { fetchImpl, duration: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(BiliApiError);
    expect((err as BiliApiError).message).toContain('啥都木有');
  });
});

describe('downloadAudio', () => {
  it('流式读取累计字节，按 content-length 上报百分比', async () => {
    const parts = [new Uint8Array(40).fill(1), new Uint8Array(60).fill(2)];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(p);
        c.close();
      },
    });
    const fetchImpl = (async () =>
      new Response(stream, { status: 200, headers: { 'content-length': '100' } })) as typeof fetch;
    const percents: number[] = [];
    const r = await downloadAudio('https://cdn/a.m4s', {
      fetchImpl,
      onProgress: (p) => percents.push(p),
    });
    expect(r.bytes.byteLength).toBe(100);
    expect(new Uint8Array(r.bytes)[0]).toBe(1);
    expect(new Uint8Array(r.bytes)[99]).toBe(2);
    expect(percents).toEqual([40, 100]);
    expect(r.sizeMB).toBeCloseTo(100 / (1024 * 1024), 6);
  });

  it('无 onProgress → arrayBuffer 路径；请求带 Referer 与 signal', async () => {
    let seenInit: RequestInit | undefined;
    const ctrl = new AbortController();
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenInit = init;
      return new Response(new Uint8Array([9, 9]), { status: 200 });
    }) as typeof fetch;
    const r = await downloadAudio('https://cdn/a.m4s', { fetchImpl, signal: ctrl.signal });
    expect(r.bytes.byteLength).toBe(2);
    expect((seenInit?.headers as Record<string, string>).Referer).toBe('https://www.bilibili.com');
    expect(seenInit?.signal).toBe(ctrl.signal);
  });

  it('HTTP 错误 → BiliApiError', async () => {
    const fetchImpl = (async () => new Response('x', { status: 403 })) as typeof fetch;
    await expect(downloadAudio('https://cdn/a.m4s', { fetchImpl })).rejects.toBeInstanceOf(
      BiliApiError,
    );
  });
});
