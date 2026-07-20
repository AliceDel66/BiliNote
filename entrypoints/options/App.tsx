/** 设置页：模型 Profile CRUD / Notion 集成 / 偏好开关 / 数据管理 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  Badge,
  Button,
  Card,
  Input,
  SectionTitle,
  Switch,
} from '../../components/ui';
import {
  CheckIcon,
  CloudUploadIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  NotebookPenIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  ZapIcon,
} from '../../components/icons';
import {
  addProfile,
  db,
  getNotionConfig,
  getPrefs,
  getProfiles,
  patchNotionConfig,
  clearNotionConfig,
  removeProfile,
  saveNotionConfig,
  setPrefs,
  updateProfile,
  type ModelProfile,
  type NotionConfig,
} from '../../lib/storage';
import type { NotionPageSummary } from '../../lib/notion';

interface FormState {
  id: string | null;
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  baseURL: '',
  apiKey: '',
  defaultModel: '',
};

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

function originPattern(baseURL: string): string | null {
  try {
    return `${new URL(baseURL).origin}/*`;
  } catch {
    return null;
  }
}

export default function App() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [models, setModels] = useState<string[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- Notion 集成（内部集成令牌，F-07）----
  const [notionCfg, setNotionCfg] = useState<NotionConfig | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [notionMsg, setNotionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [notionBusy, setNotionBusy] = useState(false);
  const [rootQuery, setRootQuery] = useState('');
  const [rootResults, setRootResults] = useState<NotionPageSummary[]>([]);

  // ---- 偏好开关 ----
  const [autoSync, setAutoSync] = useState(true);
  const [danmaku, setDanmaku] = useState(false);
  const [chatAutoRecord, setChatAutoRecord] = useState(true);
  // 数据边界（ABC 混合 · C 逐项开关，默认全开 = 最小暴露基线）
  const [privSubtitles, setPrivSubtitles] = useState(true);
  const [privNote, setPrivNote] = useState(true);
  const [privMeta, setPrivMeta] = useState(true);

  const [dataBusy, setDataBusy] = useState(false);

  const reload = useCallback(async () => {
    const [p, prefs, notion] = await Promise.all([getProfiles(), getPrefs(), getNotionConfig()]);
    setProfiles(p);
    setActiveId(prefs.activeProfileId ?? p[0]?.id);
    setAutoSync(prefs.autoSyncNotion);
    setDanmaku(prefs.includeDanmaku);
    setChatAutoRecord(prefs.chatAutoRecord);
    setPrivSubtitles(prefs.privacySendSubtitles);
    setPrivNote(prefs.privacySendNoteExcerpt);
    setPrivMeta(prefs.privacySendPlaybackMeta);
    setNotionCfg(notion);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setField = (k: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const callBg = async (msg: Record<string, unknown>) => {
    const resp = await browser.runtime.sendMessage(msg);
    if (!resp?.ok) throw new Error(resp?.error ?? '请求失败');
    return resp.data;
  };

  const onFetchModels = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const list = (await callBg({
        type: 'fetchModels',
        baseURL: form.baseURL,
        apiKey: form.apiKey,
      })) as string[];
      setModels(list);
      if (list.length > 0 && !list.includes(form.defaultModel)) {
        setForm((f) => ({ ...f, defaultModel: list[0] }));
      }
      setMessage({ kind: 'ok', text: `成功拉取 ${list.length} 个模型` });
    } catch (e) {
      setModels([]);
      setMessage({
        kind: 'err',
        text: `拉取失败：${(e as Error).message}。可直接手动填写模型名。`,
      });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const { latencyMs } = (await callBg({
        type: 'testConnection',
        baseURL: form.baseURL,
        apiKey: form.apiKey,
        model: form.defaultModel,
      })) as { latencyMs: number };
      setMessage({ kind: 'ok', text: `连接成功（${latencyMs}ms）` });
    } catch (e) {
      setMessage({ kind: 'err', text: `连接失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onSave = async () => {
    if (!form.name.trim() || !form.baseURL.trim() || !form.apiKey.trim() || !form.defaultModel.trim()) {
      setMessage({ kind: 'err', text: '请完整填写名称、baseURL、API Key 与默认模型' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (form.id) {
        await updateProfile(form.id, {
          name: form.name.trim(),
          baseURL: form.baseURL.trim(),
          apiKey: form.apiKey.trim(),
          defaultModel: form.defaultModel.trim(),
          models,
        });
      } else {
        // 新增配置：申请该端点的 host 权限（用户手势内）
        const pattern = originPattern(form.baseURL.trim());
        if (pattern) {
          try {
            await browser.permissions.request({ origins: [pattern] });
          } catch {
            /* 用户拒绝或环境不支持，仍可保存（分析时可能报网络错误） */
          }
        }
        await addProfile({
          name: form.name.trim(),
          baseURL: form.baseURL.trim(),
          apiKey: form.apiKey.trim(),
          defaultModel: form.defaultModel.trim(),
          models,
        });
      }
      await reload();
      setForm(EMPTY_FORM);
      setModels([]);
      setMessage({ kind: 'ok', text: '已保存' });
    } catch (e) {
      setMessage({ kind: 'err', text: `保存失败：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const onEdit = (p: ModelProfile) => {
    setForm({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      apiKey: p.apiKey,
      defaultModel: p.defaultModel,
    });
    setModels(p.models);
    setMessage(null);
  };

  const onRemove = async (p: ModelProfile) => {
    if (!confirm(`确定删除配置「${p.name}」？`)) return;
    await removeProfile(p.id);
    await reload();
  };

  const onSetActive = async (id: string) => {
    await setPrefs({ activeProfileId: id });
    setActiveId(id);
  };

  // ---- Notion 集成 ----

  /** 保存令牌：先在用户手势内申请 api.notion.com 权限，再经 background 验证 */
  const onSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setNotionBusy(true);
    setNotionMsg(null);
    try {
      try {
        await browser.permissions.request({ origins: ['https://api.notion.com/*'] });
      } catch {
        /* 用户拒绝授权：下面的验证请求会失败并提示 */
      }
      const info = (await callBg({ type: 'notionValidateToken', token })) as {
        botName: string;
        workspaceName?: string;
      };
      await saveNotionConfig({ token, botName: info.botName });
      setNotionCfg(await getNotionConfig());
      setTokenInput('');
      setNotionMsg({
        kind: 'ok',
        text: `令牌有效，已连接集成「${info.botName}」${info.workspaceName ? `（工作区：${info.workspaceName}）` : ''}。请再到 Notion 把目标页面共享给该集成。`,
      });
    } catch (e) {
      setNotionMsg({ kind: 'err', text: `验证失败：${(e as Error).message}` });
    } finally {
      setNotionBusy(false);
    }
  };

  const onClearToken = async () => {
    if (!confirm('确定移除 Notion 集成配置？已同步的页面不受影响。')) return;
    await clearNotionConfig();
    setNotionCfg(null);
    setRootResults([]);
    setNotionMsg(null);
  };

  const onSearchPages = async () => {
    setNotionBusy(true);
    setNotionMsg(null);
    try {
      const pages = (await callBg({
        type: 'notionSearchPages',
        query: rootQuery.trim(),
      })) as NotionPageSummary[];
      setRootResults(pages);
      if (pages.length === 0) {
        setNotionMsg({
          kind: 'err',
          text: '没有找到页面。请确认目标页面已在 Notion 中共享给你的集成（页面右上角 ··· → 连接 → 选择集成）。',
        });
      }
    } catch (e) {
      setNotionMsg({ kind: 'err', text: `搜索失败：${(e as Error).message}` });
    } finally {
      setNotionBusy(false);
    }
  };

  const onPickRoot = async (page: NotionPageSummary) => {
    const next = await patchNotionConfig({
      rootPageId: page.id,
      rootPageTitle: page.title || '（无标题页面）',
    });
    setNotionCfg(next);
    setNotionMsg({ kind: 'ok', text: `同步根页面已设为「${page.title || '（无标题页面）'}」` });
  };

  // ---- 偏好开关 ----

  const onToggleAutoSync = async (v: boolean) => {
    setAutoSync(v);
    await setPrefs({ autoSyncNotion: v });
  };

  const onToggleDanmaku = async (v: boolean) => {
    setDanmaku(v);
    await setPrefs({ includeDanmaku: v });
  };

  const onToggleChatAutoRecord = async (v: boolean) => {
    setChatAutoRecord(v);
    await setPrefs({ chatAutoRecord: v });
  };

  // ---- 数据边界（ABC 混合 · C 逐项开关）----
  const onTogglePrivSubtitles = async (v: boolean) => {
    setPrivSubtitles(v);
    await setPrefs({ privacySendSubtitles: v });
  };
  const onTogglePrivNote = async (v: boolean) => {
    setPrivNote(v);
    await setPrefs({ privacySendNoteExcerpt: v });
  };
  const onTogglePrivMeta = async (v: boolean) => {
    setPrivMeta(v);
    await setPrefs({ privacySendPlaybackMeta: v });
  };

  // ---- 数据管理（F-08）----

  const onExport = async () => {
    setDataBusy(true);
    try {
      const [videos, subtitles, summaries, notes, noteVersions, notionMappings, chatSessions, chatTopics, chatTurns, prefs] =
        await Promise.all([
          db.videos.toArray(),
          db.subtitles.toArray(),
          db.summaries.toArray(),
          db.notes.toArray(),
          db.noteVersions.toArray(),
          db.notionMappings.toArray(),
          db.chatSessions.toArray(),
          db.chatTopics.toArray(),
          db.chatTurns.toArray(),
          getPrefs(),
        ]);
      const payload = {
        app: 'bilinote',
        exportedAt: new Date().toISOString(),
        tables: { videos, subtitles, summaries, notes, noteVersions, notionMappings, chatSessions, chatTopics, chatTurns },
        prefs,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bilinote-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDataBusy(false);
    }
  };

  const onClearAll = async () => {
    if (!confirm('确定清空全部本地数据？包括笔记、分析缓存、模型配置与 Notion 令牌。')) return;
    if (!confirm('此操作不可恢复，请再次确认。')) return;
    setDataBusy(true);
    try {
      await db.delete();
      await browser.storage.local.clear();
      await browser.storage.sync.clear();
      location.reload();
    } finally {
      setDataBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-page dark:bg-page-dark text-ink dark:text-ink-dark text-[13px]">
      <main className="mx-auto max-w-2xl p-6 space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-[6px] gradient-brand">
              <NotebookPenIcon size={12} className="text-white" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight">BiliNote</span>
          </div>
          <h1 className="text-[17px] font-semibold tracking-tight">设置</h1>
          <p className="text-sm text-ink-2 dark:text-ink-2-dark">
            模型服务配置（BYOK）。API Key 仅保存在本地（chrome.storage.local），不会同步也不会上传。
          </p>
        </header>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<DatabaseIcon />} title="已保存的配置" />
            {profiles.length === 0 && (
              <p className="text-sm text-ink-2 dark:text-ink-2-dark">
                还没有配置，请在下方新增。
              </p>
            )}
            <ul className="space-y-1">
              {profiles.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2 dark:hover:bg-surface-2-dark"
                >
                  <input
                    type="radio"
                    name="active-profile"
                    checked={activeId === p.id}
                    onChange={() => void onSetActive(p.id)}
                    title="设为当前使用的配置"
                    className="h-4 w-4 shrink-0 accent-brand-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{p.name}</span>
                      {activeId === p.id && <Badge tone="brand">使用中</Badge>}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-ink-2 dark:text-ink-2-dark">
                      {p.baseURL} ·{' '}
                      <span className="font-mono tnum">{maskKey(p.apiKey)}</span> · 默认模型{' '}
                      {p.defaultModel}
                    </p>
                  </div>
                  <Button variant="link" size="sm" onClick={() => onEdit(p)}>
                    编辑
                  </Button>
                  <button
                    type="button"
                    onClick={() => void onRemove(p)}
                    className="inline-flex h-8 items-center gap-1 px-2 text-xs text-ink-2 dark:text-ink-2-dark hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer"
                  >
                    <Trash2Icon size={12} />
                    删除
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle
              icon={<PlusIcon />}
              title={form.id ? '编辑配置' : '新增配置'}
            />
            <div className="space-y-3">
              <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
                名称
                <Input
                  className="mt-1"
                  placeholder="如：Kimi / DeepSeek / 中转站"
                  value={form.name}
                  onChange={setField('name')}
                />
              </label>
              <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
                baseURL（OpenAI 兼容端点）
                <Input
                  className="mt-1 font-mono"
                  placeholder="如 https://api.moonshot.cn/v1 或 https://api.deepseek.com/v1"
                  value={form.baseURL}
                  onChange={setField('baseURL')}
                />
              </label>
              <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
                API Key
                <Input
                  className="mt-1 font-mono"
                  type="password"
                  placeholder="sk-..."
                  value={form.apiKey}
                  onChange={setField('apiKey')}
                />
              </label>
              <label className="block text-xs font-medium text-ink-2 dark:text-ink-2-dark">
                默认模型
                <Input
                  className="mt-1 font-mono"
                  list="bilinote-models"
                  placeholder="点击「拉取模型列表」或手动填写，如 moonshot-v1-8k"
                  value={form.defaultModel}
                  onChange={setField('defaultModel')}
                />
                <datalist id="bilinote-models">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </label>

              {message && (
                <p
                  className={`text-xs ${
                    message.kind === 'ok'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {message.text}
                </p>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !form.baseURL || !form.apiKey}
                  onClick={() => void onFetchModels()}
                >
                  拉取模型列表
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || !form.baseURL || !form.apiKey || !form.defaultModel}
                  onClick={() => void onTest()}
                >
                  测试连接
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void onSave()}
                >
                  <CheckIcon size={12} className="text-white" />
                  {form.id ? '保存修改' : '保存配置'}
                </Button>
                {form.id && (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => {
                      setForm(EMPTY_FORM);
                      setModels([]);
                    }}
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </div>
          </Card>
          <p className="text-xs text-ink-2 dark:text-ink-2-dark">
            支持任意 OpenAI 兼容端点（Kimi / DeepSeek / MiniMax /
            自建中转）。新增配置时扩展会申请对应域名的访问权限，用于直接调用你配置的模型服务。
          </p>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<CloudUploadIcon />} title="Notion 集成" />
            <div className="space-y-3">
              <p className="text-xs text-ink-2 dark:text-ink-2-dark">
                在 notion.so/my-integrations 创建「内部集成」并复制令牌；然后在 Notion
                中把目标页面「共享 / 连接」给该集成。令牌仅保存在本地（chrome.storage.local）。
              </p>

              {notionCfg ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="flex min-w-0 items-center gap-2">
                    <Badge tone="success" className="shrink-0">
                      已连接集成「{notionCfg.botName || '未命名'}」
                    </Badge>
                    <span className="font-mono text-xs tnum text-ink-2 dark:text-ink-2-dark">
                      {maskKey(notionCfg.token)}
                    </span>
                  </p>
                  <Button
                    variant="dangerGhost"
                    size="sm"
                    onClick={() => void onClearToken()}
                    className="shrink-0"
                  >
                    移除集成
                  </Button>
                </div>
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
                    disabled={notionBusy || !tokenInput.trim()}
                    onClick={() => void onSaveToken()}
                  >
                    {notionBusy ? '验证中…' : '保存并验证'}
                  </Button>
                </div>
              )}

              {notionCfg && (
                <div className="space-y-2 border-t border-line dark:border-line-dark pt-3">
                  <p>
                    同步根页面：
                    {notionCfg.rootPageTitle ? (
                      <span className="text-brand-600 dark:text-brand-300">
                        {notionCfg.rootPageTitle}
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        未选择（同步前请先选择）
                      </span>
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
                      disabled={notionBusy}
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
                            notionCfg.rootPageId === p.id ? 'ring-1 ring-brand-500' : ''
                          }`}
                        >
                          <span className="flex-1 min-w-0 truncate">
                            {p.title || '（无标题页面）'}
                          </span>
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

                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span>笔记保存后自动同步到 Notion</span>
                    <Switch
                      checked={autoSync}
                      onChange={(v) => void onToggleAutoSync(v)}
                      aria-label="笔记保存后自动同步到 Notion"
                    />
                  </div>
                </div>
              )}

              {notionMsg && (
                <p
                  className={`text-xs ${
                    notionMsg.kind === 'ok'
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {notionMsg.text}
                </p>
              )}
            </div>
          </Card>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<ZapIcon />} title="分析增强" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-ink-2 dark:text-ink-2-dark">
                分析时附带「弹幕高光」上下文（按分钟采样，辅助定位重点片段）
              </p>
              <Switch
                checked={danmaku}
                onChange={(v) => void onToggleDanmaku(v)}
                aria-label="分析时附带弹幕高光上下文"
              />
            </div>
          </Card>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<SparklesIcon />} title="AI 答疑" />
            <div className="flex items-center justify-between gap-3">
              <p className="text-ink-2 dark:text-ink-2-dark">
                完整回答后自动把问答记录到当前课程笔记（对话页可按课程临时关闭）
              </p>
              <Switch
                checked={chatAutoRecord}
                onChange={(v) => void onToggleChatAutoRecord(v)}
                aria-label="自动记录问答到课程笔记"
              />
            </div>
          </Card>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<EyeIcon />} title="数据边界" />
            <p className="mb-3 text-xs text-ink-2 dark:text-ink-2-dark">
              控制答疑时哪些内容可以发送给你配置的模型（默认最小暴露：仅当前问题必需的最小片段）。
              跨课程笔记与 MCP 知识源等外部数据源接入时，将按「首次使用逐源询问并记住选择」处理。
            </p>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ink-2 dark:text-ink-2-dark">
                  发送当前时间窗口字幕
                  <span className="block text-xs text-ink-3 dark:text-ink-3-dark">
                    关闭后课程内容不出本地，答疑按「无字幕」降级回答
                  </span>
                </p>
                <Switch
                  checked={privSubtitles}
                  onChange={(v) => void onTogglePrivSubtitles(v)}
                  aria-label="发送当前时间窗口字幕"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-ink-2 dark:text-ink-2-dark">
                  发送当前笔记摘录（≤800 字）
                  <span className="block text-xs text-ink-3 dark:text-ink-3-dark">
                    仅当前课程的笔记片段，用于结合你的批注回答
                  </span>
                </p>
                <Switch
                  checked={privNote}
                  onChange={(v) => void onTogglePrivNote(v)}
                  aria-label="发送当前笔记摘录"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-ink-2 dark:text-ink-2-dark">
                  发送播放元信息（视频标题 / 链接）
                  <span className="block text-xs text-ink-3 dark:text-ink-3-dark">
                    关闭后模型只知道分 P 与时间点，不知道你在看哪部视频
                  </span>
                </p>
                <Switch
                  checked={privMeta}
                  onChange={(v) => void onTogglePrivMeta(v)}
                  aria-label="发送播放元信息"
                />
              </div>
            </div>
          </Card>
        </section>

        <section className="space-y-3">
          <Card>
            <SectionTitle icon={<DownloadIcon />} title="数据管理" />
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={dataBusy}
                  onClick={() => void onExport()}
                >
                  导出全部数据
                </Button>
                <Button
                  variant="dangerGhost"
                  size="sm"
                  disabled={dataBusy}
                  onClick={() => void onClearAll()}
                >
                  <Trash2Icon size={12} />
                  清空本地数据
                </Button>
              </div>
              <p className="text-xs text-ink-2 dark:text-ink-2-dark">
                导出为 JSON（视频 / 字幕缓存 / 总结 / 笔记 / 问答会话 /
                同步映射与偏好），不包含 API Key 与 Notion
                令牌。清空操作需二次确认且不可恢复。
              </p>
            </div>
          </Card>
        </section>
      </main>
    </div>
  );
}
