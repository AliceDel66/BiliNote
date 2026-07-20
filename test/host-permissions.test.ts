import { describe, expect, it } from 'vitest';
import { REQUIRED_HOST_PERMISSIONS } from '../lib/host-permissions';

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
