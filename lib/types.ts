/** 全局共享类型与默认值 */
export interface UiPrefs {
  /** 当前激活的模型 Profile id */
  activeProfileId?: string;
  theme: 'system' | 'light' | 'dark';
  /** 模型上下文预算（token），用于分块 */
  contextBudget: number;
}

export const DEFAULT_PREFS: UiPrefs = {
  theme: 'system',
  contextBudget: 8000,
};

/** 内容脚本上报的视频上下文 */
export interface VideoContext {
  bvid: string;
  /** 分 P 序号（1 起） */
  p: number;
  title: string;
  tabId: number;
  url: string;
}

/** 秒 → mm:ss（或 h:mm:ss） */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** mm:ss / h:mm:ss → 秒；非法返回 null */
export function parseTimestamp(text: string): number | null {
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)$/.exec(text.trim());
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
