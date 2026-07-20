/**
 * chrome.storage 封装：
 * - 模型 Profile（含 API Key）→ chrome.storage.local（永不进入同步域）
 * - UI 偏好 → chrome.storage.sync
 * 仅在扩展环境（background / options / sidepanel）中使用。
 */
import { browser } from 'wxt/browser';
import type { UiPrefs } from '../types';
import { DEFAULT_PREFS } from '../types';

export interface ModelProfile {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  /** 最近一次拉取到的模型列表（缓存展示） */
  models: string[];
  createdAt: number;
}

const PROFILES_KEY = 'modelProfiles';
const PREFS_KEY = 'uiPrefs';

export async function getProfiles(): Promise<ModelProfile[]> {
  const res = await browser.storage.local.get(PROFILES_KEY);
  return (res[PROFILES_KEY] as ModelProfile[] | undefined) ?? [];
}

async function saveProfiles(profiles: ModelProfile[]): Promise<void> {
  await browser.storage.local.set({ [PROFILES_KEY]: profiles });
}

export async function addProfile(
  input: Omit<ModelProfile, 'id' | 'createdAt' | 'models'> & { models?: string[] },
): Promise<ModelProfile> {
  const profiles = await getProfiles();
  const profile: ModelProfile = {
    ...input,
    models: input.models ?? [],
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  profiles.push(profile);
  await saveProfiles(profiles);
  return profile;
}

export async function updateProfile(
  id: string,
  patch: Partial<Omit<ModelProfile, 'id' | 'createdAt'>>,
): Promise<void> {
  const profiles = await getProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('配置不存在');
  profiles[idx] = { ...profiles[idx], ...patch };
  await saveProfiles(profiles);
}

export async function removeProfile(id: string): Promise<void> {
  const profiles = await getProfiles();
  await saveProfiles(profiles.filter((p) => p.id !== id));
  const prefs = await getPrefs();
  if (prefs.activeProfileId === id) {
    await setPrefs({ activeProfileId: undefined });
  }
}

export async function getActiveProfile(): Promise<ModelProfile | null> {
  const prefs = await getPrefs();
  const profiles = await getProfiles();
  return profiles.find((p) => p.id === prefs.activeProfileId) ?? profiles[0] ?? null;
}

export async function getPrefs(): Promise<UiPrefs> {
  const res = await browser.storage.sync.get(PREFS_KEY);
  return { ...DEFAULT_PREFS, ...(res[PREFS_KEY] as Partial<UiPrefs> | undefined) };
}

export async function setPrefs(patch: Partial<UiPrefs>): Promise<UiPrefs> {
  const next = { ...(await getPrefs()), ...patch };
  await browser.storage.sync.set({ [PREFS_KEY]: next });
  return next;
}

// ---------- Notion 集成（内部集成令牌，仅存 chrome.storage.local） ----------

export interface NotionConfig {
  token: string;
  /** 验证成功后缓存的集成（bot）名称 */
  botName?: string;
  /** 用户选择的同步根页面 */
  rootPageId?: string;
  rootPageTitle?: string;
}

const NOTION_KEY = 'notionConfig';

export async function getNotionConfig(): Promise<NotionConfig | null> {
  const res = await browser.storage.local.get(NOTION_KEY);
  return (res[NOTION_KEY] as NotionConfig | undefined) ?? null;
}

export async function saveNotionConfig(config: NotionConfig): Promise<void> {
  await browser.storage.local.set({ [NOTION_KEY]: config });
}

export async function patchNotionConfig(
  patch: Partial<Omit<NotionConfig, 'token'>>,
): Promise<NotionConfig | null> {
  const current = await getNotionConfig();
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveNotionConfig(next);
  return next;
}

export async function clearNotionConfig(): Promise<void> {
  await browser.storage.local.remove(NOTION_KEY);
}
