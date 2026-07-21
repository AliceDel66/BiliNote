/** 设置页：模型 Profile CRUD / 知识库连接 / 偏好开关 / 数据管理 */
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
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  ZapIcon,
} from '../../components/icons';
import {
  addProfile,
  db,
  getPrefs,
  getProfiles,
  removeProfile,
  setPrefs,
  updateProfile,
  type ModelProfile,
} from '../../lib/storage';
import ConnectorsSection from './ConnectorsSection';

interface FormState {
  id: string | null;
  name: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}

/** 设置分组锚点导航（左侧 sticky） */
const SECTIONS = [
  { id: 'sec-model', label: '模型服务' },
  { id: 'sec-connectors', label: '知识库连接' },
  { id: 'sec-enhance', label: '分析增强' },
  { id: 'sec-chat', label: 'AI 答疑' },
  { id: 'sec-privacy', label: '数据边界' },
  { id: 'sec-data', label: '数据管理' },
] as const;

function navItemClass(active: boolean): string {
  return `block rounded-lg border-l-[3px] px-3 py-2 text-[13px] transition-colors duration-150 ${
    active
      ? 'border-brand-500 bg-brand-soft dark:bg-brand-soft-dark text-brand-600 dark:text-brand-300 font-medium'
      : 'border-transparent text-ink-2 dark:text-ink-2-dark hover:bg-surface-2 dark:hover:bg-surface-2-dark hover:text-ink dark:hover:text-ink-dark'
  }`;
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

  // ---- 偏好开关 ----
  const [danmaku, setDanmaku] = useState(false);
  const [chatAutoRecord, setChatAutoRecord] = useState(true);
  // 数据边界（ABC 混合 · C 逐项开关，默认全开 = 最小暴露基线）
  const [privSubtitles, setPrivSubtitles] = useState(true);
  const [privNote, setPrivNote] = useState(true);
  const [privMeta, setPrivMeta] = useState(true);

  const [dataBusy, setDataBusy] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(SECTIONS[0].id);

  // 滚动随动高亮当前设置分组
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSection(e.target.id);
        }
      },
      { rootMargin: '-20% 0px -65% 0px' },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const reload = useCallback(async () => {
    const [p, prefs] = await Promise.all([getProfiles(), getPrefs()]);
    setProfiles(p);
    setActiveId(prefs.activeProfileId ?? p[0]?.id);
    setDanmaku(prefs.includeDanmaku);
    setChatAutoRecord(prefs.chatAutoRecord);
    setPrivSubtitles(prefs.privacySendSubtitles);
    setPrivNote(prefs.privacySendNoteExcerpt);
    setPrivMeta(prefs.privacySendPlaybackMeta);
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

  // ---- 偏好开关 ----

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
      const [videos, subtitles, summaries, notes, noteVersions, notionMappings, chatSessions, chatTopics, chatTurns, connectorSync, prefs] =
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
          db.connectorSync.toArray(),
          getPrefs(),
        ]);
      const payload = {
        app: 'bilinote',
        exportedAt: new Date().toISOString(),
        tables: { videos, subtitles, summaries, notes, noteVersions, notionMappings, chatSessions, chatTopics, chatTurns, connectorSync },
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
    if (!confirm('确定清空全部本地数据？包括笔记、分析缓存、模型配置与知识库连接凭据。')) return;
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
      <div className="mx-auto max-w-5xl px-8 py-8">
        <header className="border-b border-line dark:border-line-dark pb-6">
          <div className="flex items-center gap-3">
            <img src="/icon/128.png" alt="BiliNote" className="h-8 w-8 rounded-[8px]" />
            <div>
              <h1 className="text-[20px] font-semibold leading-tight tracking-tight">设置</h1>
              <p className="mt-0.5 text-xs text-ink-2 dark:text-ink-2-dark">
                模型服务配置（BYOK）· 本地优先 · API Key 仅保存在本地（chrome.storage.local），不会同步也不会上传
              </p>
            </div>
          </div>
        </header>

        <div className="mt-8 flex gap-10">
          {/* 左侧锚点导航（sticky，滚动随动高亮） */}
          <aside className="sticky top-8 hidden w-[180px] shrink-0 self-start md:block">
            <nav className="space-y-0.5">
              {SECTIONS.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToSection(s.id);
                  }}
                  className={navItemClass(activeSection === s.id)}
                >
                  {s.label}
                </a>
              ))}
            </nav>
          </aside>

          <main className="min-w-0 max-w-2xl flex-1 space-y-6">
        <section id="sec-model" className="space-y-6 scroll-mt-8">
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

        <section id="sec-connectors" className="scroll-mt-8">
          <ConnectorsSection />
        </section>

        <section id="sec-enhance" className="scroll-mt-8">
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

        <section id="sec-chat" className="scroll-mt-8">
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

        <section id="sec-privacy" className="scroll-mt-8">
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

        <section id="sec-data" className="scroll-mt-8">
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
                同步映射与偏好），不包含 API Key 与知识库连接凭据（Notion 令牌 /
                MCP Token 等）。清空操作需二次确认且不可恢复。
              </p>
            </div>
          </Card>
        </section>
          </main>
        </div>
      </div>
    </div>
  );
}
