/**
 * 对话 Tab（讨论稿 §6）：话题头 + 流式问答 + 完整度降级提示 + 工具模式三态 + 自动记录回执。
 * Sidepanel 只消费状态与发送意图；Prompt / 检索 / 写库 / 同步编排全在 background（§4）。
 */
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import MarkdownPreview from '../../components/MarkdownPreview';
import TimestampLink from '../../components/TimestampLink';
import { Button, Switch } from '../../components/ui';
import {
  ArrowRightIcon,
  ClockIcon,
  PlusIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from '../../components/icons';
import {
  CHAT_PORT,
  type ChatPortEvent,
  type ChatStatePayload,
  type VideoContextInfo,
} from '../../lib/messages';
import type { ChatTurn, ToolMode } from '../../lib/chat';

interface Generating {
  clientRequestId: string;
  question: string;
  stage: 'preparing' | 'searching' | 'answering';
  /** tool-start 上报的联网 Provider 名（stage === 'searching' 时展示） */
  searchProvider?: string;
  partial: string;
}

interface WrittenToast {
  noteId: number;
  noteTitle: string;
  /** = 写入的 turn id（chatEntryId 与 turn.id 相同） */
  chatEntryId: string;
}

const TOOL_MODES: { key: ToolMode; label: string }[] = [
  { key: 'course', label: '仅课程' },
  { key: 'auto', label: '自动拓展' },
  { key: 'force', label: '强制联网' },
];

/** 工具模式说明（§5.4：联网使用当前配置模型的原生 websearch 能力，不支持时明确提示） */
const TOOL_MODE_HINTS: Record<ToolMode, string> = {
  course: '仅基于当前课程内容回答',
  auto: '优先课程内容，将尝试使用当前模型联网补充',
  force: '强制使用模型联网能力，不支持时会报错',
};

export default function ChatView(props: {
  ctx: VideoContextInfo;
  chatState: ChatStatePayload | null;
  reloadChatState: () => Promise<void>;
  /** 提问前先把笔记编辑器里未落盘的草稿保存（§5.6：避免旧草稿覆盖后台追加） */
  flushDraft: () => Promise<void>;
  onSeek: (seconds: number) => void;
  onOpenNotes: (noteId?: number) => void;
}) {
  const { ctx, chatState } = props;
  const [input, setInput] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('auto');
  const [generating, setGenerating] = useState<Generating | null>(null);
  const [currentTopicId, setCurrentTopicId] = useState<string | null>(null);
  const [updateAnchorNext, setUpdateAnchorNext] = useState(false);
  const [toast, setToast] = useState<WrittenToast | null>(null);
  const [error, setError] = useState('');
  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const [busyTurnId, setBusyTurnId] = useState<string | null>(null);
  const portRef = useRef<Browser.runtime.Port | null>(null);
  /** generating 的同步镜像：send 双重守卫与 onDisconnect 复位用（state 闭包会过期） */
  const generatingRef = useRef<Generating | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const topics = chatState?.topics ?? [];
  const session = chatState?.session ?? null;
  const completeness = chatState?.completeness ?? 'none';
  const currentTopic = topics.find((t) => t.id === currentTopicId) ?? null;
  const turns = currentTopicId
    ? (chatState?.turnsByTopic[currentTopicId] ?? [])
    : [];

  // 话题列表刷新后校正当前话题（默认最新）
  useEffect(() => {
    if (currentTopicId && topics.some((t) => t.id === currentTopicId)) return;
    setCurrentTopicId(topics.length > 0 ? topics[topics.length - 1].id : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在话题数据变化时校正
  }, [chatState]);

  // 挂载 + 上下文变化时拉取会话状态（重开面板幂等恢复，§9.8）
  const { reloadChatState } = props;
  useEffect(() => {
    void reloadChatState();
  }, [reloadChatState]);

  useEffect(() => () => portRef.current?.disconnect(), []);

  // 新内容到达时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, generating?.partial, generating?.stage]);

  const stopPort = () => {
    portRef.current?.disconnect();
    portRef.current = null;
  };

  const send = async () => {
    const question = input.trim();
    // 同步守卫（ref 即时生效）：双击 / 双击 Enter 无法穿过；已有端口在用时直接拒绝，防并发混流
    if (!question || generatingRef.current || portRef.current) return;
    const clientRequestId = crypto.randomUUID();
    const gen: Generating = { clientRequestId, question, stage: 'preparing', partial: '' };
    generatingRef.current = gen;
    setGenerating(gen);
    setError('');
    setToolNotice(null);
    setToast(null);
    setInput('');
    try {
      await props.flushDraft();
    } catch {
      generatingRef.current = null;
      setGenerating(null);
      setInput(question);
      setError('笔记草稿保存失败，请重试');
      return;
    }

    const port = browser.runtime.connect({ name: CHAT_PORT });
    portRef.current = port;
    const anchorFlag = updateAnchorNext;
    setUpdateAnchorNext(false);

    port.onMessage.addListener((e: ChatPortEvent) => {
      switch (e.type) {
        case 'context-ready': {
          // C2：context-ready 携带话题身份，立即切换（不等 answer-done 后的状态刷新）
          const topicId = (e as { topicId?: string }).topicId;
          if (topicId) setCurrentTopicId(topicId);
          setGenerating((g) => (g ? { ...g, stage: 'answering' } : g));
          break;
        }
        case 'tool-start':
          setGenerating((g) =>
            g ? { ...g, stage: 'searching', searchProvider: e.provider } : g,
          );
          break;
        case 'tool-done':
          setGenerating((g) => (g ? { ...g, stage: 'answering' } : g));
          break;
        case 'tool-failed':
          // 降级提示保留，随后的课程内回答照常展示
          setToolNotice(e.message);
          setGenerating((g) => (g ? { ...g, stage: 'answering' } : g));
          break;
        case 'answer-delta':
          setGenerating((g) =>
            g ? { ...g, stage: 'answering', partial: g.partial + e.delta } : g,
          );
          break;
        case 'answer-done':
          generatingRef.current = null;
          setGenerating(null);
          stopPort();
          void reloadChatState();
          break;
        case 'note-written':
          setToast({
            noteId: e.noteId,
            noteTitle: e.noteTitle,
            chatEntryId: e.chatEntryId,
          });
          void reloadChatState();
          break;
        case 'note-write-failed':
          setError(`笔记写入失败：${e.message}（回答已保留，可在回答下方重试记录）`);
          void reloadChatState();
          break;
        case 'error':
          generatingRef.current = null;
          setGenerating(null);
          setError(e.message);
          stopPort();
          void reloadChatState();
          break;
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      // 意外断开（Service Worker 重启等）：复位 generating，否则输入框永久 disabled
      if (generatingRef.current) {
        generatingRef.current = null;
        setGenerating(null);
        setError('连接中断，请重试');
      }
    });

    port.postMessage({
      type: 'ask',
      topicId: currentTopicId ?? undefined,
      question,
      clientRequestId,
      toolMode,
      updateAnchor: anchorFlag || undefined,
    });
  };

  const cancel = () => {
    portRef.current?.postMessage({ type: 'cancel' });
  };

  const turnAction = async (
    type: 'chatUndo' | 'chatSkip' | 'chatRerecord',
    turnId: string,
  ) => {
    setBusyTurnId(turnId);
    try {
      const resp = (await browser.runtime.sendMessage({ type, turnId })) as
        | { ok?: boolean; error?: string }
        | undefined;
      // 后台明确拒绝（ok:false）→ 内联报错，不走成功路径
      if (resp?.ok === false) {
        setError(resp.error ?? '操作失败');
        return;
      }
      setToast(null);
      await reloadChatState();
    } catch {
      /* background 未就绪 */
    } finally {
      setBusyTurnId(null);
    }
  };

  const toggleAutoRecord = async (value: boolean) => {
    try {
      await browser.runtime.sendMessage({
        type: 'chatSetAutoRecord',
        bvid: ctx.bvid,
        cid: ctx.cid,
        value,
      });
      await reloadChatState();
    } catch {
      /* background 未就绪 */
    }
  };

  const renderTurnActions = (turn: ChatTurn) => {
    if (turn.status !== 'done') return null;
    const busy = busyTurnId === turn.id;
    switch (turn.noteWriteStatus) {
      case 'written':
        return (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3 dark:text-ink-3-dark">
            <span>已记录到笔记</span>
            <button
              type="button"
              className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
              onClick={() => props.onOpenNotes(session?.targetNoteId)}
            >
              查看
            </button>
            <button
              type="button"
              disabled={busy}
              className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer disabled:opacity-40"
              onClick={() => void turnAction('chatUndo', turn.id)}
            >
              撤销
            </button>
            <button
              type="button"
              disabled={busy}
              className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer disabled:opacity-40"
              onClick={() => void turnAction('chatSkip', turn.id)}
            >
              不记录此回答
            </button>
          </p>
        );
      case 'undone':
      case 'skipped':
        return (
          <p className="mt-2 flex items-center gap-2 text-[11px] text-ink-3 dark:text-ink-3-dark">
            <span>{turn.noteWriteStatus === 'undone' ? '已撤销记录' : '未记录'}</span>
            <button
              type="button"
              disabled={busy}
              className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer disabled:opacity-40"
              onClick={() => void turnAction('chatRerecord', turn.id)}
            >
              重新记录
            </button>
          </p>
        );
      case 'failed':
        return (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-red-600 dark:text-red-400">
            <span>记录失败{turn.error ? `：${turn.error}` : ''}</span>
            <button
              type="button"
              disabled={busy}
              className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer disabled:opacity-40"
              onClick={() => void turnAction('chatRerecord', turn.id)}
            >
              重试记录
            </button>
          </p>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 话题头 */}
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {currentTopic ? currentTopic.title : '新话题'}
        </span>
        {currentTopic && (
          <>
            <TimestampLink seconds={currentTopic.anchorTime} onSeek={props.onSeek} />
            <button
              type="button"
              onClick={() => setUpdateAnchorNext(true)}
              title="下次提问以当前播放进度为锚点"
              className="flex shrink-0 items-center gap-1 text-xs text-ink-2 dark:text-ink-2-dark hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
            >
              <ClockIcon size={12} />
              更新到当前进度
            </button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCurrentTopicId(null)}
          disabled={!currentTopicId}
        >
          <PlusIcon size={12} />
          新话题
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink-3 dark:text-ink-3-dark">
          {updateAnchorNext ? '下次提问将锚定到当前播放进度' : '自动记录问答到课程笔记'}
        </span>
        <Switch
          checked={session?.autoRecord ?? true}
          onChange={(v) => void toggleAutoRecord(v)}
          aria-label="自动记录问答到课程笔记"
        />
      </div>

      {/* 完整度降级提示（§5.1） */}
      {completeness === 'none' && (
        <p className="flex items-start gap-1.5 rounded-[10px] bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <TriangleAlertIcon size={14} className="mt-[1px] shrink-0" />
          <span>该视频无可用字幕：回答只能基于通用知识，无法核对讲师此处原意。</span>
        </p>
      )}
      {completeness === 'partial' && (
        <p className="flex items-start gap-1.5 rounded-[10px] bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlertIcon size={14} className="mt-[1px] shrink-0" />
          <span>未完成完整分析，回答基于局部课程上下文（当前时间窗口字幕）。</span>
        </p>
      )}

      {/* 问答列表 */}
      <div ref={listRef} className="space-y-3">
        {turns.length === 0 && !generating && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <SparklesIcon
              size={32}
              strokeWidth={1.5}
              className="text-ink-3 dark:text-ink-3-dark"
            />
            <p className="text-xs text-ink-2 dark:text-ink-2-dark">
              针对当前课程内容随时提问，完整回答会自动整理进课程笔记。
            </p>
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-xl bg-brand-soft dark:bg-brand-soft-dark px-3 py-2 text-ink dark:text-ink-dark whitespace-pre-wrap">
                {turn.question}
              </p>
            </div>
            <div className="rounded-[14px] border border-line dark:border-line-dark bg-card dark:bg-card-dark p-3">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-3 dark:text-ink-3-dark">
                <span>锚点</span>
                <TimestampLink seconds={turn.anchorTime} onSeek={props.onSeek} />
                {turn.status === 'cancelled' && <span>· 已取消，未记录到笔记</span>}
              </p>
              {turn.answerMd ? (
                <MarkdownPreview markdown={turn.answerMd} onSeek={props.onSeek} />
              ) : (
                <p className="text-xs text-ink-3 dark:text-ink-3-dark">
                  {turn.status === 'error' ? '回答生成失败' : '（无回答内容）'}
                </p>
              )}
              {turn.status === 'error' && turn.error && (
                <p className="mt-1 text-xs text-red-600 dark:text-red-400">{turn.error}</p>
              )}
              {renderTurnActions(turn)}
            </div>
          </div>
        ))}

        {generating && (
          <div className="space-y-2">
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-xl bg-brand-soft dark:bg-brand-soft-dark px-3 py-2 text-ink dark:text-ink-dark whitespace-pre-wrap">
                {generating.question}
              </p>
            </div>
            <div className="rounded-[14px] border border-line dark:border-line-dark bg-card dark:bg-card-dark p-3">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[11px] text-ink-3 dark:text-ink-3-dark">
                  {generating.stage === 'preparing'
                    ? '准备上下文…'
                    : generating.stage === 'searching'
                      ? `正在使用 ${generating.searchProvider ?? '当前模型'} 联网搜索…`
                      : '正在回答…'}
                </p>
                <button
                  type="button"
                  onClick={cancel}
                  className="text-xs text-ink-2 dark:text-ink-2-dark hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
                >
                  取消
                </button>
              </div>
              {generating.partial ? (
                <div className="streaming-caret">
                  <MarkdownPreview markdown={generating.partial} onSeek={props.onSeek} />
                  <span className="inline-block w-[7px] h-[14px] align-[-2px] bg-brand-500 dark:bg-brand-300 animate-pulse" />
                </div>
              ) : (
                <p className="text-xs text-ink-3 dark:text-ink-3-dark animate-pulse">
                  ▍
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 联网降级提示（tool-failed：保留随后的课程内回答） */}
      {toolNotice && (
        <p className="flex items-start gap-1.5 rounded-[10px] bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlertIcon size={14} className="mt-[1px] shrink-0" />
          <span>{toolNotice}</span>
        </p>
      )}

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* 写入回执（§5.6：已记录到「笔记名」· 查看 · 撤销 · 不记录此回答） */}
      {toast && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
          <span className="min-w-0 truncate">已记录到「{toast.noteTitle}」</span>
          <button
            type="button"
            className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
            onClick={() => {
              setToast(null);
              props.onOpenNotes(toast.noteId);
            }}
          >
            查看
          </button>
          <button
            type="button"
            className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
            onClick={() => void turnAction('chatUndo', toast.chatEntryId)}
          >
            撤销
          </button>
          <button
            type="button"
            className="hover:text-brand-500 dark:hover:text-brand-300 transition-colors cursor-pointer"
            onClick={() => void turnAction('chatSkip', toast.chatEntryId)}
          >
            不记录此回答
          </button>
          <button
            type="button"
            aria-label="关闭提示"
            className="ml-auto cursor-pointer"
            onClick={() => setToast(null)}
          >
            <XIcon size={12} />
          </button>
        </div>
      )}

      {/* 工具模式三态（§5.4：联网使用当前模型原生 websearch 能力，不支持时降级或报错） */}
      <div className="space-y-1.5">
        <div className="flex w-fit rounded-lg bg-surface-2 dark:bg-surface-2-dark p-0.5">
          {TOOL_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setToolMode(m.key)}
              className={`h-7 rounded-md px-2.5 text-xs transition-colors duration-150 cursor-pointer ${
                toolMode === m.key
                  ? 'bg-card dark:bg-card-dark text-ink dark:text-ink-dark shadow-sm font-medium'
                  : 'text-ink-2 dark:text-ink-2-dark hover:text-ink dark:hover:text-ink-dark'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p
          className={`text-[11px] ${
            toolMode === 'force'
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-ink-3 dark:text-ink-3-dark'
          }`}
        >
          {TOOL_MODE_HINTS[toolMode]}
        </p>
      </div>

      {/* 输入行 */}
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          spellCheck={false}
          placeholder={
            generating ? '回答生成中…' : '针对当前课程提问（Enter 发送，Shift+Enter 换行）'
          }
          disabled={!!generating}
          className="max-h-24 min-h-[38px] flex-1 resize-none rounded-lg border border-line-2 dark:border-line-2-dark bg-card dark:bg-card-dark px-3 py-2 text-[13px] text-ink dark:text-ink-dark placeholder:text-ink-3 dark:placeholder:text-ink-3-dark outline-none transition-colors duration-150 focus:border-brand-500 focus:ring-2 focus:ring-brand-ring dark:focus:ring-brand-ring-dark disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="发送"
          disabled={!input.trim() || !!generating}
          onClick={() => void send()}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg gradient-brand cta-shadow text-white transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
        >
          <ArrowRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}
