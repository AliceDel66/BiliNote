/** Side Panel 主界面：当前视频卡片 + 一键分析 + 流式结果渲染 + 笔记（F-05） */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import TimestampLink from '../../components/TimestampLink';
import MarkdownPreview from '../../components/MarkdownPreview';
import {
  Badge,
  Button,
  Card,
  ProgressBar,
  SectionTitle,
  type BadgeTone,
} from '../../components/ui';
import {
  CircleCheckBigIcon,
  ClapperboardIcon,
  CloudUploadIcon,
  FileTextIcon,
  GraduationCapIcon,
  LightbulbIcon,
  ListTreeIcon,
  NotebookPenIcon,
  OctagonXIcon,
  RefreshCwIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
  ZapIcon,
} from '../../components/icons';
import { formatTimestamp } from '../../lib/types';
import {
  createNote,
  deleteNote,
  listNotesByVideo,
  saveNote,
  type NoteRow,
  type NotionMappingRow,
} from '../../lib/storage';
import {
  ANALYZE_PORT,
  type AnalyzePortEvent,
  type VideoContextInfo,
} from '../../lib/messages';
import { analysisToMarkdown, type AnalysisResult } from '../../lib/summarize';

type Status =
  | 'loading'
  | 'no-video'
  | 'ready'
  | 'analyzing'
  | 'done'
  | 'no-subtitle'
  | 'error';

interface ProgressState {
  text: string;
  streamText: string;
  /** 真实进度百分比（chunk 阶段 0–90，reduce 封顶 95，完成即 100） */
  pct: number;
}

/** 同步徽章文案与色调 */
function syncBadge(
  mapping: NotionMappingRow | null,
  note: NoteRow | undefined,
): { text: string; tone: BadgeTone } {
  const status = mapping?.syncStatus ?? (note?.dirty ? 'pending' : 'synced');
  switch (status) {
    case 'syncing':
      return { text: '同步中…', tone: 'brand' };
    case 'synced':
      return { text: '已同步', tone: 'success' };
    case 'conflict':
      return { text: '冲突', tone: 'warning' };
    case 'error':
      return { text: '同步失败', tone: 'danger' };
    default:
      return { text: '未同步', tone: 'neutral' };
  }
}

export default function App() {
  const [status, setStatus] = useState<Status>('loading');
  const [ctx, setCtx] = useState<VideoContextInfo | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<ProgressState>({ text: '', streamText: '', pct: 0 });
  const portRef = useRef<Browser.runtime.Port | null>(null);
  const ctxRef = useRef<VideoContextInfo | null>(null);
  ctxRef.current = ctx;

  // ---- 笔记（F-05）----
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [savedDraft, setSavedDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncInfo, setSyncInfo] = useState<NotionMappingRow | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const savedDraftRef = useRef(savedDraft);
  savedDraftRef.current = savedDraft;
  const activeNoteIdRef = useRef(activeNoteId);
  activeNoteIdRef.current = activeNoteId;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeNote = notes.find((n) => n.id === activeNoteId);

  const refreshContext = useCallback(async () => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'getVideoContext' });
      const next = (resp?.data ?? null) as VideoContextInfo | null;
      const prev = ctxRef.current;
      setCtx(next);
      if (!next) {
        setStatus((s) => (s === 'analyzing' ? s : 'no-video'));
        return;
      }
      // 切换了视频/分P → 重置结果视图
      if (!prev || prev.bvid !== next.bvid || prev.p !== next.p) {
        setResult(null);
        setCached(false);
        setError('');
        setStatus((s) => (s === 'analyzing' ? s : 'ready'));
      } else {
        setStatus((s) => (s === 'loading' || s === 'no-video' ? 'ready' : s));
      }
    } catch {
      setStatus((s) => (s === 'analyzing' ? s : 'no-video'));
    }
  }, []);

  useEffect(() => {
    void refreshContext();
    const timer = setInterval(() => void refreshContext(), 1500);
    return () => clearInterval(timer);
  }, [refreshContext]);

  useEffect(() => () => portRef.current?.disconnect(), []);

  const stopPort = () => {
    portRef.current?.disconnect();
    portRef.current = null;
  };

  const analyze = (force: boolean) => {
    const c = ctxRef.current;
    if (!c) return;
    stopPort();
    setStatus('analyzing');
    setResult(null);
    setCached(false);
    setError('');
    setProgress({ text: '准备中…', streamText: '', pct: 0 });

    const port = browser.runtime.connect({ name: ANALYZE_PORT });
    portRef.current = port;
    port.onMessage.addListener((e: AnalyzePortEvent) => {
      switch (e.type) {
        case 'chunk-start':
          setProgress((p) => ({
            ...p,
            text: `正在分析片段 ${e.index + 1}/${e.total}…`,
            pct: Math.min(95, Math.round((e.index / e.total) * 90)),
          }));
          break;
        case 'chunk-done':
          setProgress((p) => ({
            ...p,
            text: `片段 ${e.index + 1}/${e.total} 完成：${e.preview}`,
            pct: Math.min(95, Math.round(((e.index + 1) / e.total) * 90)),
          }));
          break;
        case 'reduce-start':
          setProgress((p) => ({ ...p, text: '正在生成课程大纲…', pct: 95 }));
          break;
        case 'reduce-delta':
          setProgress((p) => ({ ...p, streamText: e.text }));
          break;
        case 'done':
          setResult(e.result);
          setStatus('done');
          stopPort();
          break;
        case 'done-cached':
          setResult(e.result);
          setCached(true);
          setStatus('done');
          stopPort();
          break;
        case 'no-subtitle':
          setStatus('no-subtitle');
          stopPort();
          break;
        case 'error':
          setError(e.message);
          setStatus('error');
          stopPort();
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });
    port.postMessage({ type: 'analyze', bvid: c.bvid, p: c.p, force });
  };

  const cancel = () => {
    portRef.current?.postMessage({ type: 'cancel' });
    stopPort();
    setStatus(ctxRef.current ? 'ready' : 'no-video');
  };

  const seek = (seconds: number) => {
    void browser.runtime
      .sendMessage({ type: 'seek', seconds, p: ctxRef.current?.p })
      .catch(() => {});
  };

  const openOptions = () => void browser.runtime.openOptionsPage();

  // ---- 笔记逻辑 ----

  const refreshSyncInfo = useCallback(async (noteId: number) => {
    try {
      const resp = await browser.runtime.sendMessage({ type: 'notionSyncStatus', noteId });
      if (activeNoteIdRef.current === noteId) {
        setSyncInfo((resp?.data ?? null) as NotionMappingRow | null);
      }
    } catch {
      /* background 未就绪 */
    }
  }, []);

  const loadNotes = useCallback(async (bvid: string) => {
    try {
      setNotes(await listNotesByVideo(bvid));
    } catch {
      /* IndexedDB 未就绪 */
    }
  }, []);

  useEffect(() => {
    if (ctx?.bvid) void loadNotes(ctx.bvid);
  }, [ctx?.bvid, loadNotes]);

  // 同步状态轮询（编辑器打开期间 2s 一次，本地消息开销极低）
  useEffect(() => {
    if (!activeNoteId) return;
    void refreshSyncInfo(activeNoteId);
    const timer = setInterval(() => void refreshSyncInfo(activeNoteId), 2000);
    return () => clearInterval(timer);
  }, [activeNoteId, refreshSyncInfo]);

  /** 立即落盘未保存的草稿（切换笔记 / 卸载前调用） */
  const flushDraft = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const id = activeNoteIdRef.current;
    const content = draftRef.current;
    if (!id || content === savedDraftRef.current) return;
    setSaving(true);
    try {
      await saveNote(id, { contentMd: content });
      setSavedDraft(content);
      void browser.runtime.sendMessage({ type: 'noteSaved', noteId: id }).catch(() => {});
      void refreshSyncInfo(id);
    } finally {
      setSaving(false);
    }
  }, [refreshSyncInfo]);

  useEffect(() => () => void flushDraft(), [flushDraft]);

  // 切换视频：先落盘当前草稿，再关闭编辑器（避免编辑到别的视频的笔记）
  const prevBvidRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const bvid = ctx?.bvid;
    if (prevBvidRef.current === bvid) return;
    prevBvidRef.current = bvid;
    void flushDraft().then(() => {
      setActiveNoteId(null);
      setDraft('');
      setSavedDraft('');
      setSyncInfo(null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 bvid 变化时触发
  }, [ctx?.bvid, flushDraft]);

  const onDraftChange = (value: string) => {
    setDraft(value);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    // 自动保存：1s 防抖（PRD F-05）
    saveTimerRef.current = setTimeout(() => void flushDraft(), 1000);
  };

  const selectNote = async (note: NoteRow) => {
    if (note.id === activeNoteId) return;
    await flushDraft();
    setActiveNoteId(note.id ?? null);
    setDraft(note.contentMd);
    setSavedDraft(note.contentMd);
    setPreview(false);
    setSyncInfo(null);
  };

  /** 分析完成 → 存为笔记（标题 = 视频标题 + 分P，内容 = 元信息头 + 大纲 + 分段总结等） */
  const saveAsNote = async () => {
    const c = ctxRef.current;
    const r = result;
    if (!c || !r) return;
    await flushDraft();
    const part =
      c.pages.length > 1 && c.pages[c.p - 1] ? ` · P${c.p} ${c.pages[c.p - 1].part}` : '';
    const note = await createNote({
      bvid: c.bvid,
      cid: c.cid,
      title: `${c.title}${part}`,
      contentMd: analysisToMarkdown(r, {
        videoTitle: c.title,
        partLabel:
          c.pages.length > 1 ? `P${c.p} ${c.pages[c.p - 1]?.part ?? ''}` : undefined,
        owner: c.owner,
        url: `https://www.bilibili.com/${c.bvid}${c.p > 1 ? `?p=${c.p}` : ''}`,
        generatedAt: new Date(),
      }),
      source: 'ai',
    });
    await loadNotes(c.bvid);
    setActiveNoteId(note.id ?? null);
    setDraft(note.contentMd);
    setSavedDraft(note.contentMd);
    setPreview(true);
    setSyncInfo(null);
    void browser.runtime
      .sendMessage({ type: 'noteSaved', noteId: note.id })
      .catch(() => {});
    if (note.id) void refreshSyncInfo(note.id);
  };

  const removeNote = async (note: NoteRow) => {
    if (!note.id || !confirm(`确定删除笔记「${note.title}」？`)) return;
    await deleteNote(note.id);
    if (activeNoteId === note.id) {
      setActiveNoteId(null);
      setDraft('');
      setSavedDraft('');
      setSyncInfo(null);
    }
    if (ctxRef.current) await loadNotes(ctxRef.current.bvid);
  };

  const syncNow = async (force: boolean) => {
    const id = activeNoteIdRef.current;
    if (!id) return;
    setSyncBusy(true);
    try {
      await flushDraft();
      const resp = await browser.runtime.sendMessage({
        type: 'notionSyncNote',
        noteId: id,
        force,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? '同步失败');
      setSyncInfo(resp.data as NotionMappingRow);
    } catch (e) {
      setSyncInfo((prev) => ({
        ...(prev ?? { noteId: id, lastSyncedAt: 0, notionLastEditedTime: '' }),
        syncStatus: 'error',
        error: (e as Error).message,
      }));
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-page dark:bg-page-dark text-ink dark:text-ink-dark text-[13px]">
      <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-line dark:border-line-dark bg-page/75 dark:bg-page-dark/75 backdrop-blur-[12px]">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded-[6px] gradient-brand">
            <NotebookPenIcon size={12} className="text-white" />
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight">BiliNote</h1>
        </div>
        <button
          type="button"
          onClick={openOptions}
          title="模型设置"
          className="flex h-8 w-8 items-center justify-center rounded-full text-ink-2 dark:text-ink-2-dark transition-colors duration-150 hover:bg-surface-2 dark:hover:bg-surface-2-dark cursor-pointer"
        >
          <SettingsIcon size={16} />
        </button>
      </header>

      <main className="p-4 space-y-4">
        {status === 'loading' && (
          <p className="text-xs text-ink-2 dark:text-ink-2-dark">加载中…</p>
        )}

        {status === 'no-video' && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <GraduationCapIcon
              size={40}
              strokeWidth={1.5}
              className="text-ink-3 dark:text-ink-3-dark"
            />
            <p className="text-[15px] font-medium">未检测到 B站视频页。</p>
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              请打开 bilibili.com 的任意视频播放页，这里会自动出现「一键分析」。
            </p>
          </div>
        )}

        {ctx && status !== 'no-video' && status !== 'loading' && (
          <Card>
            <div className="flex gap-3">
              {ctx.cover ? (
                <img
                  src={ctx.cover}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-[60px] w-[96px] shrink-0 rounded-[10px] object-cover"
                />
              ) : (
                <span className="flex h-[60px] w-[96px] shrink-0 items-center justify-center rounded-[10px] gradient-brand">
                  <ClapperboardIcon size={22} className="text-white" />
                </span>
              )}
              <div className="flex-1 min-w-0">
                <h2 className="line-clamp-2 text-[15px] font-medium leading-[1.35] tracking-tight">
                  {ctx.title}
                </h2>
                <p className="mt-1 text-xs text-ink-2 dark:text-ink-2-dark">
                  <span>UP 主：{ctx.owner || '未知'}</span>
                  <span className="text-ink-3 dark:text-ink-3-dark"> · </span>
                  <span>第 {ctx.p} P</span>
                  <span className="text-ink-3 dark:text-ink-3-dark"> · </span>
                  <span>时长 {formatTimestamp(ctx.duration)}</span>
                  {ctx.pages.length > 1 && ctx.pages[ctx.p - 1] && (
                    <>
                      <span className="text-ink-3 dark:text-ink-3-dark"> · </span>
                      <span>{ctx.pages[ctx.p - 1].part}</span>
                    </>
                  )}
                </p>
              </div>
            </div>

            {status === 'ready' && (
              <Button
                variant="primary"
                size="lg"
                onClick={() => analyze(false)}
                className="mt-4"
              >
                <SparklesIcon size={14} className="text-white" />
                一键分析
              </Button>
            )}

            {status === 'analyzing' && (
              <div className="mt-4 space-y-2">
                <ProgressBar value={progress.pct} />
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-xs text-ink-2 dark:text-ink-2-dark">
                    {progress.text || '分析中…'}
                  </p>
                  <button
                    type="button"
                    onClick={cancel}
                    className="shrink-0 text-xs text-ink-2 dark:text-ink-2-dark hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
                  >
                    取消
                  </button>
                </div>
                {progress.streamText && (
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-surface-2 dark:bg-surface-2-dark p-3 text-xs text-ink-2 dark:text-ink-2-dark">
                    {progress.streamText}
                  </pre>
                )}
              </div>
            )}

            {status === 'no-subtitle' && (
              <div className="mt-4 space-y-3">
                <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <TriangleAlertIcon size={14} className="mt-[1px] shrink-0" />
                  <span>
                    该视频没有可用字幕。常见原因：UP 主未上传字幕、未开启 AI
                    字幕，或当前未登录 B站导致接口受限。
                  </span>
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => analyze(true)}
                  className="w-full"
                >
                  重试
                </Button>
              </div>
            )}

            {status === 'error' && (
              <div className="mt-4 space-y-3">
                <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
                  <OctagonXIcon size={14} className="mt-[1px] shrink-0 text-red-500" />
                  <span>{error}</span>
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => analyze(true)}
                    className="flex-1"
                  >
                    重试
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={openOptions}
                    className="flex-1"
                  >
                    检查模型设置
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}

        {status === 'done' && result && (
          <section className="space-y-4 animate-[fadeUp_.2s_ease-out]">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2 dark:text-ink-2-dark">
                <CircleCheckBigIcon size={14} className="shrink-0 text-emerald-500" />
                <span className="truncate">
                  {cached ? '缓存结果' : '分析完成'}
                  {result.tokenUsage && ` · 输入约 ${result.tokenUsage.estimatedInput} tokens`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => analyze(true)}
                className="flex shrink-0 items-center gap-1 text-xs text-ink-2 dark:text-ink-2-dark hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
              >
                <RefreshCwIcon size={12} />
                重新生成
              </button>
            </div>

            {result.rawMarkdown ? (
              <Card>
                <p className="mb-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                  <TriangleAlertIcon size={14} className="shrink-0" />
                  模型未返回标准结构，以下为原文展示：
                </p>
                <pre className="whitespace-pre-wrap text-xs text-ink-2 dark:text-ink-2-dark">
                  {result.rawMarkdown}
                </pre>
              </Card>
            ) : (
              <>
                {result.outline.length > 0 && (
                  <Card>
                    <SectionTitle icon={<ListTreeIcon />} title="课程大纲" />
                    <ul>
                      {result.outline.map((o, i) => (
                        <li
                          key={i}
                          className="flex h-9 items-center gap-2 rounded-lg px-2 transition-colors hover:bg-brand-soft dark:hover:bg-brand-soft-dark"
                        >
                          <span className="w-5 font-mono text-xs tnum text-ink-3 dark:text-ink-3-dark">
                            {String(i + 1).padStart(2, '0')}
                          </span>
                          <TimestampLink seconds={o.time} onSeek={seek} />
                          <span className="min-w-0 flex-1 truncate">{o.title}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {result.sections.map((s, i) => (
                  <Card key={i}>
                    <SectionTitle
                      icon={<FileTextIcon />}
                      title={s.title}
                      aside={
                        <span className="flex items-center gap-1">
                          <TimestampLink seconds={s.start} onSeek={seek} />
                          <span className="text-ink-3 dark:text-ink-3-dark">-</span>
                          <span className="font-mono text-[11px] tnum">
                            {formatTimestamp(s.end)}
                          </span>
                        </span>
                      }
                    />
                    <ul className="list-disc space-y-1 pl-5 marker:text-ink-3 dark:marker:text-ink-3-dark text-ink-2 dark:text-ink-2-dark">
                      {s.points.map((p, j) => (
                        <li key={j}>{p}</li>
                      ))}
                    </ul>
                  </Card>
                ))}

                {result.keyPoints.length > 0 && (
                  <Card>
                    <SectionTitle icon={<ZapIcon />} title="重点 / 难点讲解" />
                    <ul className="space-y-3">
                      {result.keyPoints.map((k, i) => (
                        <li key={i}>
                          <p className="flex items-center gap-2 font-medium">
                            {k.time !== undefined && (
                              <TimestampLink seconds={k.time} onSeek={seek} />
                            )}
                            <span>{k.point}</span>
                          </p>
                          {k.explanation && (
                            <p className="mt-1 text-xs text-ink-2 dark:text-ink-2-dark">
                              {k.explanation}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {(result.extensions?.length ?? 0) > 0 && (
                  <Card>
                    <SectionTitle icon={<LightbulbIcon />} title="拓展知识" />
                    <ul className="space-y-3">
                      {result.extensions.map((e, i) => (
                        <li key={i}>
                          <p className="font-medium">{e.title}</p>
                          <p className="mt-1 text-xs text-ink-2 dark:text-ink-2-dark">
                            {e.detail}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {(result.caveats?.length ?? 0) > 0 && (
                  <Card>
                    <SectionTitle icon={<TriangleAlertIcon />} title="注意事项" />
                    <ul className="space-y-3">
                      {result.caveats.map((e, i) => (
                        <li key={i}>
                          <p className="font-medium">{e.title}</p>
                          <p className="mt-1 text-xs text-ink-2 dark:text-ink-2-dark">
                            {e.detail}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </>
            )}
          </section>
        )}

        {ctx && status !== 'no-video' && status !== 'loading' && (
          <Card>
            <SectionTitle
              icon={<NotebookPenIcon />}
              title="笔记"
              aside={
                status === 'done' && result ? (
                  <Button variant="ghost" size="sm" onClick={() => void saveAsNote()}>
                    存为笔记
                  </Button>
                ) : undefined
              }
            />

            <div className="space-y-3">
              {notes.length === 0 && (
                <p className="text-xs text-ink-2 dark:text-ink-2-dark">
                  当前视频还没有笔记。完成分析后点击「存为笔记」即可生成。
                </p>
              )}

              {notes.length > 0 && (
                <ul className="space-y-1">
                  {notes.map((n) => (
                    <li
                      key={n.id}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${
                        n.id === activeNoteId
                          ? 'bg-brand-soft dark:bg-brand-soft-dark'
                          : 'hover:bg-surface-2 dark:hover:bg-surface-2-dark'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void selectNote(n)}
                        className="min-w-0 flex-1 text-left cursor-pointer"
                      >
                        <span className="block truncate">{n.title}</span>
                        <span className="block text-xs text-ink-3 dark:text-ink-3-dark tnum">
                          {new Date(n.updatedAt).toLocaleString('zh-CN')}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void removeNote(n)}
                        className="shrink-0 text-ink-3 dark:text-ink-3-dark hover:text-red-500 dark:hover:text-red-400 transition-colors cursor-pointer"
                        title="删除笔记"
                      >
                        <Trash2Icon size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {activeNote && (
                <div className="space-y-2 border-t border-line dark:border-line-dark pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex-1 min-w-0 truncate text-xs font-medium">
                      {activeNote.title}
                    </p>
                    <Badge tone={syncBadge(syncInfo, activeNote).tone}>
                      {syncBadge(syncInfo, activeNote).text}
                    </Badge>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="link" size="sm" onClick={() => setPreview((v) => !v)}>
                      {preview ? '编辑' : '预览'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={syncBusy}
                      onClick={() => void syncNow(false)}
                    >
                      <CloudUploadIcon size={12} />
                      {syncBusy ? '同步中…' : '同步到 Notion'}
                    </Button>
                    {syncInfo?.syncStatus === 'conflict' && (
                      <Button
                        variant="dangerGhost"
                        size="sm"
                        disabled={syncBusy}
                        onClick={() => void syncNow(true)}
                        title="用本地内容覆盖 Notion 页面"
                      >
                        强制覆盖
                      </Button>
                    )}
                  </div>

                  {syncInfo?.error && (
                    <p className="text-xs text-red-600 dark:text-red-400">{syncInfo.error}</p>
                  )}

                  {preview ? (
                    <div className="max-h-80 overflow-y-auto rounded-[10px] border border-line dark:border-line-dark p-3">
                      <MarkdownPreview markdown={draft} onSeek={seek} />
                    </div>
                  ) : (
                    <textarea
                      value={draft}
                      onChange={(e) => onDraftChange(e.target.value)}
                      rows={12}
                      spellCheck={false}
                      className="min-h-[160px] w-full resize-y rounded-lg border border-line-2 dark:border-line-2-dark bg-card dark:bg-card-dark px-3 py-2 font-mono text-xs leading-relaxed text-ink dark:text-ink-dark placeholder:text-ink-3 dark:placeholder:text-ink-3-dark outline-none transition-colors duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-ring dark:focus:ring-brand-ring-dark"
                      placeholder="用 Markdown 记录你的笔记…"
                    />
                  )}

                  <p className="text-[11px] text-ink-3 dark:text-ink-3-dark">
                    {saving
                      ? '保存中…'
                      : draft !== savedDraft
                        ? '编辑中…（停止输入 1 秒后自动保存）'
                        : '已自动保存'}
                  </p>
                </div>
              )}
            </div>
          </Card>
        )}
      </main>
    </div>
  );
}
