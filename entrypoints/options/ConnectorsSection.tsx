/**
 * 设置页「知识库连接」目录卡（讨论稿 §2：Notion 只是内置预设之一）。
 *
 * - 已配置列表：kind 图标 + 名称 + 状态徽章 + 连接状态 + 默认写入单选 + 测试/配置/移除；
 * - 添加连接：6 个模板 tile（Notion 官方预设 / 腾讯文档 Beta / 飞书文档 Beta /
 *   Custom Remote MCP / Local Markdown Bridge / 语雀本地 MCP），点击展开对应行内表单；
 * - 腾讯文档：官方端点预填、Token 以原始值放 Authorization 头（authScheme raw）；
 *   飞书文档：个人 MCP URL 即凭据（authScheme none）；语雀：local-mcp，经本机
 *   bridge mcp-proxy 把 Python stdio 服务（yuque-mcp）代理成 HTTP；
 * - Notion 表单即原「Notion 集成」令牌 + 根页面流程（配置仍存 NotionConfig，行为不变）。
 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { Badge, Button, Card, Input, SectionTitle, Switch } from '../../components/ui';
import {
  CloudUploadIcon,
  DatabaseIcon,
  NotebookPenIcon,
  SaveIcon,
} from '../../components/icons';
import {
  assertPublicHttpsUrl,
  CONNECTOR_KIND_INFO,
  CONNECTOR_PRESETS,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_LOCAL_MCP_PORT,
  listConnectorProfiles,
  originPatternOf,
  removeConnectorProfile,
  saveConnectorProfile,
  setActiveConnectorProfileId,
  TENCENT_DOCS_MCP_ENDPOINT,
  updateConnectorProfile,
  type ConnectorKind,
  type ConnectorPreset,
  type ConnectorProfile,
  type ConnectorStatus,
  type ConnectorTestResult,
} from '../../lib/connectors';
import {
  clearNotionConfig,
  getNotionConfig,
  getPrefs,
  patchNotionConfig,
  saveNotionConfig,
  setPrefs,
  type NotionConfig,
} from '../../lib/storage';
import type { NotionPageSummary } from '../../lib/notion';

interface LastSyncInfo {
  syncStatus: string;
  lastSyncedAt: number;
  error?: string;
}

interface ConnectorListPayload {
  profiles: ConnectorProfile[];
  activeId?: string;
  lastSync: Record<string, LastSyncInfo | null>;
}

type Msg = { kind: 'ok' | 'err'; text: string } | null;

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function kindIcon(kind: ConnectorKind) {
  if (kind === 'notion') return <NotebookPenIcon size={14} />;
  if (kind === 'local-bridge' || kind === 'local-mcp') return <SaveIcon size={14} />;
  return <CloudUploadIcon size={14} />;
}

/** 既有 profile → 配置表单预设（remote-mcp 按 authScheme 区分腾讯文档 / 飞书文档） */
function presetOfProfile(p: ConnectorProfile): ConnectorPreset {
  const byId = (id: ConnectorPreset['id']): ConnectorPreset =>
    CONNECTOR_PRESETS.find((x) => x.id === id) ?? CONNECTOR_PRESETS[0];
  switch (p.kind) {
    case 'notion':
      return byId('notion');
    case 'remote-mcp':
      return byId(p.config.authScheme === 'none' ? 'feishu-docs' : 'tencent-docs');
    case 'custom-mcp':
      return byId('custom-mcp');
    case 'local-bridge':
      return byId('local-bridge');
    case 'local-mcp':
      return byId('yuque');
  }
}

function StatusBadge({ status }: { status: ConnectorStatus }) {
  if (status === 'stable') return <Badge tone="brand">官方</Badge>;
  if (status === 'beta') return <Badge tone="warning">Beta</Badge>;
  return <Badge tone="neutral">自定义</Badge>;
}

function syncStatusText(s: string): string {
  switch (s) {
    case 'synced':
      return '已同步';
    case 'syncing':
      return '同步中';
    case 'error':
      return '同步失败';
    case 'conflict':
      return '冲突';
    default:
      return '待同步';
  }
}

async function callBg(msg: Record<string, unknown>) {
  const resp = await browser.runtime.sendMessage(msg);
  if (!resp?.ok) throw new Error(resp?.error ?? '请求失败');
  return resp.data;
}

/** 请求远端 origin 的 host 权限（用户手势内调用；被拒绝不阻断保存） */
async function requestOriginQuiet(patterns: string[]): Promise<void> {
  try {
    await browser.permissions.request({ origins: patterns });
  } catch {
    /* 用户拒绝或环境不支持：保存继续，连接测试时会暴露网络错误 */
  }
}

// ---------- Notion 配置表单（原「Notion 集成」流程，配置仍存 NotionConfig） ----------

function NotionConfigForm({ onChanged }: { onChanged: () => Promise<void> }) {
  const [cfg, setCfg] = useState<NotionConfig | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const [rootQuery, setRootQuery] = useState('');
  const [rootResults, setRootResults] = useState<NotionPageSummary[]>([]);

  const reload = useCallback(async () => {
    setCfg(await getNotionConfig());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 保存令牌：先在用户手势内申请 api.notion.com 权限，再经 background 验证 */
  const onSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setBusy(true);
    setMsg(null);
    try {
      await requestOriginQuiet(['https://api.notion.com/*']);
      const info = (await callBg({ type: 'notionValidateToken', token })) as {
        id: string;
        botName: string;
        workspaceName?: string;
      };
      await saveNotionConfig({ token, botName: info.botName, botId: info.id });
      // 令牌就绪后确保存在 notion profile（添加路径下自动落一条）
      const profiles = await listConnectorProfiles();
      if (!profiles.some((p) => p.kind === 'notion')) {
        await saveConnectorProfile({
          kind: 'notion',
          name: CONNECTOR_KIND_INFO.notion.defaultName,
          status: 'stable',
          config: { binding: 'notionConfig' },
        });
      }
      await reload();
      await onChanged();
      setTokenInput('');
      setMsg({
        kind: 'ok',
        text: `令牌有效，已连接集成「${info.botName}」${info.workspaceName ? `（工作区：${info.workspaceName}）` : ''}。请再到 Notion 把目标页面共享给该集成。`,
      });
    } catch (e) {
      setMsg({ kind: 'err', text: `验证失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onSearchPages = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const pages = (await callBg({
        type: 'notionSearchPages',
        query: rootQuery.trim(),
      })) as NotionPageSummary[];
      setRootResults(pages);
      if (pages.length === 0) {
        setMsg({
          kind: 'err',
          text: '没有找到页面。请确认目标页面已在 Notion 中共享给你的集成（页面右上角 ··· → 连接 → 选择集成）。',
        });
      }
    } catch (e) {
      setMsg({ kind: 'err', text: `搜索失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onPickRoot = async (page: NotionPageSummary) => {
    const next = await patchNotionConfig({
      rootPageId: page.id,
      rootPageTitle: page.title || '（无标题页面）',
    });
    setCfg(next);
    await onChanged();
    setMsg({ kind: 'ok', text: `同步根页面已设为「${page.title || '（无标题页面）'}」` });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-2 dark:text-ink-2-dark">
        在 notion.so/my-integrations 创建「内部集成」并复制令牌；然后在 Notion
        中把目标页面「共享 / 连接」给该集成。令牌仅保存在本地（chrome.storage.local）。
      </p>

      {cfg ? (
        <p className="flex min-w-0 items-center gap-2">
          <Badge tone="success" className="shrink-0">
            已连接集成「{cfg.botName || '未命名'}」
          </Badge>
          <span className="font-mono text-xs tnum text-ink-2 dark:text-ink-2-dark">
            {maskKey(cfg.token)}
          </span>
        </p>
      ) : (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
            内部集成令牌
            <Input
              className="mt-1 font-mono"
              type="password"
              placeholder="ntn_... 或 secret_..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
          </label>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !tokenInput.trim()}
            onClick={() => void onSaveToken()}
          >
            {busy ? '验证中…' : '保存并验证'}
          </Button>
        </div>
      )}

      {cfg && (
        <div className="space-y-2 border-t border-line dark:border-line-dark pt-3">
          <p>
            同步根页面：
            {cfg.rootPageTitle ? (
              <span className="text-brand-600 dark:text-brand-300">{cfg.rootPageTitle}</span>
            ) : (
              <span className="text-amber-600 dark:text-amber-400">未选择（同步前请先选择）</span>
            )}
          </p>
          <div className="flex gap-2">
            <Input
              className="flex-1"
              placeholder="输入页面标题搜索（需已共享给集成）"
              value={rootQuery}
              onChange={(e) => setRootQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onSearchPages();
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void onSearchPages()}
              className="h-9"
            >
              搜索页面
            </Button>
          </div>
          {rootResults.length > 0 && (
            <ul className="space-y-1">
              {rootResults.map((p) => (
                <li
                  key={p.id}
                  onClick={() => void onPickRoot(p)}
                  className={`flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs cursor-pointer transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark ${
                    cfg.rootPageId === p.id ? 'ring-1 ring-brand-500' : ''
                  }`}
                >
                  <span className="flex-1 min-w-0 truncate">{p.title || '（无标题页面）'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onPickRoot(p);
                    }}
                  >
                    设为根页面
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {msg && (
        <p
          className={`text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {msg.text}
        </p>
      )}
    </div>
  );
}

// ---------- 通用连接配置表单（按预设区分：腾讯文档 / 飞书文档 / 自定义 MCP / 本地 Bridge / 语雀） ----------

function ConnectorForm({
  preset,
  profile,
  onDone,
  onCancel,
}: {
  preset: ConnectorPreset;
  profile?: ConnectorProfile;
  onDone: () => Promise<void>;
  onCancel: () => void;
}) {
  const defaultPort = preset.id === 'yuque' ? DEFAULT_LOCAL_MCP_PORT : DEFAULT_BRIDGE_PORT;
  const [name, setName] = useState(profile?.name ?? preset.defaultName);
  const [endpoint, setEndpoint] = useState(
    String(
      profile?.config.endpoint ??
        (preset.id === 'tencent-docs' ? TENCENT_DOCS_MCP_ENDPOINT : ''),
    ),
  );
  const [token, setToken] = useState(String(profile?.config.token ?? ''));
  const [port, setPort] = useState(String(profile?.config.port ?? defaultPort));
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const isRemote = preset.kind === 'remote-mcp' || preset.kind === 'custom-mcp';
  const isLocal = preset.kind === 'local-bridge' || preset.kind === 'local-mcp';
  // 飞书个人 MCP 的凭据内嵌在 URL 路径里，没有独立 Token 字段
  const showToken = preset.id !== 'feishu-docs';

  // 远程端点：实时 SSRF 校验提示
  const endpointError = (() => {
    if (!isRemote || !endpoint.trim()) return null;
    try {
      assertPublicHttpsUrl(endpoint);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  })();

  const validate = (): string | null => {
    if (isRemote) {
      try {
        assertPublicHttpsUrl(endpoint);
      } catch (e) {
        return (e as Error).message;
      }
      if (preset.id === 'tencent-docs' && !token.trim()) {
        return '请填写腾讯文档 MCP Token（获取方式见下方说明）';
      }
    }
    if (isLocal) {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return '端口必须是 1–65535 的整数';
      if (!token.trim()) return '请填写 bridge token（或点击「生成随机 token」）';
    }
    return null;
  };

  const buildConfig = (): Record<string, unknown> => {
    switch (preset.id) {
      case 'tencent-docs':
        // 官方要求 Authorization 头直接放原始 token 值（无 Bearer 前缀）
        return { endpoint: endpoint.trim(), authScheme: 'raw', token: token.trim() };
      case 'feishu-docs':
        return { endpoint: endpoint.trim(), authScheme: 'none' };
      case 'custom-mcp':
        return { endpoint: endpoint.trim(), ...(token.trim() ? { token: token.trim() } : {}) };
      case 'yuque':
        return { port: Number(port) || defaultPort, token: token.trim() };
      default:
        return { port: Number(port) || defaultPort, token: token.trim() };
    }
  };

  const buildProfile = (): Omit<ConnectorProfile, 'id' | 'createdAt'> & { id?: string } => ({
    ...(profile ? { id: profile.id } : {}),
    kind: preset.kind,
    name: name.trim() || preset.defaultName,
    status: preset.status,
    config: buildConfig(),
  });

  const onTest = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const invalid = validate();
      if (invalid) {
        setMsg({ kind: 'err', text: invalid });
        return;
      }
      const draft = { ...buildProfile(), id: 'draft', createdAt: 0 };
      const result = (await callBg({ type: 'connectorTest', profile: draft })) as ConnectorTestResult;
      setMsg({ kind: result.ok ? 'ok' : 'err', text: result.detail });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const invalid = validate();
      if (invalid) {
        setMsg({ kind: 'err', text: invalid });
        return;
      }
      if (isRemote) {
        const url = assertPublicHttpsUrl(endpoint);
        await requestOriginQuiet([originPatternOf(url)]);
      }
      if (isLocal) {
        await requestOriginQuiet(['http://127.0.0.1/*', 'http://localhost/*']);
      }
      await saveConnectorProfile(buildProfile());
      await onDone();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const tokenLabel =
    preset.id === 'tencent-docs'
      ? 'MCP Token'
      : preset.id === 'custom-mcp'
        ? 'Bearer Token（可选）'
        : 'Bridge Token';
  const tokenPlaceholder =
    preset.id === 'tencent-docs'
      ? '腾讯文档「使用MCP → 获取MCP token」'
      : preset.id === 'custom-mcp'
        ? '留空表示无鉴权'
        : 'bridge 启动时打印的 token';

  return (
    <div className="space-y-3 rounded-[10px] border border-line dark:border-line-dark p-3">
      <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
        名称
        <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      {isRemote && (
        <>
          <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
            {preset.id === 'feishu-docs' ? '个人 MCP URL' : 'MCP 端点 URL'}
            <Input
              className="mt-1 font-mono"
              placeholder={
                preset.id === 'feishu-docs'
                  ? 'https://open.feishu.cn/mcp/stream/mcp_…'
                  : 'https://example.com/mcp'
              }
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
          {showToken && (
            <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
              {tokenLabel}
              <Input
                className="mt-1 font-mono"
                type="password"
                placeholder={tokenPlaceholder}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          )}
          {endpointError && <p className="text-xs text-red-600 dark:text-red-400">{endpointError}</p>}
          {preset.id === 'tencent-docs' && (
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              官方 MCP 端点已预填（可改）。Token 获取：腾讯文档「空间列表 → ≡ → 使用MCP →
              获取MCP token」（需超级会员，有效期一年）；频率：免费 2000 次/天 · 超级会员
              20000 · Plus 40000。详见{' '}
              <a
                href="https://docs.qq.com/open/document/mcp/get-token/"
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 dark:text-brand-300 underline"
              >
                官方接入文档
              </a>
              。Token 按官方要求以原始值放入 Authorization 头（不加 Bearer 前缀），能力以端点
              tools/list 实际返回为准（Beta）。
            </p>
          )}
          {preset.id === 'feishu-docs' && (
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              在飞书 MCP 配置页按需生成个人 MCP URL（文档能力选 docx 范围）后粘贴到此处；
              URL 路径本身即凭据（mcp_ 前缀），无需额外 Token。保存时将申请 open.feishu.cn
              的访问权限，能力以端点 tools/list 实际返回为准（Beta）。
            </p>
          )}
          {preset.id === 'custom-mcp' && (
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              仅允许公网 HTTPS 端点；localhost / 内网地址会被安全策略拦截。保存时将申请该域名的访问权限。
            </p>
          )}
        </>
      )}

      {isLocal && (
        <>
          <div className="flex gap-2">
            <label className="block w-28 text-xs font-medium text-ink-2 dark:text-ink-2-dark">
              端口
              <Input
                className="mt-1 font-mono tnum"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
            <label className="block flex-1 text-xs font-medium text-ink-2 dark:text-ink-2-dark">
              {tokenLabel}
              <Input
                className="mt-1 font-mono"
                placeholder={tokenPlaceholder}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
          </div>
          {preset.id === 'yuque' ? (
            <div className="space-y-1 text-xs text-ink-2 dark:text-ink-2-dark">
              <p>语雀 MCP 是 Python stdio 服务，需经本机 bridge 代理后供扩展连接：</p>
              <p>
                ① 安装 yuque-mcp：
                <span className="font-mono"> pip install -e . </span>（或
                <span className="font-mono"> uv pip install -e . </span>，仓库
                EnglandLobster/yuque-mcp）；
              </p>
              <p>
                ② 从 <span className="font-mono">yuque.com/settings/tokens</span> 获取语雀 API
                Token；
              </p>
              <p>
                ③ 启动代理（--env 填语雀 Token，--token 填上方 bridge token）：
                <br />
                <span className="font-mono break-all">
                  node scripts/bridge.mjs mcp-proxy --command &quot;python -m yuque_mcp.server&quot;
                  --env YUQUE_API_TOKEN=&lt;语雀Token&gt; --port {port || DEFAULT_LOCAL_MCP_PORT}{' '}
                  --token &lt;bridge token&gt;
                </span>
              </p>
              <p>④ 回到此处点「连接测试」。</p>
            </div>
          ) : (
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              先在终端启动本机 bridge：
              <span className="font-mono"> node scripts/bridge.mjs --root &lt;你的笔记目录&gt; </span>
              （默认端口 {DEFAULT_BRIDGE_PORT}，--token 省略时自动生成并打印），再把端口与 token
              填到此处。一个 bridge 同时适用于 Obsidian / Logseq / 纯 Markdown 文件夹。
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={() => setToken(genToken())}>
            生成随机 token
          </Button>
        </>
      )}

      {msg && (
        <p
          className={`text-xs ${
            msg.kind === 'ok'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-red-600 dark:text-red-400'
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || (isRemote && (!endpoint.trim() || !!endpointError))}
          onClick={() => void onTest()}
        >
          连接测试
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || (isRemote && (!endpoint.trim() || !!endpointError))}
          onClick={() => void onSave()}
        >
          保存连接
        </Button>
        <Button variant="link" size="sm" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

// ---------- 目录卡 ----------

export default function ConnectorsSection() {
  const [profiles, setProfiles] = useState<ConnectorProfile[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [lastSync, setLastSync] = useState<Record<string, LastSyncInfo | null>>({});
  const [tests, setTests] = useState<Record<string, ConnectorTestResult | undefined>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState<ConnectorPreset['id'] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = (await callBg({ type: 'connectorList' })) as ConnectorListPayload;
      setProfiles(data.profiles);
      setActiveId(data.activeId);
      setLastSync(data.lastSync);
      const t: Record<string, ConnectorTestResult | undefined> = {};
      for (const p of data.profiles) {
        t[p.id] = p.config.lastTest as ConnectorTestResult | undefined;
      }
      setTests(t);
    } catch {
      /* background SW 未就绪：保持现状，用户操作会再次触发刷新 */
    }
  }, []);

  useEffect(() => {
    void reload();
    void getPrefs().then((p) => setAutoSync(p.autoSyncNotion));
  }, [reload]);

  const onSetActive = async (id: string) => {
    await setActiveConnectorProfileId(id);
    setActiveId(id);
  };

  const onTest = async (p: ConnectorProfile) => {
    setBusyId(p.id);
    try {
      const result = (await callBg({ type: 'connectorTest', profile: p })) as ConnectorTestResult;
      await updateConnectorProfile(p.id, {
        config: { ...p.config, lastTest: result },
      });
      await reload();
    } catch {
      setTests((prev) => ({
        ...prev,
        [p.id]: { ok: false, detail: '连接测试请求失败' },
      }));
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (p: ConnectorProfile) => {
    if (!confirm(`确定移除连接「${p.name}」？已同步到目标端的内容不受影响。`)) return;
    await removeConnectorProfile(p.id);
    if (p.kind === 'notion') await clearNotionConfig();
    if (editingId === p.id) setEditingId(null);
    await reload();
  };

  const onFormDone = async () => {
    setAdding(null);
    setEditingId(null);
    await reload();
  };

  const hasNotion = profiles.some((p) => p.kind === 'notion');
  const tiles = CONNECTOR_PRESETS.filter((p) => p.id !== 'notion' || !hasNotion);
  const addingPreset = CONNECTOR_PRESETS.find((p) => p.id === adding);

  return (
    <section className="space-y-3">
      <Card>
        <SectionTitle icon={<DatabaseIcon />} title="知识库连接" />
        <p className="mb-3 text-xs text-ink-2 dark:text-ink-2-dark">
          Notion 只是内置预设之一；内置 6 个连接预设（在线文档 / 自定义 MCP / 本机库），默认写入目标单选。
        </p>

        {profiles.length === 0 && (
          <p className="mb-3 text-sm text-ink-2 dark:text-ink-2-dark">
            还没有连接，请在下方选择一类添加。
          </p>
        )}

        <ul className="space-y-1">
          {profiles.map((p) => {
            const test = tests[p.id];
            const sync = lastSync[p.id];
            return (
              <li key={p.id} className="space-y-2">
                <div className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark">
                  <input
                    type="radio"
                    name="active-connector"
                    checked={activeId === p.id}
                    onChange={() => void onSetActive(p.id)}
                    title="设为默认写入目标"
                    className="h-4 w-4 shrink-0 accent-brand-500"
                  />
                  <span className="shrink-0 text-ink-2 dark:text-ink-2-dark">{kindIcon(p.kind)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{p.name}</span>
                      <StatusBadge status={p.status} />
                      {activeId === p.id && <Badge tone="brand">默认写入</Badge>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-2 dark:text-ink-2-dark">
                      {test ? (
                        <span
                          className={
                            test.ok
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }
                        >
                          {test.detail}
                        </span>
                      ) : (
                        '未测试'
                      )}
                      {sync?.lastSyncedAt
                        ? ` · 最近同步 ${new Date(sync.lastSyncedAt).toLocaleString('zh-CN')}（${syncStatusText(sync.syncStatus)}）`
                        : ''}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === p.id}
                    onClick={() => void onTest(p)}
                  >
                    {busyId === p.id ? '测试中…' : '测试'}
                  </Button>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      setAdding(null);
                      setEditingId(editingId === p.id ? null : p.id);
                    }}
                  >
                    配置
                  </Button>
                  <button
                    type="button"
                    onClick={() => void onRemove(p)}
                    className="inline-flex h-8 items-center px-2 text-xs text-ink-2 dark:text-ink-2-dark hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer"
                  >
                    移除
                  </button>
                </div>
                {editingId === p.id && (
                  <div className="px-3 pb-2">
                    {p.kind === 'notion' ? (
                      <div className="rounded-[10px] border border-line dark:border-line-dark p-3">
                        <NotionConfigForm onChanged={reload} />
                      </div>
                    ) : (
                      <ConnectorForm
                        preset={presetOfProfile(p)}
                        profile={p}
                        onDone={onFormDone}
                        onCancel={() => setEditingId(null)}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-line dark:border-line-dark pt-3">
          <span>笔记保存后自动同步到知识库</span>
          <Switch
            checked={autoSync}
            onChange={(v) => {
              setAutoSync(v);
              void setPrefs({ autoSyncNotion: v });
            }}
            aria-label="笔记保存后自动同步到知识库"
          />
        </div>

        <p className="mt-4 mb-2 text-xs font-medium text-ink-2 dark:text-ink-2-dark">添加连接</p>
        <div className="grid grid-cols-2 gap-2">
          {tiles.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setEditingId(null);
                setAdding(adding === preset.id ? null : preset.id);
              }}
              className={`rounded-[10px] border p-3 text-left transition-colors cursor-pointer ${
                adding === preset.id
                  ? 'border-brand-500 bg-brand-soft dark:bg-brand-soft-dark'
                  : 'border-line dark:border-line-dark hover:border-brand-500'
              }`}
            >
              <p className="flex items-center gap-2 font-medium">
                <span className="text-brand-500 dark:text-brand-300">{kindIcon(preset.kind)}</span>
                {preset.label}
                <StatusBadge status={preset.status} />
              </p>
              <p className="mt-1 text-xs text-ink-2 dark:text-ink-2-dark">{preset.desc}</p>
            </button>
          ))}
        </div>

        {addingPreset && (
          <div className="mt-3">
            {addingPreset.kind === 'notion' ? (
              <div className="rounded-[10px] border border-line dark:border-line-dark p-3">
                <NotionConfigForm onChanged={onFormDone} />
              </div>
            ) : (
              <ConnectorForm
                preset={addingPreset}
                onDone={onFormDone}
                onCancel={() => setAdding(null)}
              />
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
