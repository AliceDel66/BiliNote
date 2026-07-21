/**
 * Connector Profile 注册表（chrome.storage.local，凭据永不进入同步域）。
 *
 * - 列表 / 增删改 / 默认写入目标（active profile，单选）；
 * - 迁移：检测到旧版 NotionConfig（token 已配）且从未迁移过时，自动生成一个
 *   绑定该配置的 notion profile（config = { binding: 'notionConfig' }，不复制 token）。
 *   迁移只发生一次（connectorMigrationDone 标记），用户删掉 notion profile 不会被复活。
 */
import { browser } from 'wxt/browser';
import { getNotionConfig } from '../storage/settings';
import { createNotionConnector } from './notionConnector';
import { createMcpConnector } from './mcpConnector';
import { createBridgeConnector } from './bridgeConnector';
import {
  CONNECTOR_KIND_INFO,
  TENCENT_DOCS_MCP_ENDPOINT,
  type ConnectorDeps,
  type ConnectorProfile,
  type KnowledgeConnector,
} from './types';

const PROFILES_KEY = 'connectorProfiles';
const ACTIVE_KEY = 'connectorActiveId';
const MIGRATION_KEY = 'connectorMigrationDone';
const MIGRATION_V2_KEY = 'connectorMigrationV2';

async function rawList(): Promise<ConnectorProfile[]> {
  const res = await browser.storage.local.get(PROFILES_KEY);
  return (res[PROFILES_KEY] as ConnectorProfile[] | undefined) ?? [];
}

async function rawSave(profiles: ConnectorProfile[]): Promise<void> {
  await browser.storage.local.set({ [PROFILES_KEY]: profiles });
}

/** 旧版 NotionConfig → notion profile 一次性迁移（幂等） */
async function ensureMigration(): Promise<void> {
  const res = await browser.storage.local.get(MIGRATION_KEY);
  if (res[MIGRATION_KEY]) return;
  const profiles = await rawList();
  if (profiles.length === 0) {
    const notion = await getNotionConfig();
    if (notion?.token) {
      const profile: ConnectorProfile = {
        id: crypto.randomUUID(),
        kind: 'notion',
        name: CONNECTOR_KIND_INFO.notion.defaultName,
        status: 'stable',
        config: { binding: 'notionConfig' },
        createdAt: Date.now(),
      };
      await rawSave([profile]);
      await browser.storage.local.set({ [ACTIVE_KEY]: profile.id });
    }
  }
  await browser.storage.local.set({ [MIGRATION_KEY]: true });
}

/**
 * V2 迁移（幂等，additive）：本次升级前创建的腾讯文档 remote-mcp profile 没有
 * 官方端点与鉴权方式 —— endpoint 为空时补官方 URL（docs.qq.com/openapi/mcp），
 * 缺 authScheme 时补 'raw'（腾讯文档官方要求 Authorization 头直接放原始 token、
 * 不加 Bearer 前缀）。用户已填写的字段一律不覆盖；connectorMigrationV2 标记
 * 保证只跑一次（之后的用户修改不会被回改）。
 */
async function ensureMigrationV2(): Promise<void> {
  const res = await browser.storage.local.get(MIGRATION_V2_KEY);
  if (res[MIGRATION_V2_KEY]) return;
  const profiles = await rawList();
  let changed = false;
  const next = profiles.map((p) => {
    if (p.kind !== 'remote-mcp') return p;
    const config = { ...p.config };
    let touched = false;
    if (typeof config.endpoint !== 'string' || !config.endpoint) {
      config.endpoint = TENCENT_DOCS_MCP_ENDPOINT;
      touched = true;
    }
    if (!config.authScheme) {
      config.authScheme = 'raw';
      touched = true;
    }
    if (touched) changed = true;
    return touched ? { ...p, config } : p;
  });
  if (changed) await rawSave(next);
  await browser.storage.local.set({ [MIGRATION_V2_KEY]: true });
}

export async function listConnectorProfiles(): Promise<ConnectorProfile[]> {
  await ensureMigration();
  await ensureMigrationV2();
  return rawList();
}

/**
 * 新增或更新 profile（带 id 则更新）。首个 profile 自动成为默认写入目标。
 */
export async function saveConnectorProfile(
  input: Omit<ConnectorProfile, 'id' | 'createdAt'> & { id?: string },
): Promise<ConnectorProfile> {
  await ensureMigration();
  await ensureMigrationV2();
  const profiles = await rawList();
  let profile: ConnectorProfile;
  if (input.id) {
    const idx = profiles.findIndex((p) => p.id === input.id);
    if (idx < 0) throw new Error('连接配置不存在');
    const { id, ...patch } = input;
    profile = { ...profiles[idx], ...patch, id };
    profiles[idx] = profile;
  } else {
    const { id: _omit, ...rest } = input;
    profile = { ...rest, id: crypto.randomUUID(), createdAt: Date.now() };
    profiles.push(profile);
  }
  await rawSave(profiles);
  if (!(await getActiveConnectorProfileId())) {
    await setActiveConnectorProfileId(profile.id);
  }
  return profile;
}

export async function removeConnectorProfile(id: string): Promise<void> {
  const profiles = await rawList();
  await rawSave(profiles.filter((p) => p.id !== id));
  if ((await getActiveConnectorProfileId()) === id) {
    const rest = await rawList();
    await setActiveConnectorProfileId(rest[0]?.id);
  }
}

/** 局部更新（如写回最近一次测试结果 config.lastTest） */
export async function updateConnectorProfile(
  id: string,
  patch: Partial<Omit<ConnectorProfile, 'id' | 'createdAt'>>,
): Promise<void> {
  const profiles = await rawList();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('连接配置不存在');
  profiles[idx] = { ...profiles[idx], ...patch, id };
  await rawSave(profiles);
}

export async function getActiveConnectorProfileId(): Promise<string | undefined> {
  const res = await browser.storage.local.get(ACTIVE_KEY);
  return res[ACTIVE_KEY] as string | undefined;
}

export async function setActiveConnectorProfileId(id: string | undefined): Promise<void> {
  await browser.storage.local.set({ [ACTIVE_KEY]: id });
}

/** 默认写入目标：显式激活的 profile；未选时退化为列表第一个 */
export async function getActiveConnectorProfile(): Promise<ConnectorProfile | null> {
  const profiles = await listConnectorProfiles();
  const activeId = await getActiveConnectorProfileId();
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
}

/** 401 兜底重试成功后的默认写回（重读最新 config 再合并，避免覆盖并发写入的 lastTest 等） */
async function persistAuthScheme(
  profile: ConnectorProfile,
  scheme: 'raw' | 'bearer',
): Promise<void> {
  const latest = (await rawList()).find((p) => p.id === profile.id);
  if (!latest) return;
  await updateConnectorProfile(profile.id, {
    config: { ...latest.config, authScheme: scheme },
  });
}

/** 按 profile 构造连接器实例（deps 仅供测试注入） */
export function buildConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  switch (profile.kind) {
    case 'notion':
      return createNotionConnector(profile, deps);
    case 'remote-mcp':
    case 'custom-mcp':
    case 'local-mcp':
      // 默认注入 401 兜底的 scheme 写回；测试可用 deps.persistAuthScheme 覆盖
      return createMcpConnector(profile, { persistAuthScheme, ...deps });
    case 'local-bridge':
      return createBridgeConnector(profile, deps);
  }
}
