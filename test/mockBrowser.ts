// 测试共享：wxt/browser 的内存版 chrome.storage mock。
// 用法（vi.mock 工厂内动态 import，避免提升顺序问题）：
//   vi.mock('wxt/browser', async () => (await import('./mockBrowser')).createBrowserMock());

interface StorageAreaMock {
  get(key?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

function makeArea(): StorageAreaMock {
  const data: Record<string, unknown> = {};
  return {
    async get(key) {
      if (key == null) return { ...data };
      const keys = Array.isArray(key) ? key : [key];
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k in data) out[k] = data[k];
      }
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}

export function createBrowserMock() {
  return {
    browser: {
      storage: { local: makeArea(), sync: makeArea() },
    },
  };
}
