/** 设置页：模型 Profile CRUD / 拉取模型列表 / 测试连接 / 激活切换 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  addProfile,
  getPrefs,
  getProfiles,
  removeProfile,
  setPrefs,
  updateProfile,
  type ModelProfile,
} from '../../lib/storage';

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

  const reload = useCallback(async () => {
    const [p, prefs] = await Promise.all([getProfiles(), getPrefs()]);
    setProfiles(p);
    setActiveId(prefs.activeProfileId ?? p[0]?.id);
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

  const inputCls =
    'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-sky-500';

  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-100">
      <main className="mx-auto max-w-2xl p-6 space-y-8">
        <header>
          <h1 className="text-xl font-bold">BiliNote 设置</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            模型服务配置（BYOK）。API Key 仅保存在本地（chrome.storage.local），不会同步也不会上传。
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="font-medium">已保存的配置</h2>
          {profiles.length === 0 && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">还没有配置，请在下方新增。</p>
          )}
          <ul className="space-y-2">
            {profiles.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-4 py-3"
              >
                <input
                  type="radio"
                  name="active-profile"
                  checked={activeId === p.id}
                  onChange={() => void onSetActive(p.id)}
                  title="设为当前使用的配置"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">
                    {p.name}
                    {activeId === p.id && (
                      <span className="ml-2 text-xs text-sky-600 dark:text-sky-400">使用中</span>
                    )}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                    {p.baseURL} · {maskKey(p.apiKey)} · 默认模型 {p.defaultModel}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onEdit(p)}
                  className="text-xs text-neutral-500 hover:text-sky-600 dark:hover:text-sky-400"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => void onRemove(p)}
                  className="text-xs text-neutral-500 hover:text-red-500"
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">{form.id ? '编辑配置' : '新增配置'}</h2>
          <div className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 p-4">
            <label className="block text-sm">
              名称
              <input
                className={`${inputCls} mt-1`}
                placeholder="如：Kimi / DeepSeek / 中转站"
                value={form.name}
                onChange={setField('name')}
              />
            </label>
            <label className="block text-sm">
              baseURL（OpenAI 兼容端点）
              <input
                className={`${inputCls} mt-1 font-mono`}
                placeholder="如 https://api.moonshot.cn/v1 或 https://api.deepseek.com/v1"
                value={form.baseURL}
                onChange={setField('baseURL')}
              />
            </label>
            <label className="block text-sm">
              API Key
              <input
                className={`${inputCls} mt-1 font-mono`}
                type="password"
                placeholder="sk-..."
                value={form.apiKey}
                onChange={setField('apiKey')}
              />
            </label>
            <label className="block text-sm">
              默认模型
              <input
                className={`${inputCls} mt-1 font-mono`}
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
              <button
                type="button"
                disabled={busy || !form.baseURL || !form.apiKey}
                onClick={() => void onFetchModels()}
                className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-xs hover:border-sky-500 disabled:opacity-40"
              >
                拉取模型列表
              </button>
              <button
                type="button"
                disabled={busy || !form.baseURL || !form.apiKey || !form.defaultModel}
                onClick={() => void onTest()}
                className="rounded-md border border-neutral-300 dark:border-neutral-600 px-3 py-1.5 text-xs hover:border-sky-500 disabled:opacity-40"
              >
                测试连接
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onSave()}
                className="rounded-md bg-sky-600 hover:bg-sky-500 text-white px-4 py-1.5 text-xs font-medium disabled:opacity-40"
              >
                {form.id ? '保存修改' : '保存配置'}
              </button>
              {form.id && (
                <button
                  type="button"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setModels([]);
                  }}
                  className="rounded-md px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                >
                  取消编辑
                </button>
              )}
            </div>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            支持任意 OpenAI 兼容端点（Kimi / DeepSeek / MiniMax / 自建中转）。新增配置时扩展会申请对应域名的访问权限，用于直接调用你配置的模型服务。
          </p>
        </section>
      </main>
    </div>
  );
}
