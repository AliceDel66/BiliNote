/**
 * 学习事件统一层（「我的」Tab 数据统计）。
 * 不新建事件表：分析 / 笔记 / 问答三类事件全部由既有 Dexie 表计算得出，
 * 统一为按本地时区「日」分桶的 StudyEvent，供 compute.ts 聚合。
 */

export type StudyEventKind = 'analyze' | 'note' | 'qa';

export interface StudyEvent {
  /** 本地时区日期，'YYYY-MM-DD'（零填充，可直接按字符串比较/排序） */
  day: string;
  kind: StudyEventKind;
  /** 归属课程 bvid（summaries / notes 自带；chatTurns 经 topic→session 反查）。
   *  可选：仅「最常学习课程」洞察使用，其余聚合不依赖。 */
  bvid?: string;
}

/** 本地时区日分桶：ts → 'YYYY-MM-DD'。测试用本地构造的 Date 即可时区无关。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 'YYYY-MM-DD' → 本地零点 Date */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 日期加减 n 天（跨月/跨年安全，走本地 Date 语义） */
export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
}

export interface SummaryEventInput {
  bvid: string;
  createdAt: number;
}

export interface NoteEventInput {
  bvid: string;
  createdAt: number;
}

export interface ChatTurnEventInput {
  createdAt: number;
  status: string;
  /** 由 topicId → sessionId 反查出的 bvid（调用方负责联结） */
  bvid?: string;
}

/**
 * 汇总三类学习事件，按日期升序返回。
 * - 分析事件：每条 summary 一次（重新分析会先删后插，即新事件）；
 * - 笔记事件：取 createdAt——「新增笔记」是学习事件，后续编辑不重复计数；
 * - 问答事件：仅 status === 'done' 的轮次（streaming/cancelled/error 不算完成学习）。
 */
export function collectEvents(input: {
  summaries: readonly SummaryEventInput[];
  notes: readonly NoteEventInput[];
  chatTurns: readonly ChatTurnEventInput[];
}): StudyEvent[] {
  const events: StudyEvent[] = [];
  for (const s of input.summaries) {
    events.push({ day: dayKey(s.createdAt), kind: 'analyze', bvid: s.bvid });
  }
  for (const n of input.notes) {
    events.push({ day: dayKey(n.createdAt), kind: 'note', bvid: n.bvid });
  }
  for (const t of input.chatTurns) {
    if (t.status !== 'done') continue;
    events.push({ day: dayKey(t.createdAt), kind: 'qa', ...(t.bvid ? { bvid: t.bvid } : {}) });
  }
  return events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
