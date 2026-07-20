/**
 * Background Service Worker：消息路由 + API 编排。
 * B站与 LLM 的 fetch 全部在这里发出（host permission 覆盖，B站 cookie 随请求附带）。
 */
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import {
  getSubtitleCues,
  getVideoInfo,
  getDanmakuSample,
  BiliApiError,
  type VideoInfo,
} from '../lib/bilibili';
import { fetchModels, testConnection, LLMError } from '../lib/llm';
import {
  createNotionClient,
  syncNoteToNotion,
  NotionError,
  type SyncStorage,
} from '../lib/notion';
import {
  db,
  getCachedSubtitle,
  getCachedSummary,
  getPrefs,
  saveSubtitle,
  saveSummary,
  upsertVideo,
  getActiveProfile,
  getNote,
  getNotionConfig,
  getNotionMapping,
  saveNotionMapping,
  findCoursePageId,
  markNoteSynced,
  type NotionMappingRow,
} from '../lib/storage';
import { summarize } from '../lib/summarize';
import {
  ANALYZE_PORT,
  type AnalyzePortMsg,
  type BgRequest,
  type VideoContextInfo,
} from '../lib/messages';

function errorMessage(e: unknown): string {
  if (e instanceof LLMError) return e.userMessage;
  if (e instanceof NotionError) return e.userMessage;
  if (e instanceof BiliApiError) return `B站接口错误：${e.message}`;
  return (e as Error).message ?? String(e);
}

async function getActiveTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// ---------- Notion 同步（串行队列，PRD F-07 / 6.5） ----------

const notionSyncStorage: SyncStorage = {
  getNote,
  getVideo: async (bvid) => {
    const v = await db.videos.get(bvid);
    if (!v) return undefined;
    return {
      title: v.title,
      pages: v.parts.map((p) => ({ cid: p.cid, page: p.page, part: p.part })),
    };
  },
  getMapping: getNotionMapping,
  saveMapping: saveNotionMapping,
  findCoursePageId,
  markNoteClean: markNoteSynced,
};

async function requireNotionReady(): Promise<{ token: string; rootPageId: string }> {
  const config = await getNotionConfig();
  if (!config?.token || !config.rootPageId) {
    throw new Error('请先在设置页完成 Notion 集成配置（令牌 + 同步根页面）');
  }
  return { token: config.token, rootPageId: config.rootPageId };
}

async function doSyncNote(noteId: number, force?: boolean): Promise<NotionMappingRow> {
  const { token, rootPageId } = await requireNotionReady();
  const client = createNotionClient({ token });
  return syncNoteToNotion({
    client,
    rootPageId,
    noteId,
    force,
    storage: notionSyncStorage,
  });
}

// 所有同步任务经同一队列串行执行（配合客户端限流，避免突发请求打满 3 QPS）
let syncChain: Promise<unknown> = Promise.resolve();

function enqueueSync(noteId: number, force?: boolean): Promise<NotionMappingRow> {
  const job = syncChain.then(() => doSyncNote(noteId, force));
  syncChain = job.catch(() => undefined);
  return job;
}

/** 笔记保存后的自动同步（prefs.autoSyncNotion，默认开） */
async function maybeAutoSync(noteId: number): Promise<void> {
  const prefs = await getPrefs();
  if (!prefs.autoSyncNotion) return;
  const config = await getNotionConfig();
  if (!config?.token || !config.rootPageId) return; // 未配置 Notion：保持「未同步」
  const existing = await getNotionMapping(noteId);
  await saveNotionMapping({
    ...(existing ?? {
      noteId,
      lastSyncedAt: 0,
      notionLastEditedTime: '',
    }),
    syncStatus: 'pending',
    error: undefined,
  });
  await enqueueSync(noteId);
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

/** 从 content script 取当前 bvid/p，再合并 view 接口信息 */
async function resolveVideoContext(): Promise<VideoContextInfo | null> {
  const tabId = await getActiveTabId();
  if (!tabId) return null;
  let pageCtx: { bvid: string; p: number } | null = null;
  try {
    pageCtx = await browser.tabs.sendMessage(tabId, { type: 'queryContext' });
  } catch {
    return null; // 非 B站视频页或 content script 未注入
  }
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

export default defineBackground(() => {
  // 点击工具栏图标打开侧边栏
  void browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    ?.catch(() => {});

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
          case 'noteSaved': {
            await maybeAutoSync(msg.noteId);
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
        try {
          const profile = await getActiveProfile();
          if (!profile) {
            port.postMessage({
              type: 'error',
              message: '尚未配置模型：请先在扩展设置页添加模型服务（baseURL + API Key）',
            });
            return;
          }
          const modelId = `${profile.name}/${profile.defaultModel}`;

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
          const duration = page.duration || info.duration;
          const partTitle = info.pages.length > 1 ? page.part : '';

          if (!raw.force) {
            const cached = await getCachedSummary(raw.bvid, cid, modelId);
            if (cached) {
              port.postMessage({ type: 'done-cached', result: cached.result });
              return;
            }
          }

          // 字幕（缓存优先，24h）
          let cues = (await getCachedSubtitle(raw.bvid, cid))?.cues;
          if (!cues) {
            const sub = await getSubtitleCues(raw.bvid, cid, { aid: info.aid });
            if (!sub || sub.cues.length === 0) {
              port.postMessage({ type: 'no-subtitle' });
              return;
            }
            await saveSubtitle({
              bvid: raw.bvid,
              cid,
              lang: sub.track.lan,
              source: sub.track.isAi ? 'ai' : 'human',
              cues: sub.cues,
              fetchedAt: Date.now(),
            });
            cues = sub.cues;
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
              try {
                port.postMessage(e);
              } catch {
                /* 面板已关闭 */
              }
            },
          });
          await saveSummary({ bvid: raw.bvid, cid, modelId, result, createdAt: Date.now() });
        } catch (e) {
          try {
            port.postMessage({ type: 'error', message: errorMessage(e) });
          } catch {
            /* 面板已关闭 */
          }
        }
      })();
    });
  });
});
