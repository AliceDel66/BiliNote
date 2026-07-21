// SSRF 防护：仅公网 HTTPS；localhost / *.local / 私网与链路本地 IP 字面量一律拒绝
import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, originPatternOf } from '../lib/connectors/ssrf';

describe('assertPublicHttpsUrl', () => {
  it('必须 https：http / 其他协议 / 非法 URL 拒绝', () => {
    expect(() => assertPublicHttpsUrl('http://example.com/mcp')).toThrow(/https/);
    expect(() => assertPublicHttpsUrl('ftp://example.com')).toThrow(/https/);
    expect(() => assertPublicHttpsUrl('not-a-url')).toThrow(/格式/);
    expect(() => assertPublicHttpsUrl('')).toThrow(/格式/);
  });

  it('localhost / *.local / 回环拒绝', () => {
    expect(() => assertPublicHttpsUrl('https://localhost/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://foo.local/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://127.0.0.1/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://127.5.6.7/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://[::1]/mcp')).toThrow(/内网|拦截/);
  });

  it('私网 / 链路本地 IPv4 字面量拒绝（含 172.16/12 边界）', () => {
    expect(() => assertPublicHttpsUrl('https://10.0.0.1/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://10.255.255.254/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://172.16.0.1/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://172.31.255.255/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://192.168.1.1/mcp')).toThrow(/内网|拦截/);
    expect(() => assertPublicHttpsUrl('https://169.254.0.1/mcp')).toThrow(/内网|拦截/);
  });

  it('公网地址放行（含 172.16/12 两侧边界）', () => {
    expect(assertPublicHttpsUrl('https://172.15.255.255/mcp').hostname).toBe('172.15.255.255');
    expect(assertPublicHttpsUrl('https://172.32.0.1/mcp').hostname).toBe('172.32.0.1');
    expect(assertPublicHttpsUrl('https://8.8.8.8/mcp').hostname).toBe('8.8.8.8');
    expect(assertPublicHttpsUrl('https://mcp.example.com/path?q=1').hostname).toBe(
      'mcp.example.com',
    );
    expect(assertPublicHttpsUrl('  https://docs.qq.com/mcp  ').hostname).toBe('docs.qq.com');
  });

  it('originPatternOf 生成 host 权限 pattern', () => {
    const url = assertPublicHttpsUrl('https://mcp.example.com:8443/rpc');
    expect(originPatternOf(url)).toBe('https://mcp.example.com:8443/*');
  });
});
