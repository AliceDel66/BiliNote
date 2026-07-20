/** 从 B站 URL 解析视频标识（content script 与 background 共用，保持单一实现） */
export interface VideoUrlParts {
  bvid: string;
  p: number;
}

export function parseVideoUrl(url: string): VideoUrlParts | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(u.pathname);
  if (!m) return null;
  const pParam = Number(u.searchParams.get('p') ?? '1');
  const p = Number.isFinite(pParam) && pParam >= 1 ? Math.floor(pParam) : 1;
  return { bvid: m[1], p };
}
