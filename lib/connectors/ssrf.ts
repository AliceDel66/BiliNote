/**
 * SSRF 防护（讨论稿 §8）：自定义 / 预设远程 MCP 端点只允许公网 HTTPS。
 *
 * 浏览器扩展无法可靠做 DNS/IP pinning 与防 rebinding，这里做的是保存时的
 * 静态拦截：协议必须 https，且主机名不得为 localhost / *.local / 私网或
 * 链路本地 IP 字面量。真正任意 URL 应走 Local Bridge（见 bridgeConnector）。
 */

/** 被拒绝的 IPv4 私网 / 回环 / 链路本地段（CIDR → [网络前缀, 掩码位数]） */
const BLOCKED_V4: [number, number][] = [
  [0x7f000000, 8], // 127.0.0.0/8 回环
  [0x0a000000, 8], // 10.0.0.0/8 私网
  [0xac100000, 12], // 172.16.0.0/12 私网
  [0xc0a80000, 16], // 192.168.0.0/16 私网
  [0xa9fe0000, 16], // 169.254.0.0/16 链路本地
];

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  // IPv6 字面量（URL.hostname 可能带或不带方括号）：回环 ::1 与私网 fc00::/7 一律拒绝
  const v6 = h.replace(/^\[|\]$/g, '');
  if (v6 === '::1' || v6 === '0:0:0:0:0:0:0:1' || /^(fc|fd)[0-9a-f]{2}:/.test(v6)) return true;
  const v4 = parseIpv4(h);
  if (v4 !== null) {
    for (const [net, bits] of BLOCKED_V4) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      // JS 位运算返回有符号 int32，统一转回无符号再比较
      if (((v4 & mask) >>> 0) === net) return true;
    }
  }
  return false;
}

/**
 * 校验并返回 URL；不合法时抛出带中文说明的 Error。
 * 仅做语法级校验（主机名为字面量时精确拦截；域名形式默认放行，由浏览器
 * 自身的网络栈解析 —— 这也是 §8 说明的扩展直连能力边界）。
 */
export function assertPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('端点 URL 格式不正确，请输入完整的 https:// 地址');
  }
  if (url.protocol !== 'https:') {
    throw new Error('端点必须使用 https:// 协议（自定义 MCP 仅允许加密连接）');
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error('端点指向本机或内网地址，已被安全策略拦截；本机服务请改用 Local Markdown Bridge');
  }
  return url;
}

/** URL → chrome.permissions.request 用的 origin pattern */
export function originPatternOf(url: URL): string {
  return `${url.origin}/*`;
}
