import { describe, expect, it } from 'vitest';
import {
  insecureHttpError,
  originPattern,
  REQUIRED_HOST_PERMISSIONS,
} from '../lib/host-permissions';

// 回归保护：字幕 JSON 托管在 *.hdslb.com（aisubtitle.hdslb.com 等），
// host_permissions 漏掉该域时，扩展内 fetch 会以 TypeError: Failed to fetch 失败。
describe('REQUIRED_HOST_PERMISSIONS', () => {
  it('包含 B站接口域 *.bilibili.com', () => {
    expect(REQUIRED_HOST_PERMISSIONS).toContain('*://*.bilibili.com/*');
  });

  it('包含字幕 CDN 域 *.hdslb.com', () => {
    expect(REQUIRED_HOST_PERMISSIONS).toContain('*://*.hdslb.com/*');
  });
});

describe('originPattern（baseURL → host 权限 pattern）', () => {
  it('取 origin 并追加 /*', () => {
    expect(originPattern('https://api.moonshot.cn/v1')).toBe('https://api.moonshot.cn/*');
    expect(originPattern('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/*');
  });

  it('非法 URL → null', () => {
    expect(originPattern('not-a-url')).toBeNull();
    expect(originPattern('')).toBeNull();
  });
});

// 明文 http:// 会泄露 Bearer Key 与课程内容：保存配置时仅允许本机回环地址。
describe('insecureHttpError（http:// 本机回环校验）', () => {
  it('https 端点放行', () => {
    expect(insecureHttpError('https://api.moonshot.cn/v1')).toBeNull();
    expect(insecureHttpError('https://api.deepseek.com')).toBeNull();
  });

  it('http:// 本机回环地址放行（localhost / 127.0.0.1 / [::1]）', () => {
    expect(insecureHttpError('http://localhost:3000/v1')).toBeNull();
    expect(insecureHttpError('http://127.0.0.1:11434')).toBeNull();
    expect(insecureHttpError('http://[::1]:8080/v1')).toBeNull();
  });

  it('http:// 非回环地址 → 拦截（公网域名 / 内网 IP）', () => {
    expect(insecureHttpError('http://api.example.com/v1')).toBe(
      '非加密 http:// 端点只允许本机地址，请使用 https',
    );
    expect(insecureHttpError('http://192.168.1.10:8080')).toBe(
      '非加密 http:// 端点只允许本机地址，请使用 https',
    );
  });

  it('非法 URL 放行（交给表单必填校验与连接错误处理）', () => {
    expect(insecureHttpError('not-a-url')).toBeNull();
  });
});
