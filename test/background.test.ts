// Background 端口协议集成测试（C1/C2 契约，P1.2 / P1.3 / P1.6 / P1.8，pageUrl，启动 rehydrate）。
// 策略：wxt/browser + 外部 IO（bilibili/llm/summarize/connectors）打 mock，
// IndexedDB 用 fake-indexeddb 跑真实 db/chat/storage，从端口事件断言端到端行为。
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------- 可控开关（vi.hoisted：供 mock 工厂闭包引用） ----------

const control = vi.hoisted(() => ({
  videoInfo: null as null | Record<string, unknown>,
  subtitle: null as null | Record<string, unknown>,
  danmaku: { samples: [] as unknown[] },
  page: { bvid: 'BV1x', p: 1 },
  playbackTime: 42,
  chatRounds: [] as { deltas: string[]; outcome: Record<string, unknown> }[],
  chatCalls: [] as Record<string, unknown>[],
  summarizeImpl: null as null | ((params: Record<string, unknown>) => Promise<unknown>),
  saveSummaryImpl: null as null | ((row: Record<string, unknown>) => Promise<void>),
  saveNoteCASImpl: null as
    | null
    | ((id: number, patch: { contentMd?: string }, rev: number) => Promise<unknown>),
  activeConnectorProfile: null as null | Record<string, unknown>,
  syncNoteToTarget: null as null | ((noteId: number) => Promise<Record<string, unknown>>),
  syncCalls: [] as number[],
}));

const bg = vi.hoisted(() => {
  function makeArea() {
    const data: Record<string, unknown> = {};
    return {
      async get(key?: string | string[] | null) {
        if (key == null) return { ...data };
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in data) out[k] = data[k];
        return out;
      },
      async set(items: Record<string, unknown>) {
        Object.assign(data, items);
      },
      async remove(key: string | string[]) {
        for (const k of Array.isArray(key) ? key : [key]) delete data[k];
      },
      async clear() {
        for (const k of Object.keys(data)) delete data[k];
      },
    };
  }
  const connectListeners: ((port: unknown) => void)[] = [];
  const messageListeners: ((msg: unknown, sender: unknown, sendResponse: unknown) => unknown)[] =
    [];
  const browser = {
    storage: { local: makeArea(), sync: makeArea() },
    runtime: {
      onConnect: { addListener: (fn: (port: unknown) => void) => connectListeners.push(fn) },
      onMessage: {
        addListener: (
          fn: (msg: unknown, sender: unknown, sendResponse: unknown) => unknown,
        ) => messageListeners.push(fn),
      },
      getPlatformInfo: async () => ({}),
      sendMessage: async () => undefined,
    },
    tabs: {
      query: async () => [{ id: 1 }],
      get: async () => ({ id: 1, url: 'https://www.bilibili.com/video/BV1x' }),
      sendMessage: async (_tabId: number, msg: { type?: string }) => {
        if (msg?.type === 'queryContext') return { bvid: control.page.bvid, p: control.page.p };
        if (msg?.type === 'getPlaybackTime') return control.playbackTime;
        return null;
      },
    },
    scripting: { executeScript: async () => [] },
    sidePanel: { setPanelBehavior: async () => undefined },
  };
  return { connectListeners, messageListeners, browser };
});

vi.mock('wxt/browser', () => ({ browser: bg.browser }));
vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (fn: unknown) => fn,
}));

vi.mock('../lib/bilibili', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/bilibili')>();
  return {
    ...orig,
    getVideoInfo: async () => control.videoInfo,
    getSubtitleCues: async () => control.subtitle,
    getDanmakuSample: async () => control.danmaku,
  };
});

vi.mock('../lib/llm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/llm')>();
  return {
    ...orig,
    chatStream: (params: Record<string, unknown>) => {
      control.chatCalls.push(params);
      const round = control.chatRounds.shift() ?? {
        deltas: [] as string[],
        outcome: { finishReason: 'stop', toolCalls: [], truncatedByLength: false, filtered: false },
      };
      return (async function* () {
        for (const d of round.deltas) yield d;
        return round.outcome;
      })();
    },
  };
});

vi.mock('../lib/summarize', () => ({
  summarize: (params: Record<string, unknown>) => control.summarizeImpl!(params),
}));

vi.mock('../lib/connectors', () => ({
  buildConnector: () => {
    throw new Error('测试不应构建连接器');
  },
  getActiveConnectorProfile: async () => control.activeConnectorProfile,
  getTargetSyncRow: async () => null,
  listConnectorProfiles: async () => [],
  getActiveConnectorProfileId: async () => null,
  syncNoteToTarget: async (noteId: number) => {
    control.syncCalls.push(noteId);
    return control.syncNoteToTarget!(noteId);
  },
}));

vi.mock('../lib/storage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/storage')>();
  return {
    ...orig,
    saveSummary: (row: Parameters<typeof orig.saveSummary>[0]) =>
      control.saveSummaryImpl
        ? control.saveSummaryImpl(row as Record<string, unknown>)
        : orig.saveSummary(row),
    saveNoteCAS: (
      id: number,
      patch: Parameters<typeof orig.saveNoteCAS>[1],
      expectedRev: number,
    ) =>
      control.saveNoteCASImpl
        ? control.saveNoteCASImpl(id, patch, expectedRev)
        : orig.saveNoteCAS(id, patch, expectedRev),
  };
});

// ---------- 被测入口与真实数据层 ----------

import backgroundMain from '../entrypoints/background';
import {
  NoteRevConflict,
  addProfile,
  createNote,
  db,
  getCachedSummary,
  getNote,
  getNotionMapping,
  setPrefs,
} from '../lib/storage';
import { getSessionByVideo, getTopic, listTurnsByTopic } from '../lib/chat';
import { ANALYZE_PORT, CHAT_PORT } from '../lib/messages';

// ---------- 测试工具 ----------

const OK_OUTCOME = {
  finishReason: 'stop',
  toolCalls: [] as unknown[],
  truncatedByLength: false,
  filtered: false,
};

const KIMI_TOOLS = [{ type: 'builtin_function', function: { name: '$web_search' } }];

function videoInfoFor(
  bvid: string,
  pages: { cid: number; page: number; part: string; duration: number }[],
) {
  return {
    bvid,
    aid: 1,
    title: '操作系统课程',
    cover: '',
    owner: 'up主',
    ownerMid: 1,
    duration: 600,
    pages,
  } as unknown as Record<string, unknown>;
}

function subtitleResult() {
  return {
    track: { id: 1, lan: 'zh', lanDoc: '中文', subtitleUrl: '', isAi: false },
    tracksCount: 1,
    cues: [{ start: 0, end: 5, text: '字幕内容' }],
  } as unknown as Record<string, unknown>;
}

const ANALYSIS = {
  outline: [{ title: '导论', time: 0 }],
  sections: [],
  keyPoints: [],
  extensions: [],
  caveats: [],
};

function defaultSummarizeImpl() {
  return async (params: Record<string, unknown>) => {
    const onProgress = params.onProgress as ((e: Record<string, unknown>) => void) | undefined;
    onProgress?.({ type: 'chunk-start', index: 0, total: 1 });
    onProgress?.({ type: 'done', result: ANALYSIS });
    return ANALYSIS;
  };
}

class FakePort {
  readonly events: Record<string, unknown>[] = [];
  private msgLs: ((m: unknown) => void)[] = [];
  private discLs: (() => void)[] = [];
  readonly onMessage = { addListener: (fn: (m: unknown) => void) => this.msgLs.push(fn) };
  readonly onDisconnect = { addListener: (fn: () => void) => this.discLs.push(fn) };
  constructor(readonly name: string) {}
  postMessage(e: Record<string, unknown>) {
    this.events.push(e);
  }
  send(m: unknown) {
    for (const fn of this.msgLs) fn(m);
  }
  disconnect() {
    for (const fn of this.discLs) fn();
  }
}

const livePorts: FakePort[] = [];

function startBg() {
  (backgroundMain as unknown as () => void)();
}

function connectPort(name: string): FakePort {
  const port = new FakePort(name);
  livePorts.push(port);
  for (const fn of bg.connectListeners) fn(port);
  return port;
}

async function waitForEvent(port: FakePort, type: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!port.events.some((e) => e.type === type)) {
        throw new Error(`等待事件 ${type}，当前：${port.events.map((e) => e.type).join(',')}`);
      }
    },
    { timeout: 4000, interval: 10 },
  );
}

function ask(
  port: FakePort,
  patch: Partial<{
    topicId: string;
    question: string;
    clientRequestId: string;
    toolMode: 'course' | 'auto' | 'force';
  }> = {},
) {
  port.send({
    type: 'ask',
    question: '什么是进程？',
    clientRequestId: `req-${crypto.randomUUID()}`,
    toolMode: 'course',
    ...patch,
  });
}

async function seedProfile(baseURL = 'https://api.moonshot.cn/v1') {
  const p = await addProfile({
    name: 'Kimi',
    baseURL,
    apiKey: 'sk-test',
    defaultModel: 'kimi-k2',
  });
  await setPrefs({ activeProfileId: p.id });
  return p;
}

beforeEach(async () => {
  await Promise.all([
    db.videos.clear(),
    db.subtitles.clear(),
    db.summaries.clear(),
    db.notes.clear(),
    db.noteVersions.clear(),
    db.notionMappings.clear(),
    db.chatSessions.clear(),
    db.chatTopics.clear(),
    db.chatTurns.clear(),
    db.connectorSync.clear(),
  ]);
  await bg.browser.storage.local.clear();
  await bg.browser.storage.sync.clear();
  bg.connectListeners.length = 0;
  bg.messageListeners.length = 0;
  control.chatRounds = [];
  control.chatCalls = [];
  control.syncCalls = [];
  control.saveSummaryImpl = null;
  control.saveNoteCASImpl = null;
  control.activeConnectorProfile = null;
  control.syncNoteToTarget = null;
  control.playbackTime = 42;
  control.danmaku = { samples: [] };
  control.summarizeImpl = defaultSummarizeImpl();
});

afterEach(() => {
  for (const p of livePorts.splice(0)) p.disconnect();
});

// ---------- 分析端口（C1 / P1.8 / C5） ----------

describe('ANALYZE_PORT 身份绑定与先存后报', () => {
  beforeEach(async () => {
    control.videoInfo = videoInfoFor('BV1ana', [
      { cid: 11, page: 1, part: '导论', duration: 300 },
      { cid: 22, page: 2, part: '进程管理', duration: 300 },
    ]);
    control.subtitle = subtitleResult();
    await seedProfile();
    startBg();
  });

  it('C1+P1.8+C5：done 携带 {bvid,cid,p}；saveSummary 先于 done；缓存键含 baseURL；管线 done 不透传', async () => {
    const port = connectPort(ANALYZE_PORT);
    // saveSummary 被调时不得已有 done 事件（先持久化再报完成）
    control.saveSummaryImpl = async (row) => {
      expect(port.events.some((e) => e.type === 'done')).toBe(false);
      await db.summaries.put(row as never);
    };
    port.send({ type: 'analyze', bvid: 'BV1ana', p: 2 });
    await waitForEvent(port, 'done');

    const dones = port.events.filter((e) => e.type === 'done');
    expect(dones).toHaveLength(1); // summarize 内部的 done 被抑制，只有落缓存后这一个
    expect(dones[0]).toMatchObject({ bvid: 'BV1ana', cid: 22, p: 2 });
    // 进度事件也带身份
    const progress = port.events.find((e) => e.type === 'chunk-start');
    expect(progress).toMatchObject({ bvid: 'BV1ana', cid: 22, p: 2 });
    // C5：缓存键 = name/model@baseURL
    const cached = await getCachedSummary(
      'BV1ana',
      22,
      'Kimi/kimi-k2@https://api.moonshot.cn/v1',
    );
    expect(cached?.result).toEqual(ANALYSIS);
  });

  it('C1：done-cached / no-subtitle / error 均携带身份', async () => {
    // done-cached
    await db.summaries.add({
      bvid: 'BV1ana',
      cid: 22,
      modelId: 'Kimi/kimi-k2@https://api.moonshot.cn/v1',
      result: ANALYSIS,
      createdAt: 1,
    });
    const p1 = connectPort(ANALYZE_PORT);
    p1.send({ type: 'analyze', bvid: 'BV1ana', p: 2 });
    await waitForEvent(p1, 'done-cached');
    expect(p1.events[0]).toMatchObject({ type: 'done-cached', bvid: 'BV1ana', cid: 22, p: 2 });

    // no-subtitle
    control.subtitle = null;
    const p2 = connectPort(ANALYZE_PORT);
    p2.send({ type: 'analyze', bvid: 'BV1ana', p: 1, force: true });
    await waitForEvent(p2, 'no-subtitle');
    expect(p2.events[0]).toMatchObject({ type: 'no-subtitle', bvid: 'BV1ana', cid: 11, p: 1 });

    // error（未配置模型：视频信息已先解析，身份完整）
    await bg.browser.storage.local.clear();
    const p3 = connectPort(ANALYZE_PORT);
    p3.send({ type: 'analyze', bvid: 'BV1ana', p: 2 });
    await waitForEvent(p3, 'error');
    expect(p3.events[0]).toMatchObject({ type: 'error', bvid: 'BV1ana', cid: 22, p: 2 });
    expect(String(p3.events[0].message)).toContain('尚未配置模型');
  });

  it('P1.8：缓存写入失败 → 报 error（缓存写入失败）而非 done', async () => {
    control.saveSummaryImpl = async () => {
      throw new Error('磁盘满了');
    };
    const port = connectPort(ANALYZE_PORT);
    port.send({ type: 'analyze', bvid: 'BV1ana', p: 1 });
    await waitForEvent(port, 'error');
    expect(port.events.some((e) => e.type === 'done')).toBe(false);
    const err = port.events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ bvid: 'BV1ana', cid: 11, p: 1 });
    expect(String(err?.message)).toContain('缓存写入失败');
  });
});

// ---------- Chat 端口（C2 / P1.2 / P1.3 / P1.6 / pageUrl） ----------

describe('CHAT_PORT 契约', () => {
  beforeEach(async () => {
    control.videoInfo = videoInfoFor('BV1chat', [
      { cid: 55, page: 1, part: '导论', duration: 600 },
      { cid: 66, page: 2, part: '进程管理', duration: 600 },
    ]);
    control.subtitle = subtitleResult();
    control.page = { bvid: 'BV1chat', p: 1 };
    await seedProfile();
    startBg();
  });

  it('C2：context-ready(带 topicId) → answer-delta → note-written → answer-done 严格最后；pageUrl 带 /video/', async () => {
    control.chatRounds = [{ deltas: ['课程答案'], outcome: OK_OUTCOME }];
    const port = connectPort(CHAT_PORT);
    ask(port, { clientRequestId: 'r-order' });
    await waitForEvent(port, 'answer-done');

    const types = port.events.map((e) => e.type);
    expect(types[0]).toBe('context-ready');
    expect(types.filter((t) => t === 'answer-done')).toHaveLength(1);
    expect(types[types.length - 1]).toBe('answer-done');
    expect(types.indexOf('note-written')).toBeGreaterThan(-1);
    expect(types.indexOf('note-written')).toBeLessThan(types.indexOf('answer-done'));

    const ready = port.events[0] as { snapshot: { pageUrl: string }; topicId: string };
    expect(ready.snapshot.pageUrl).toBe('https://www.bilibili.com/video/BV1chat');
    // context-ready 的 topicId 就是轮次实际落入的话题
    const turns = await db.chatTurns.toArray();
    expect(turns).toHaveLength(1);
    expect(turns[0].topicId).toBe(ready.topicId);
    expect(turns[0].noteWriteStatus).toBe('written');
    // P1.3：CAS 路径真正写入了问答块
    const written = port.events.find((e) => e.type === 'note-written') as { noteId: number };
    const note = await getNote(written.noteId);
    expect(note?.contentMd).toContain('课程答案');
    expect(note?.rev).toBeGreaterThanOrEqual(2); // 创建 rev=1，CAS 追加后 +1
  });

  it('pageUrl：分 P>1 时带 ?p=n', async () => {
    control.page = { bvid: 'BV1chat', p: 2 };
    control.chatRounds = [{ deltas: ['x'], outcome: OK_OUTCOME }];
    const port = connectPort(CHAT_PORT);
    ask(port);
    await waitForEvent(port, 'answer-done');
    const ready = port.events[0] as { snapshot: { pageUrl: string; p: number } };
    expect(ready.snapshot.p).toBe(2);
    expect(ready.snapshot.pageUrl).toBe('https://www.bilibili.com/video/BV1chat?p=2');
  });

  it('P1.2：陈旧跨课程 topicId 被忽略并新建话题，轮次绝不落到旧话题', async () => {
    // 第一问：P1（cid 55 的会话），产生话题 T1
    control.chatRounds = [{ deltas: ['第一答'], outcome: OK_OUTCOME }];
    const p1 = connectPort(CHAT_PORT);
    ask(p1, { clientRequestId: 'r-stale-1' });
    await waitForEvent(p1, 'answer-done');
    const t1 = (p1.events[0] as { topicId: string }).topicId;

    // 切到 P2（cid 66 → 另一个会话），却带着 T1 的 topicId 追问
    control.page = { bvid: 'BV1chat', p: 2 };
    control.chatRounds = [{ deltas: ['第二答'], outcome: OK_OUTCOME }];
    const p2 = connectPort(CHAT_PORT);
    ask(p2, { topicId: t1, clientRequestId: 'r-stale-2' });
    await waitForEvent(p2, 'answer-done');
    const adopted = (p2.events[0] as { topicId: string }).topicId;

    expect(adopted).not.toBe(t1);
    const session2 = await getSessionByVideo('BV1chat', 66);
    const adoptedTopic = await getTopic(adopted);
    expect(adoptedTopic?.sessionId).toBe(session2?.id);
    // 旧话题仍然只有最初那一轮；新话题各一轮
    expect(await listTurnsByTopic(t1)).toHaveLength(1);
    expect(await listTurnsByTopic(adopted)).toHaveLength(1);
  });

  it('C2：clientRequestId 回放同样 answer-done 最后（delta → note-written → answer-done）', async () => {
    control.chatRounds = [{ deltas: ['完整回答'], outcome: OK_OUTCOME }];
    const p1 = connectPort(CHAT_PORT);
    ask(p1, { clientRequestId: 'r-dup' });
    await waitForEvent(p1, 'answer-done');

    const p2 = connectPort(CHAT_PORT);
    ask(p2, { clientRequestId: 'r-dup' });
    await waitForEvent(p2, 'answer-done');
    const types = p2.events.map((e) => e.type);
    expect(types).toEqual(['answer-delta', 'note-written', 'answer-done']);
  });

  it('P1.6：Kimi $web_search 循环 —— 回传 assistant tool_calls + tool ack 后再请求，正常收尾', async () => {
    control.chatRounds = [
      {
        deltas: [],
        outcome: {
          ...OK_OUTCOME,
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call_1', name: '$web_search', arguments: '{"q":"进程"}' }],
        },
      },
      { deltas: ['联网答案'], outcome: OK_OUTCOME },
    ];
    const port = connectPort(CHAT_PORT);
    ask(port, { toolMode: 'auto', clientRequestId: 'r-kimi' });
    await waitForEvent(port, 'answer-done');

    expect(control.chatCalls).toHaveLength(2);
    expect(control.chatCalls[0].tools).toEqual(KIMI_TOOLS);
    expect(control.chatCalls[1].tools).toEqual(KIMI_TOOLS);
    // 第二轮请求尾部 = assistant tool_calls 回声 + role=tool 空 ack
    const msgs = control.chatCalls[1].messages as Record<string, unknown>[];
    expect(msgs[msgs.length - 2]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: '$web_search', arguments: '{"q":"进程"}' } },
      ],
    });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '' });

    const types = port.events.map((e) => e.type);
    expect(types).toContain('tool-start');
    expect(types).toContain('tool-done');
    expect(types).not.toContain('tool-failed');
    const turn = (await db.chatTurns.toArray())[0];
    expect(turn.answerMd).toBe('联网答案');
    expect(types[types.length - 1]).toBe('answer-done');
  });

  it('P1.6：force 模式 3 轮仍要调用工具 → 硬错误，不多发请求', async () => {
    const toolRound = () => ({
      deltas: [] as string[],
      outcome: {
        ...OK_OUTCOME,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_1', name: '$web_search', arguments: '{}' }],
      },
    });
    control.chatRounds = [toolRound(), toolRound(), toolRound()];
    const port = connectPort(CHAT_PORT);
    ask(port, { toolMode: 'force', clientRequestId: 'r-force' });
    await waitForEvent(port, 'error');

    expect(control.chatCalls).toHaveLength(3); // MAX=3，含首轮
    expect(port.events.some((e) => e.type === 'answer-done')).toBe(false);
    const err = port.events.find((e) => e.type === 'error');
    expect(String(err?.message)).toContain('无法启用强制联网');
    expect((await db.chatTurns.toArray())[0].status).toBe('error');
  });

  it('P1.3：CAS 首次冲突（编辑器并发写入）→ 按最新行重放成功，note-written 照常', async () => {
    let casCalls = 0;
    control.saveNoteCASImpl = async (id, patch) => {
      casCalls++;
      const latest = await getNote(id);
      if (casCalls === 1) throw new NoteRevConflict(latest!);
      await db.notes.update(id, {
        ...patch,
        dirty: true,
        updatedAt: Date.now(),
        rev: (latest?.rev ?? 1) + 1,
      });
      return getNote(id);
    };
    control.chatRounds = [{ deltas: ['重试后的答案'], outcome: OK_OUTCOME }];
    const port = connectPort(CHAT_PORT);
    ask(port, { clientRequestId: 'r-cas' });
    await waitForEvent(port, 'answer-done');

    expect(casCalls).toBe(2);
    const types = port.events.map((e) => e.type);
    expect(types).toContain('note-written');
    expect(types[types.length - 1]).toBe('answer-done');
    const written = port.events.find((e) => e.type === 'note-written') as { noteId: number };
    expect((await getNote(written.noteId))?.contentMd).toContain('重试后的答案');
  });

  it('C2：笔记写入失败 → note-write-failed 仍在 answer-done 之前', async () => {
    control.saveNoteCASImpl = async () => {
      throw new Error('db down');
    };
    control.chatRounds = [{ deltas: ['回答'], outcome: OK_OUTCOME }];
    const port = connectPort(CHAT_PORT);
    ask(port, { clientRequestId: 'r-fail' });
    await waitForEvent(port, 'answer-done');

    const types = port.events.map((e) => e.type);
    expect(types).toContain('note-write-failed');
    expect(types.indexOf('note-write-failed')).toBeLessThan(types.indexOf('answer-done'));
    expect(types[types.length - 1]).toBe('answer-done');
    expect((await db.chatTurns.toArray())[0].noteWriteStatus).toBe('failed');
  });
});

// ---------- SW 启动同步队列恢复（P2） ----------

describe('启动 rehydrate：stale syncing 归位 + pending/error 重新入队', () => {
  it('notion 连接：syncing→pending，pending/error（含恢复的）入队，synced 与缺笔记的跳过', async () => {
    const mk = (title: string) =>
      createNote({ bvid: 'BV1r', cid: 1, title, contentMd: '# x' });
    const nA = await mk('A（syncing 卡死）');
    const nB = await mk('B（pending）');
    const nC = await mk('C（error）');
    const nD = await mk('D（synced）');
    const base = { lastSyncedAt: 0, notionLastEditedTime: '' };
    await db.notionMappings.add({ noteId: nA.id!, ...base, syncStatus: 'syncing' });
    await db.notionMappings.add({ noteId: nB.id!, ...base, syncStatus: 'pending' });
    await db.notionMappings.add({ noteId: nC.id!, ...base, syncStatus: 'error', error: 'x' });
    await db.notionMappings.add({ noteId: nD.id!, ...base, syncStatus: 'synced' });
    await db.notionMappings.add({ noteId: 999, ...base, syncStatus: 'pending' }); // 笔记不存在

    control.activeConnectorProfile = {
      id: 'notion-prof',
      kind: 'notion',
      name: 'Notion',
      status: 'stable',
      config: {},
      createdAt: 1,
    };
    control.syncNoteToTarget = async (noteId) => ({
      noteId,
      connectorId: 'notion-prof',
      lastSyncedAt: 1,
      notionLastEditedTime: '',
      syncStatus: 'synced',
    });

    startBg();

    await vi.waitFor(
      () => {
        expect([...control.syncCalls].sort((a, b) => a - b)).toEqual(
          [nA.id!, nB.id!, nC.id!].sort((x, y) => x - y),
        );
      },
      { timeout: 4000, interval: 10 },
    );
    expect(control.syncCalls).not.toContain(nD.id);
    expect(control.syncCalls).not.toContain(999);
    // 卡死的 syncing 行已归位 pending（mock 的同步不再回写，保持 pending）
    expect((await getNotionMapping(nA.id!))?.syncStatus).toBe('pending');
  });

  it('未配置连接：不动任何行', async () => {
    const n = await createNote({ bvid: 'BV1r', cid: 1, title: 'A', contentMd: '# x' });
    await db.notionMappings.add({
      noteId: n.id!,
      lastSyncedAt: 0,
      notionLastEditedTime: '',
      syncStatus: 'syncing',
    });
    control.activeConnectorProfile = null;
    startBg();
    await new Promise((r) => setTimeout(r, 100));
    expect(control.syncCalls).toEqual([]);
    expect((await getNotionMapping(n.id!))?.syncStatus).toBe('syncing');
  });
});
