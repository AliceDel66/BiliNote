/**
 * 扩展运行所需的 host 权限清单（wxt.config.ts 引用；测试用其做回归保护）。
 * - *.bilibili.com：视频信息 / wbi 签名 / 字幕轨列表等 B站接口
 * - *.hdslb.com：字幕文件 CDN（字幕 JSON 实际托管在 aisubtitle.hdslb.com 等域，
 *   缺失该权限时 fetch 会以 TypeError: Failed to fetch 失败）
 * - *.bilivideo.com：音视频 CDN（语音转写拉取音轨；playurl 返回的流地址托管在该域）
 */
export const REQUIRED_HOST_PERMISSIONS = [
  '*://*.bilibili.com/*',
  '*://*.hdslb.com/*',
  '*://*.bilivideo.com/*',
];

/** 从 baseURL 推导 MV3 host 权限 pattern（如 https://api.example.com/*）；URL 非法时返回 null */
export function originPattern(baseURL: string): string | null {
  try {
    return `${new URL(baseURL).origin}/*`;
  } catch {
    return null;
  }
}

/** http:// 明文端点仅允许的本机回环主机 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 非加密 http:// 端点校验（保存模型配置时调用）：
 * http:// 会明文发送 Bearer Key 与课程内容，因此只允许本机回环地址。
 * 返回错误文案表示违规；null 表示可放行（非法 URL 交给表单必填校验与连接错误处理）。
 */
export function insecureHttpError(baseURL: string): string | null {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (LOOPBACK_HOSTS.has(url.hostname)) return null;
  return '非加密 http:// 端点只允许本机地址，请使用 https';
}
