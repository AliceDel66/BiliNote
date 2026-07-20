/**
 * 扩展运行所需的 host 权限清单（wxt.config.ts 引用；测试用其做回归保护）。
 * - *.bilibili.com：视频信息 / wbi 签名 / 字幕轨列表等 B站接口
 * - *.hdslb.com：字幕文件 CDN（字幕 JSON 实际托管在 aisubtitle.hdslb.com 等域，
 *   缺失该权限时 fetch 会以 TypeError: Failed to fetch 失败）
 */
export const REQUIRED_HOST_PERMISSIONS = [
  '*://*.bilibili.com/*',
  '*://*.hdslb.com/*',
];
