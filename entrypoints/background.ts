/**
 * Background Service Worker：消息路由 + API 编排。
 * B站与 LLM 的 fetch 全部在这里发出（host permission 覆盖，B站 cookie 随请求附带）。
 */
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { parseVideoUrl } from '../lib/bilibili/url';
import {
  getSubtitleCues,
  getVideoInfo,
  getDanmakuSample,
  getAudioTrack,
  downloadAudio,
  BiliApiError,
  type VideoInfo,
} from '../lib/bilibili';
import { chatStream, fetchModels, testConnection, LLMError } from '../lib/llm';
import type { ChatMessage, ChatStreamOutcome } from '../lib/llm';
import {
  buildSilentWav,
  isSttConfig,
  MAX_STT_FILE_BYTES,
  SttError,
  transcribeAudio,
} from '../lib/transcribe';
import { createNotionClient, NotionError } from '../lib/notion';
import {
  buildConnector,
  getActiveConnectorProfile,
  getTargetSyncRow,
  listImaKnowledgeBases,
  listYuqueKnowledgeBases,
  listConnectorProfiles,
  getActiveConnectorProfileId,
  syncNoteToTarget,
  type TargetSyncRow,
} from '../lib/connectors';
import {
  db,
  getCachedSubtitle,
  getCachedSummary,
  getLatestSummary,
  getPrefs,
  listNotesByVideo,
  createNote,
  saveNote,
  saveNoteCAS,
  NoteRevConflict,
  saveSubtitle,
  saveSummary,
  saveNotionMapping,
  saveConnectorSync,
  upsertVideo,
  getActiveProfile,
  getNote,
  getNotionConfig,
  getNotionMapping,
  getLatestConnectorSync,
  getSttConfig,
  type ModelProfile,
  type NoteRow,
  type SubtitleSource,
} from '../lib/storage';
import {
  appendQaBlock,
  buildChatContext,
  buildChatMessages,
  buildChatNoteInit,
  createTopic,
  decideSearchPlan,
  detectCompleteness,
  getOrCreateSession,
  getSession,
  getSessionByVideo,
  getTopic,
  getTurn,
  getTurnByClientRequestId,
  addTurn,
  listTopics,
  listTurnsByTopic,
  looksLikeToolUnsupported,
  removeQaBlock,
  runBuiltinToolLoop,
  stripThinking,
  updateSession,
  updateTopic,
  updateTurn,
  webSearchToolsFor,
  type ChatSession,
  type ChatSnapshot,
  type ChatTopic,
  type ChatTurn,
} from '../lib/chat';
import { summarize } from '../lib/summarize';
import {
  ANALYZE_PORT,
  CHAT_PORT,
  type AnalyzePortEvent,
  type AnalyzePortMsg,
  type BgRequest,
  type ChatPortEvent,
  type ChatPortMsg,
  type ChatStatePayload,
  type TranscribeStage,
  type VideoContextInfo,
} from '../lib/messages';

function errorMessage(e: unknown): string {
  if (e instanceof LLMError) return e.userMessage;
  if (e instanceof SttError) return e.userMessage;
  if (e instanceof NotionError) return e.userMessage;
  if (
    e &&
    typeof e === 'object' &&
    (e as { name?: unknown }).name === 'ImaError' &&
    typeof (e as { userMessage?: unknown }).userMessage === 'string'
  ) {
    return (e as { userMessage: string }).userMessage;
  }
  if (e instanceof BiliApiError) return `B站接口错误：${e.message}`;
  return (e as Error).message ?? String(e);
}

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// ---------- 知识库同步（串行队列，PRD F-07 / 6.5；路由到当前默认写入目标） ----------

async function doSyncNote(noteId: number, force?: boolean): Promise<TargetSyncRow> {
  return syncNoteToTarget(noteId, { force });
}

// 所有同步任务经同一队列串行执行（配合客户端限流，避免突发请求打满 3 QPS）
let syncChain: Promise<unknown> = Promise.resolve();

function enqueueSync(noteId: number, force?: boolean): Promise<TargetSyncRow> {
  const job = syncChain.then(() => doSyncNote(noteId, force));
  syncChain = job.catch(() => undefined);
  return job;
}

/** 笔记保存后的自动同步（prefs.autoSyncNotion，默认开；目标 = 当前默认知识库连接） */
async function maybeAutoSync(noteId: number): Promise<void> {
  const prefs = await getPrefs();
  if (!prefs.autoSyncNotion) return;
  const profile = await getActiveConnectorProfile();
  if (!profile) return; // 未配置任何连接：保持「未同步」
  if (profile.kind === 'notion') {
    // 保持旧行为：Notion 未完成令牌 + 根页面配置时静默跳过
    const config = await getNotionConfig();
    if (!config?.token || !config.rootPageId) return;
  }
  await enqueueSync(noteId);
}

/**
 * SW 启动恢复（P2：防抖/队列只在内存，SW 被杀后 syncing 行会卡死）：
 * 1. 上次崩溃前处于 syncing 的行一律归位 pending（notionMappings + connectorSync）；
 * 2. 当前默认连接维度下，把 pending / error 行重新入队（笔记已删除的静默跳过）。
 */
async function rehydrateSyncQueue(): Promise<void> {
  const profile = await getActiveConnectorProfile();
  if (!profile) return;

  const staleNotion = await db.notionMappings.where('syncStatus').equals('syncing').toArray();
  for (const row of staleNotion) {
    await saveNotionMapping({ ...row, syncStatus: 'pending', error: undefined });
  }
  const staleConnector = (await db.connectorSync.toArray()).filter(
    (r) => r.syncStatus === 'syncing',
  );
  for (const row of staleConnector) {
    await saveConnectorSync({ ...row, syncStatus: 'pending', error: undefined });
  }

  const noteIds = new Set<number>();
  if (profile.kind === 'notion') {
    const rows = await db.notionMappings
      .where('syncStatus')
      .anyOf('pending', 'error')
      .toArray();
    for (const r of rows) noteIds.add(r.noteId);
  } else {
    const rows = (await db.connectorSync.toArray()).filter(
      (r) =>
        r.connectorId === profile.id &&
        (r.syncStatus === 'pending' || r.syncStatus === 'error'),
    );
    for (const r of rows) noteIds.add(r.noteId);
  }
  for (const noteId of noteIds) {
    if (!(await getNote(noteId))) continue; // 笔记已删除：静默跳过
    void enqueueSync(noteId).catch(() => {});
  }
}

// 视频信息内存缓存（5min），供侧边栏轮询低成本刷新
const videoInfoCache = new Map<string, { at: number; info: VideoInfo }>();

async function getVideoInfoCached(bvid: string): Promise<VideoInfo> {
  const hit = videoInfoCache.get(bvid);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.info;
  const info = await getVideoInfo(bvid);
  videoInfoCache.set(bvid, { at: Date.now(), info });
  return info;
}

/** 从 content script 取当前 bvid/p；未注入时补注入重试，再退化为 URL 解析 */
async function queryPageContext(tabId: number): Promise<{ bvid: string; p: number } | null> {
  try {
    return await browser.tabs.sendMessage(tabId, { type: 'queryContext' });
  } catch {
    // content script 不存在（扩展安装/重载之前已打开的标签页）：
    // 先尝试补注入以恢复完整能力（seek / 播放时间）
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: ['/content-scripts/content.js'],
      });
      return await browser.tabs.sendMessage(tabId, { type: 'queryContext' });
    } catch {
      // 注入失败 → URL 解析兜底（视频上下文可用；seek/播放时间走既有降级路径）
      const tab = await browser.tabs.get(tabId).catch(() => null);
      return tab?.url ? parseVideoUrl(tab.url) : null;
    }
  }
}

/** 从 content script 取当前 bvid/p，再合并 view 接口信息 */
async function resolveVideoContext(): Promise<VideoContextInfo | null> {
  const tabId = await getActiveTabId();
  if (!tabId) return null;
  const pageCtx = await queryPageContext(tabId);
  if (!pageCtx?.bvid) return null;
  const info = await getVideoInfoCached(pageCtx.bvid);
  await upsertVideo({
    bvid: info.bvid,
    aid: info.aid,
    title: info.title,
    cover: info.cover,
    owner: info.owner,
    duration: info.duration,
    parts: info.pages,
  });
  const p = Math.min(Math.max(1, pageCtx.p || 1), Math.max(1, info.pages.length));
  const page = info.pages[p - 1] ?? info.pages[0];
  return {
    bvid: info.bvid,
    aid: info.aid,
    p,
    title: info.title,
    owner: info.owner,
    cover: info.cover,
    cid: page?.cid ?? 0,
    duration: page?.duration ?? info.duration,
    pages: info.pages,
  };
}

// ---------- AI Chat（在线答疑），讨论稿 §5 / §7 ----------

/** 从 content script 读取一次实时播放秒数（讨论稿 §9.1）；读不到返回 null */
async function getPlaybackTimeSnapshot(): Promise<number | null> {
  const tabId = await getActiveTabId();
  if (!tabId) return null;
  try {
    const t = await browser.tabs.sendMessage(tabId, { type: 'getPlaybackTime' });
    return typeof t === 'number' && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** Chat 写笔记后广播（Side Panel 用于刷新笔记视图） */
function broadcastNoteChanged(noteId: number): void {
  void browser.runtime.sendMessage({ type: 'noteChanged', noteId }).catch(() => {});
}

/** Chat 自动同步：按笔记 15s 防抖合并，避免每轮问答都触发远端整页替换（§5.6） */
const chatSyncTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleChatSync(noteId: number): void {
  const prev = chatSyncTimers.get(noteId);
  if (prev) clearTimeout(prev);
  chatSyncTimers.set(
    noteId,
    setTimeout(() => {
      chatSyncTimers.delete(noteId);
      void maybeAutoSync(noteId).catch(() => {});
    }, 15_000),
  );
}

/**
 * 解析当前 cid 的目标笔记（§10 决策：每 cid 一份，取该 cid 最新笔记；
 * 没有则自动创建 source=mixed 学习笔记）。成功后回写 session.targetNoteId。
 */
async function resolveTargetNote(
  session: ChatSession,
  ctx: VideoContextInfo,
): Promise<NoteRow> {
  if (session.targetNoteId) {
    const n = await getNote(session.targetNoteId);
    if (n) return n;
  }
  const hit = (await listNotesByVideo(session.bvid)).find((n) => n.cid === session.cid);
  if (hit) {
    await updateSession(session.id, { targetNoteId: hit.id });
    return hit;
  }
  const page = ctx.pages[ctx.p - 1];
  const partLabel = ctx.pages.length > 1 && page ? `P${ctx.p} ${page.part}` : undefined;
  const note = await createNote({
    bvid: session.bvid,
    cid: session.cid,
    title: partLabel ? `${ctx.title} · ${partLabel}` : ctx.title,
    contentMd: buildChatNoteInit({
      videoTitle: ctx.title,
      partLabel,
      owner: ctx.owner,
      url: `https://www.bilibili.com/video/${ctx.bvid}${ctx.p > 1 ? `?p=${ctx.p}` : ''}`,
      generatedAt: new Date(),
    }),
    source: 'mixed',
  });
  await updateSession(session.id, { targetNoteId: note.id });
  return note;
}

/** 完整回答写入本地课程笔记：读最新行 → 幂等追加问答块（§5.6）→ CAS 写回；
 *  与编辑器并发冲突时按最新行重放（appendQaBlock 按 chatEntryId 幂等），最多 3 次。
 *  成功后广播 + 防抖同步 */
async function appendTurnToNote(
  session: ChatSession,
  turn: ChatTurn,
  ctx: VideoContextInfo,
): Promise<NoteRow> {
  const target = await resolveTargetNote(session, ctx);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    const latest = await getNote(target.id!);
    if (!latest) throw new Error('目标笔记不存在');
    const contentMd = appendQaBlock(latest.contentMd, {
      chatEntryId: turn.id,
      anchorTime: turn.anchorTime,
      question: turn.question,
      answerMd: turn.answerMd,
    });
    try {
      const saved = await saveNoteCAS(latest.id!, { contentMd }, latest.rev ?? 1);
      await updateTurn(turn.id, { noteWriteStatus: 'written', noteEntryId: turn.id });
      broadcastNoteChanged(saved.id!);
      scheduleChatSync(saved.id!);
      return saved;
    } catch (e) {
      // 版本冲突：编辑器同期有写入 → 读冲突方给的最新行重放；块级幂等保证不产生重复块
      if (e instanceof NoteRevConflict && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
}

/** 撤销 / 不记录：只移除该 chatEntryId 的标记块（不动同期手工编辑），再广播 + 防抖同步 */
async function removeTurnFromNote(turnId: string, status: 'undone' | 'skipped'): Promise<void> {
  const turn = await getTurn(turnId);
  if (!turn) throw new Error('问答不存在');
  if (turn.noteWriteStatus === 'written') {
    const topic = await getTopic(turn.topicId);
    const session = topic ? await getSession(topic.sessionId) : undefined;
    const note = session?.targetNoteId ? await getNote(session.targetNoteId) : undefined;
    if (note?.id) {
      await saveNote(note.id, {
        contentMd: removeQaBlock(note.contentMd, turn.noteEntryId ?? turn.id),
      });
      broadcastNoteChanged(note.id);
      scheduleChatSync(note.id);
    }
  }
  await updateTurn(turnId, { noteWriteStatus: status });
}

/** 强制联网不可用的硬错误文案（§5.4 强制语义：不降级为仅课程，明确告知无法启用） */
function forceWebSearchUnsupportedMessage(profile: ModelProfile): string {
  return `当前配置的模型（${profile.name}/${profile.defaultModel}）不支持联网搜索，无法启用强制联网。可换用支持联网的模型（如 Kimi），或改用「仅课程」/「自动拓展」。`;
}

/** Chat ask 全流程（§6 状态链：准备上下文 → 流式回答 → 保存 Turn → 写笔记 → 触发同步） */
async function handleChatAsk(
  port: Browser.runtime.Port,
  msg: Extract<ChatPortMsg, { type: 'ask' }>,
  signal: AbortSignal,
): Promise<void> {
  const emit = (e: ChatPortEvent) => {
    try {
      port.postMessage(e);
    } catch {
      /* 面板已关闭 */
    }
  };
  try {
    const prefs = await getPrefs();
    // 幂等：同 clientRequestId 已完成 → 直接回放，不再生成/再写笔记（§9.8）
    const dup = await getTurnByClientRequestId(msg.clientRequestId);
    if (dup) {
      if (dup.status !== 'done') {
        emit({ type: 'error', message: '该问题已提交过，请稍后刷新查看结果' });
        return;
      }
      emit({ type: 'answer-delta', seq: 0, delta: dup.answerMd });
      // C2：回放同样遵守「笔记结果在 answer-done 之前，answer-done 永远最后」
      if (dup.noteWriteStatus === 'written') {
        const topic = await getTopic(dup.topicId);
        const session = topic ? await getSession(topic.sessionId) : undefined;
        const note = session?.targetNoteId ? await getNote(session.targetNoteId) : undefined;
        if (note?.id) {
          emit({
            type: 'note-written',
            noteId: note.id,
            noteTitle: note.title,
            chatEntryId: dup.noteEntryId ?? dup.id,
          });
        }
      }
      emit({ type: 'answer-done', turnId: dup.id, status: 'done' });
      return;
    }

    // 1. 视频上下文 + 不可变播放快照（§5.2，生成期间不漂移）
    const ctx = await resolveVideoContext();
    if (!ctx) {
      emit({ type: 'error', message: '未检测到 B站视频页，请先在视频播放页提问' });
      return;
    }
    const playbackTime = await getPlaybackTimeSnapshot();
    const snapshot: ChatSnapshot = {
      bvid: ctx.bvid,
      cid: ctx.cid,
      p: ctx.p,
      title: ctx.title,
      playbackTime: playbackTime ?? 0,
      pageUrl: `https://www.bilibili.com/video/${ctx.bvid}${ctx.p > 1 ? `?p=${ctx.p}` : ''}`,
    };

    // 2. 会话 + 话题（连续追问沿用原话题与原始锚点；updateAnchor 重置到当前进度）
    const session = await getOrCreateSession(ctx.bvid, ctx.cid);
    let topic: ChatTopic | undefined;
    if (msg.topicId) {
      const found = await getTopic(msg.topicId);
      // P1.2：只接受属于当前会话的话题 —— 陈旧/跨课程的 topicId 一律忽略并新建，
      // 自动纠正，绝不让轮次落到别的话题里
      if (found && found.sessionId === session.id) {
        topic = found;
        if (msg.updateAnchor) {
          await updateTopic(topic.id, { anchorTime: snapshot.playbackTime });
          topic = { ...topic, anchorTime: snapshot.playbackTime };
        }
      }
    }
    if (!topic) {
      topic = await createTopic({
        sessionId: session.id,
        title: msg.question.trim().split('\n')[0].slice(0, 20) || '新话题',
        anchorTime: snapshot.playbackTime,
      });
    }
    const anchorTime = topic.anchorTime;
    const anchoredSnapshot: ChatSnapshot = { ...snapshot, playbackTime: anchorTime };

    // 3. 上下文组装（字幕缓存优先，缺则拉一次；§5.3 预算由 prompt 层控制）
    let cues = (await getCachedSubtitle(ctx.bvid, ctx.cid))?.cues;
    if (!cues) {
      try {
        const sub = await getSubtitleCues(ctx.bvid, ctx.cid, { aid: ctx.aid });
        if (sub && sub.cues.length > 0) {
          await saveSubtitle({
            bvid: ctx.bvid,
            cid: ctx.cid,
            lang: sub.track.lan,
            source: sub.track.isAi ? 'ai' : 'human',
            cues: sub.cues,
            fetchedAt: Date.now(),
          });
          cues = sub.cues;
        }
      } catch {
        /* 无字幕：按 none 完整度降级（§5.1） */
      }
    }
    const analysis = (await getLatestSummary(ctx.bvid, ctx.cid))?.result ?? null;
    const noteForCtx =
      (session.targetNoteId ? await getNote(session.targetNoteId) : undefined) ??
      (await listNotesByVideo(ctx.bvid)).find((n) => n.cid === ctx.cid);
    const recentTurns = (await listTurnsByTopic(topic.id))
      .filter((t) => t.status === 'done')
      .slice(-6)
      .map((t) => ({ question: t.question, answerMd: t.answerMd }));
    const chatCtx = buildChatContext({
      snapshot: anchoredSnapshot,
      cues,
      analysis,
      noteContent: noteForCtx?.contentMd,
      recentTurns,
      // 数据边界（ABC 混合 · A 默认）：设置页逐源开关控制发给模型的内容
      privacy: {
        sendSubtitles: prefs.privacySendSubtitles,
        sendNoteExcerpt: prefs.privacySendNoteExcerpt,
        sendPlaybackMeta: prefs.privacySendPlaybackMeta,
      },
    });
    emit({
      type: 'context-ready',
      snapshot: anchoredSnapshot,
      completeness: chatCtx.completeness,
      topicId: topic.id,
    });

    const profile = await getActiveProfile();
    if (!profile) {
      emit({
        type: 'error',
        message: '尚未配置模型：请先在扩展设置页添加模型服务（baseURL + API Key）',
      });
      return;
    }

    // 联网编排（§5.4）：仅使用当前配置模型的原生 websearch 能力（已知 Provider 查表 + 尝试后检测）
    const webSearchTools = webSearchToolsFor(profile.baseURL);
    const searchPlan = decideSearchPlan(msg.toolMode, webSearchTools !== null);
    if (searchPlan === 'unsupported' && msg.toolMode === 'force') {
      // 强制联网 + Provider 能力未知：不消耗模型调用，直接报硬错误（不降级为仅课程）
      emit({ type: 'error', message: forceWebSearchUnsupportedMessage(profile) });
      return;
    }

    // 4. 落 Turn（streaming；clientRequestId 唯一约束兜底重复提交）
    let turn: ChatTurn;
    try {
      turn = await addTurn({
        clientRequestId: msg.clientRequestId,
        topicId: topic.id,
        question: msg.question,
        answerMd: '',
        anchorTime,
        status: 'streaming',
        noteWriteStatus: 'pending',
      });
    } catch {
      emit({ type: 'error', message: '该问题已提交过，请勿重复发送' });
      return;
    }

    // 5. 流式回答（按 searchPlan 决定是否带模型原生联网 tools）
    let answer = '';
    let seq = 0;
    const messages = buildChatMessages(chatCtx, msg.question);
    /** 单轮流式请求：delta 实时透传给面板，返回结构化结局（含收集到的 tool_calls） */
    const streamRound = async (
      roundMessages: ChatMessage[],
      tools?: unknown[],
    ): Promise<ChatStreamOutcome> => {
      const gen = chatStream({
        baseURL: profile.baseURL,
        apiKey: profile.apiKey,
        model: profile.defaultModel,
        messages: roundMessages,
        signal,
        ...(tools ? { tools } : {}),
      });
      let step = await gen.next();
      while (!step.done) {
        answer += step.value;
        emit({ type: 'answer-delta', seq: seq++, delta: step.value });
        step = await gen.next();
      }
      if (step.value.truncatedByLength || step.value.filtered) {
        console.warn('[bilinote] chat stream finished with', step.value.finishReason);
      }
      return step.value;
    };
    /** 无 tools 的纯文本轮：仍返回 tool_calls 则按「不支持」错误处理（保持旧语义） */
    const streamPlain = async () => {
      const outcome = await streamRound(messages);
      if (outcome.toolCalls.length > 0) {
        throw new LLMError(
          'tool_calls',
          '模型返回了客户端工具调用（tool_calls），当前无法执行',
        );
      }
    };
    try {
      if (searchPlan === 'attempt') {
        // 已知支持联网的 Provider：带 tools 尝试；Kimi 内置 $web_search 走协议循环，
        // 被拒（或返回无法执行的工具）按模式降级/报错
        emit({ type: 'tool-start', kind: 'web_search', provider: profile.name });
        try {
          await runBuiltinToolLoop(messages, webSearchTools ?? undefined, streamRound);
          emit({ type: 'tool-done', kind: 'web_search' });
        } catch (e) {
          const toolUnsupported =
            e instanceof LLMError &&
            (e.kind === 'tool_calls' || looksLikeToolUnsupported(e.status, e.message));
          if (!toolUnsupported) throw e;
          if (msg.toolMode === 'force') {
            const message = forceWebSearchUnsupportedMessage(profile);
            await updateTurn(turn.id, { answerMd: answer, status: 'error', error: message });
            emit({ type: 'error', message });
            return;
          }
          // 自动拓展：提示后仅基于课程重跑同一问题（§6 外部工具失败降级为课程内回答）
          emit({
            type: 'tool-failed',
            kind: 'web_search',
            message: '当前模型不支持联网，已仅基于课程回答',
          });
          answer = '';
          await streamPlain();
        }
      } else {
        if (searchPlan === 'unsupported') {
          // 自动拓展 + Provider 能力未知：不消耗模型调用探测，提示后直接仅课程回答
          emit({
            type: 'tool-failed',
            kind: 'web_search',
            message: '当前模型不支持联网，已仅基于课程回答',
          });
        }
        await streamPlain();
      }
    } catch (e) {
      if (e instanceof LLMError && e.kind === 'aborted') {
        // 取消：保留已生成文本，但不写笔记（§9.7）
        await updateTurn(turn.id, { answerMd: answer, status: 'cancelled' });
        emit({ type: 'answer-done', turnId: turn.id, status: 'cancelled' });
        return;
      }
      const message = errorMessage(e);
      await updateTurn(turn.id, { answerMd: answer, status: 'error', error: message });
      emit({ type: 'error', message });
      return;
    }

    // 6. 完成：剥离可能的思考过程（推理型模型常见）后持久化 Turn → 自动记录（§5.6）
    const { answer: finalAnswer } = stripThinking(answer);
    await updateTurn(turn.id, { answerMd: finalAnswer, status: 'done' });

    // C2：先出笔记写入结果（成功 / 失败 / 跳过无事件），answer-done 永远最后
    if (prefs.chatAutoRecord && session.autoRecord) {
      try {
        const note = await appendTurnToNote(session, { ...turn, answerMd: finalAnswer }, ctx);
        emit({
          type: 'note-written',
          noteId: note.id!,
          noteTitle: note.title,
          chatEntryId: turn.id,
        });
      } catch (e) {
        // 笔记写入失败：已完成的回答保留，状态分离（§9.11）
        const message = errorMessage(e);
        await updateTurn(turn.id, { noteWriteStatus: 'failed', error: message });
        emit({ type: 'note-write-failed', turnId: turn.id, message });
      }
    } else {
      await updateTurn(turn.id, { noteWriteStatus: 'skipped' });
    }
    emit({ type: 'answer-done', turnId: turn.id, status: 'done' });
  } catch (e) {
    emit({ type: 'error', message: errorMessage(e) });
  }
}

export default defineBackground(() => {
  // 点击工具栏图标打开侧边栏
  void browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    ?.catch(() => {});

  // P2：同步防抖/队列只在内存 —— SW 重启后恢复：syncing 归位 pending，pending/error 重新入队
  void rehydrateSyncQueue().catch(() => {});

  browser.runtime.onMessage.addListener((msg: BgRequest, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'getVideoContext': {
            const ctx = await resolveVideoContext();
            sendResponse({ ok: true, data: ctx });
            return;
          }
          case 'seek': {
            const tabId = await getActiveTabId();
            if (!tabId) throw new Error('找不到活动标签页');
            const res = await browser.tabs.sendMessage(tabId, {
              type: 'seek',
              seconds: msg.seconds,
              p: msg.p,
            });
            sendResponse({ ok: true, data: res });
            return;
          }
          case 'fetchModels': {
            const models = await fetchModels(msg.baseURL, msg.apiKey);
            sendResponse({ ok: true, data: models });
            return;
          }
          case 'testConnection': {
            const latencyMs = await testConnection(
              msg.baseURL,
              msg.apiKey,
              msg.model,
            );
            sendResponse({ ok: true, data: { latencyMs } });
            return;
          }
          case 'sttTest': {
            // 设置页连通性测试：上传 1s 静音 WAV，能拿到 2xx 即视为端点/密钥可用
            const started = Date.now();
            await transcribeAudio({
              baseURL: msg.baseURL,
              apiKey: msg.apiKey,
              model: msg.model,
              bytes: buildSilentWav(1),
              filename: 'silence.wav',
              mimeType: 'audio/wav',
            });
            sendResponse({ ok: true, data: { latencyMs: Date.now() - started } });
            return;
          }
          case 'reportVideoContext': {
            sendResponse({ ok: true, data: null });
            return;
          }
          case 'notionValidateToken': {
            const client = createNotionClient({ token: msg.token });
            const info = await client.validateToken();
            sendResponse({ ok: true, data: info });
            return;
          }
          case 'notionSearchPages': {
            const config = await getNotionConfig();
            if (!config?.token) throw new Error('请先保存 Notion 令牌');
            const client = createNotionClient({ token: config.token });
            const pages = await client.searchPages(msg.query);
            sendResponse({ ok: true, data: pages });
            return;
          }
          case 'notionSyncNote': {
            const mapping = await enqueueSync(msg.noteId, msg.force);
            sendResponse({ ok: true, data: mapping });
            return;
          }
          case 'notionSyncStatus': {
            const mapping = await getNotionMapping(msg.noteId);
            sendResponse({ ok: true, data: mapping ?? null });
            return;
          }
          case 'connectorTest': {
            const connector = buildConnector(msg.profile);
            const result = await connector.testConnection();
            sendResponse({ ok: true, data: result });
            return;
          }
          case 'imaListKnowledgeBases': {
            const knowledgeBases = await listImaKnowledgeBases({
              clientId: msg.clientId,
              apiKey: msg.apiKey,
            });
            sendResponse({ ok: true, data: knowledgeBases });
            return;
          }
          case 'yuqueListKnowledgeBases': {
            const knowledgeBases = await listYuqueKnowledgeBases({
              token: msg.token,
              host: msg.host,
            });
            sendResponse({ ok: true, data: knowledgeBases });
            return;
          }
          case 'connectorList': {
            const profiles = await listConnectorProfiles();
            const activeId = (await getActiveConnectorProfileId()) ?? profiles[0]?.id;
            const lastSync: Record<
              string,
              { syncStatus: string; lastSyncedAt: number; error?: string } | null
            > = {};
            for (const p of profiles) {
              if (p.kind === 'notion') {
                const rows = await db.notionMappings.toArray();
                const latest = rows.sort((a, b) => b.lastSyncedAt - a.lastSyncedAt)[0];
                lastSync[p.id] = latest
                  ? {
                      syncStatus: latest.syncStatus,
                      lastSyncedAt: latest.lastSyncedAt,
                      error: latest.error,
                    }
                  : null;
              } else {
                const latest = await getLatestConnectorSync(p.id);
                lastSync[p.id] = latest
                  ? {
                      syncStatus: latest.syncStatus,
                      lastSyncedAt: latest.lastSyncedAt,
                      error: latest.error,
                    }
                  : null;
              }
            }
            sendResponse({ ok: true, data: { profiles, activeId, lastSync } });
            return;
          }
          case 'connectorSyncStatus': {
            const row = await getTargetSyncRow(msg.noteId);
            sendResponse({ ok: true, data: row ?? null });
            return;
          }
          case 'noteSaved': {
            await maybeAutoSync(msg.noteId);
            sendResponse({ ok: true, data: null });
            return;
          }
          case 'getPlaybackTime': {
            const t = await getPlaybackTimeSnapshot();
            sendResponse({ ok: true, data: t });
            return;
          }
          case 'chatGetState': {
            const session = (await getSessionByVideo(msg.bvid, msg.cid)) ?? null;
            const topics = session ? await listTopics(session.id) : [];
            const turnsByTopic: Record<string, ChatTurn[]> = {};
            for (const t of topics) turnsByTopic[t.id] = await listTurnsByTopic(t.id);
            const summary = await getLatestSummary(msg.bvid, msg.cid);
            const sub = summary ? undefined : await getCachedSubtitle(msg.bvid, msg.cid);
            const payload: ChatStatePayload = {
              session,
              topics,
              turnsByTopic,
              completeness: detectCompleteness(sub?.cues, summary?.result ?? null),
            };
            sendResponse({ ok: true, data: payload });
            return;
          }
          case 'chatUndo': {
            await removeTurnFromNote(msg.turnId, 'undone');
            sendResponse({ ok: true, data: null });
            return;
          }
          case 'chatSkip': {
            await removeTurnFromNote(msg.turnId, 'skipped');
            sendResponse({ ok: true, data: null });
            return;
          }
          case 'chatRerecord': {
            const turn = await getTurn(msg.turnId);
            if (!turn) throw new Error('问答不存在');
            if (turn.status !== 'done') throw new Error('仅完整回答可以重新记录');
            const topic = await getTopic(turn.topicId);
            const session = topic ? await getSession(topic.sessionId) : undefined;
            if (!session) throw new Error('课程会话不存在');
            const ctx = await resolveVideoContext();
            if (!ctx) throw new Error('未检测到 B站视频页，无法定位课程笔记');
            if (ctx.bvid !== session.bvid || ctx.cid !== session.cid) {
              throw new Error('请先切换到该问答所属的课程视频，再重新记录');
            }
            const note = await appendTurnToNote(session, turn, ctx);
            sendResponse({ ok: true, data: { noteId: note.id, noteTitle: note.title } });
            return;
          }
          case 'chatSetAutoRecord': {
            const session = await getOrCreateSession(msg.bvid, msg.cid);
            await updateSession(session.id, { autoRecord: msg.value });
            sendResponse({ ok: true, data: null });
            return;
          }
          default:
            sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: errorMessage(e) });
      }
    })();
    return true; // 异步 sendResponse
  });

  // ---- 分析流式端口 ----
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== ANALYZE_PORT) return;

    let abort: AbortController | null = null;
    // MV3 SW 保活：长流期间定时触活
    const keepAlive = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
    port.onDisconnect.addListener(() => {
      clearInterval(keepAlive);
      abort?.abort();
    });

    port.onMessage.addListener((raw: AnalyzePortMsg) => {
      if (raw.type === 'cancel') {
        abort?.abort();
        return;
      }
      if (raw.type !== 'analyze') return;

      abort = new AbortController();
      const signal = abort.signal;

      void (async () => {
        // C1：终态事件全部绑定视频身份，UI 丢弃与当前页不匹配的事件；
        // cid=0 表示视频信息尚未解析（仅极早期错误），解析成功后即修正为真实值
        const scope = { bvid: raw.bvid, cid: 0, p: raw.p || 1 };
        const emitScoped = (e: AnalyzePortEvent) => {
          try {
            port.postMessage(e);
          } catch {
            /* 面板已关闭 */
          }
        };
        try {
          // 先解析视频身份，保证后续所有事件（含「未配置模型」错误）都带完整 scope
          const info = await getVideoInfoCached(raw.bvid);
          await upsertVideo({
            bvid: info.bvid,
            aid: info.aid,
            title: info.title,
            cover: info.cover,
            owner: info.owner,
            duration: info.duration,
            parts: info.pages,
          });
          const p = Math.min(Math.max(1, raw.p || 1), Math.max(1, info.pages.length));
          const page = info.pages[p - 1] ?? info.pages[0];
          if (!page) throw new Error('无法解析视频分P信息');
          const cid = page.cid;
          scope.bvid = info.bvid;
          scope.cid = cid;
          scope.p = p;
          const duration = page.duration || info.duration;
          const partTitle = info.pages.length > 1 ? page.part : '';

          const profile = await getActiveProfile();
          if (!profile) {
            emitScoped({
              type: 'error',
              message: '尚未配置模型：请先在扩展设置页添加模型服务（baseURL + API Key）',
              ...scope,
            });
            return;
          }
          // C5：缓存键绑定完整模型身份（名称/模型@服务地址），换服务或同名不同源不串缓存
          const modelId = `${profile.name}/${profile.defaultModel}@${profile.baseURL}`;

          if (!raw.force) {
            const cached = await getCachedSummary(raw.bvid, cid, modelId);
            if (cached) {
              const sub = await getCachedSubtitle(raw.bvid, cid);
              emitScoped({
                type: 'done-cached',
                result: cached.result,
                subtitleSource: sub?.source,
                ...scope,
              });
              return;
            }
          }

          // 字幕（缓存优先，24h）
          const cachedSub = await getCachedSubtitle(raw.bvid, cid);
          let cues = cachedSub?.cues;
          let subtitleSource: SubtitleSource | undefined = cachedSub?.source;
          if (!cues) {
            const sub = await getSubtitleCues(raw.bvid, cid, { aid: info.aid });
            if (!sub || sub.cues.length === 0) {
              if (!raw.transcribe) {
                emitScoped({ type: 'no-subtitle', ...scope });
                return;
              }
              // ---- 语音转写（Beta）：拉音轨 → 上传转写 → 存为字幕缓存，随后走正常分析 ----
              const stt = await getSttConfig();
              if (!stt || !isSttConfig(stt.baseURL, stt.apiKey, stt.model)) {
                emitScoped({
                  type: 'error',
                  message:
                    '请先在设置页配置语音转写服务（支持 Groq 等 OpenAI 兼容端点）',
                  ...scope,
                });
                return;
              }
              const emitStage = (stage: TranscribeStage, percent?: number) =>
                emitScoped({
                  type: 'transcribe-stage',
                  stage,
                  ...(percent !== undefined ? { percent } : {}),
                  ...scope,
                });
              emitStage('download', 0);
              const track = await getAudioTrack(raw.bvid, cid, { duration });
              // 估算体积超限：下载前就拒绝，避免白拉几十 MB（Phase 1 仅单文件 ≤25MB）
              if (track.sizeMB * 1024 * 1024 > MAX_STT_FILE_BYTES) {
                throw new SttError('file_too_large', `约 ${track.sizeMB.toFixed(1)}MB（估算）`);
              }
              const audio = await downloadAudio(track.url, {
                signal,
                onProgress: (percent) => emitStage('download', percent),
              });
              emitStage('stt');
              const { cues: sttCues, text } = await transcribeAudio({
                baseURL: stt.baseURL,
                apiKey: stt.apiKey,
                model: stt.model,
                bytes: audio.bytes,
                filename: track.mimeType === 'video/mp4' ? 'audio.mp4' : 'audio.m4a',
                mimeType: track.mimeType,
                signal,
              });
              const finalCues =
                sttCues.length > 0
                  ? sttCues
                  : text
                    ? // 端点只回整段文本（无 segments）：降级为覆盖全片的单条 cue
                      [{ start: 0, end: duration, text }]
                    : [];
              if (finalCues.length === 0) {
                throw new SttError('bad_response', '转写结果为空（音频可能无声或格式不受支持）');
              }
              emitStage('saving');
              // 写缓存后再分析：下次运行直接命中字幕缓存，不再消耗转写额度
              await saveSubtitle({
                bvid: raw.bvid,
                cid,
                lang: 'stt',
                source: 'stt',
                cues: finalCues,
                fetchedAt: Date.now(),
              });
              cues = finalCues;
              subtitleSource = 'stt';
            } else {
              await saveSubtitle({
                bvid: raw.bvid,
                cid,
                lang: sub.track.lan,
                source: sub.track.isAi ? 'ai' : 'human',
                cues: sub.cues,
                fetchedAt: Date.now(),
              });
              cues = sub.cues;
              subtitleSource = sub.track.isAi ? 'ai' : 'human';
            }
          }

          const prefs = await getPrefs();

          // 可选：弹幕高光作为辅助上下文（F-02，默认关；失败不影响主流程）
          let danmaku: { t: number; text: string }[] | undefined;
          if (prefs.includeDanmaku) {
            try {
              const dm = await getDanmakuSample(cid);
              if (dm.samples.length > 0) danmaku = dm.samples.slice(0, 50);
            } catch {
              /* 弹幕拉取失败不阻塞分析 */
            }
          }

          const result = await summarize({
            cues,
            duration,
            videoTitle: info.title,
            partTitle,
            llm: {
              baseURL: profile.baseURL,
              apiKey: profile.apiKey,
              model: profile.defaultModel,
            },
            contextBudget: prefs.contextBudget,
            danmaku,
            signal,
            onProgress: (e) => {
              // P1.8：done 不直接透传 —— 先落缓存，成功后才由下方发出（失败则报 error）
              if (e.type === 'done') return;
              emitScoped({ ...e, ...scope });
            },
          });
          // P1.8：先持久化再报完成；缓存写失败 → error 而不是 done
          try {
            await saveSummary({ bvid: raw.bvid, cid, modelId, result, createdAt: Date.now() });
          } catch (saveErr) {
            emitScoped({
              type: 'error',
              message: `分析完成，但缓存写入失败：${errorMessage(saveErr)}`,
              ...scope,
            });
            return;
          }
          emitScoped({ type: 'done', result, subtitleSource, ...scope });
        } catch (e) {
          emitScoped({ type: 'error', message: errorMessage(e), ...scope });
        }
      })();
    });
  });

  // ---- AI Chat 流式端口（讨论稿 §7.2）----
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== CHAT_PORT) return;

    let abort: AbortController | null = null;
    // MV3 SW 保活：长流期间定时触活
    const keepAlive = setInterval(() => {
      void browser.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
    port.onDisconnect.addListener(() => {
      clearInterval(keepAlive);
      abort?.abort();
    });

    port.onMessage.addListener((raw: ChatPortMsg) => {
      if (raw.type === 'cancel') {
        abort?.abort();
        return;
      }
      if (raw.type !== 'ask') return;
      // 每个 Session 同时只生成 1 个回答（§5.4）：新 ask 先打断上一轮
      abort?.abort();
      abort = new AbortController();
      void handleChatAsk(port, raw, abort.signal);
    });
  });
});
