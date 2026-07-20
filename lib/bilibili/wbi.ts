/**
 * wbi 签名（B站 Web 端接口签名校验）。
 * 纯函数实现，无浏览器依赖，可单测。
 * 参考社区公开算法：https://github.com/SocialSisterYi/bilibili-API-collect
 */
import { md5 } from '@noble/hashes/legacy.js';

/** 固定的 64 字符重排表 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function md5Hex(text: string): string {
  return bytesToHex(md5(new TextEncoder().encode(text)));
}

/** img_key + sub_key 拼接后按重排表取前 32 位 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let key = '';
  for (const i of MIXIN_KEY_ENC_TAB) key += raw[i];
  return key.slice(0, 32);
}

/** wbi 参数中需要过滤的字符 */
function sanitizeValue(v: string): string {
  return v.replace(/[!'()*]/g, '');
}

export interface WbiSignedQuery {
  /** 未签名的 query 串（含 wts，已按 key 排序） */
  query: string;
  /** 完整签名后的 query 串（query + &w_rid=...） */
  signedQuery: string;
  wts: number;
  wRid: string;
}

/**
 * 对参数做 wbi 签名。
 * w_rid = md5(sortedQuery + "&wts=" + ts ... ) —— 实际实现为 md5(query(含wts) + mixinKey)
 */
export function signWbi(
  params: Record<string, string | number>,
  imgKey: string,
  subKey: string,
  wts: number = Math.floor(Date.now() / 1000),
): WbiSignedQuery {
  const mixinKey = getMixinKey(imgKey, subKey);
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map(
      (k) =>
        `${k}=${encodeURIComponent(sanitizeValue(String(all[k])))}`,
    )
    .join('&');
  const wRid = md5Hex(query + mixinKey);
  return { query, signedQuery: `${query}&w_rid=${wRid}`, wts, wRid };
}
