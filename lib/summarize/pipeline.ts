/**
 * 总结管线（map-reduce）：
 * 1. 估算字幕 token；超过上下文预算 60% 时按时间窗切块（重叠 30s）
 * 2. Map：逐块摘要（并行，并发 ≤ 3）
 * 3. Reduce：合并为全局大纲 + 分段总结 + 难点讲解（流式）
 * 4. 时间戳校验：越界锚点丢弃
 * 5. 模型输出非 JSON：一次修复重试，仍失败降级为原文 markdown
 */
import type { Cue } from '../bilibili/types';
import type { DanmakuItem } from '../bilibili/danmaku';
import { chatStream, chatOnce, LLMError, type ChatMessage } from '../llm';
import { parseTimestamp } from '../types';
import { chunkCues, cuesText, estimateTokens, type CueChunk } from './chunk';
import { mapPrompt, reducePrompt, repairPrompt } from './prompts';
import type {
  AnalysisResult,
  ExtensionItem,
  KeyPoint,
  OutlineItem,
  ProgressEvent,
  SectionSummary,
} from './types';

export interface SummarizeParams {
  cues: Cue[];
  /** 视频时长（秒） */
  duration: number;
  videoTitle: string;
  partTitle?: string;
  llm: { baseURL: string; apiKey: string; model: string };
  /** 模型上下文预算（token），默认 8000 */
  contextBudget?: number;
  /** 可选：弹幕采样，作为 reduce 阶段的「弹幕高光」辅助上下文 */
  danmaku?: DanmakuItem[];
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  fetchImpl?: typeof fetch;
}

const CHUNK_OVERLAP_SECONDS = 30;
const MAP_CONCURRENCY = 3;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * 剥离推理型模型输出的 <think>…</think> 思考块（含未闭合/孤立标签）。
 * 推理模型常把 CoT 包在 think 标签里再输出 JSON，不剥掉会让 JSON 提取抓错起点。
 */
export function stripThinkTags(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 未闭合的 think 块：其后若出现 JSON 起点（围栏或独占行 {），截断到该处；否则整段丢弃
  const open = t.search(/<think>/i);
  if (open >= 0) {
    const rest = t.slice(open + 7);
    const fenceIdx = rest.search(/```/);
    const braceLine = rest.search(/^\s*\{/m);
    const cut = [fenceIdx, braceLine].filter((i) => i >= 0).sort((a, b) => a - b)[0];
    t = (t.slice(0, open) + (cut !== undefined ? rest.slice(cut) : '')).trim();
  }
  return t.replace(/<\/?think>/gi, '').trim();
}

/** 从模型输出中提取 JSON（容忍 <think> 思考块、```json 围栏与前后杂文本） */
export function extractJson(text: string): unknown {
  let t = stripThinkTags(text);
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(t.slice(start, end + 1));
    }
    throw new Error('输出不是合法 JSON');
  }
}

function clampTime(v: unknown, duration: number): number | null {
  let seconds: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) seconds = v;
  else if (typeof v === 'string') seconds = parseTimestamp(v);
  if (seconds === null) return null;
  if (seconds < 0 || seconds > duration) return null;
  return Math.floor(seconds);
}

const EXTENSION_TITLE_LIMIT = 60;
const EXTENSION_DETAIL_LIMIT = 300;

/** 清洗 extensions / caveats 条目：坏条目丢弃，超长裁剪；缺失/非数组 → []（兼容旧缓存） */
function parseExtensionItems(raw: unknown): ExtensionItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtensionItem[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.title !== 'string' || !e.title.trim()) continue;
    if (typeof e.detail !== 'string' || !e.detail.trim()) continue;
    out.push({
      title: e.title.trim().slice(0, EXTENSION_TITLE_LIMIT),
      detail: e.detail.trim().slice(0, EXTENSION_DETAIL_LIMIT),
    });
  }
  return out;
}

/** 校验并清洗模型输出；时间戳越界的锚点丢弃 */
export function validateResult(raw: unknown, duration: number): AnalysisResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const outline: OutlineItem[] = [];
  if (Array.isArray(obj.outline)) {
    for (const item of obj.outline) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const time = clampTime(o.time, duration);
      if (typeof o.title === 'string' && o.title && time !== null) {
        outline.push({ title: o.title, time });
      }
    }
  }

  const sections: SectionSummary[] = [];
  if (Array.isArray(obj.sections)) {
    for (const item of obj.sections) {
      if (typeof item !== 'object' || item === null) continue;
      const s = item as Record<string, unknown>;
      const start = clampTime(s.start, duration);
      const end = clampTime(s.end, duration) ?? duration;
      if (typeof s.title === 'string' && s.title && start !== null) {
        sections.push({
          title: s.title,
          start,
          end: Math.max(end, start),
          points: Array.isArray(s.points)
            ? s.points.filter((p): p is string => typeof p === 'string')
            : [],
        });
      }
    }
  }

  const keyPoints: KeyPoint[] = [];
  if (Array.isArray(obj.keyPoints)) {
    for (const item of obj.keyPoints) {
      if (typeof item !== 'object' || item === null) continue;
      const k = item as Record<string, unknown>;
      if (typeof k.point === 'string' && k.point) {
        const time = clampTime(k.time, duration);
        keyPoints.push({
          point: k.point,
          explanation:
            typeof k.explanation === 'string' ? k.explanation : '',
          ...(time !== null ? { time } : {}),
        });
      }
    }
  }

  if (outline.length === 0 && sections.length === 0) return null;
  return {
    outline,
    sections,
    keyPoints,
    extensions: parseExtensionItems(obj.extensions),
    caveats: parseExtensionItems(obj.caveats),
  };
}

export async function summarize(
  params: SummarizeParams,
): Promise<AnalysisResult> {
  const emit = params.onProgress ?? (() => {});
  const budget = params.contextBudget ?? 8000;
  const chunkBudget = Math.floor(budget * 0.6);
  const totalTokens = estimateTokens(cuesText(params.cues));

  const chunks: CueChunk[] =
    totalTokens <= chunkBudget
      ? [
          {
            index: 0,
            cues: params.cues,
            start: params.cues[0]?.start ?? 0,
            end: params.cues[params.cues.length - 1]?.end ?? params.duration,
          },
        ]
      : chunkCues(params.cues, {
          budgetTokens: chunkBudget,
          overlapSeconds: CHUNK_OVERLAP_SECONDS,
        });

  // ---- Map ----
  const llmBase = { ...params.llm, signal: params.signal, fetchImpl: params.fetchImpl };
  const chunkSummaries = await mapWithConcurrency(
    chunks,
    MAP_CONCURRENCY,
    async (chunk) => {
      emit({ type: 'chunk-start', index: chunk.index, total: chunks.length });
      const text = await chatOnce({
        ...llmBase,
        messages: mapPrompt(
          params.videoTitle,
          params.partTitle ?? '',
          chunk,
        ) as ChatMessage[],
      });
      emit({
        type: 'chunk-done',
        index: chunk.index,
        total: chunks.length,
        preview: text.split('\n')[0]?.slice(0, 80) ?? '',
      });
      return text;
    },
  );

  // ---- Reduce（流式）----
  emit({ type: 'reduce-start' });
  let reduceText = '';
  for await (const delta of chatStream({
    ...llmBase,
    messages: reducePrompt(
      params.videoTitle,
      params.partTitle ?? '',
      params.duration,
      chunkSummaries,
      params.danmaku,
    ) as ChatMessage[],
  })) {
    reduceText += delta;
    emit({ type: 'reduce-delta', text: reduceText });
  }

  // ---- 解析（失败 → 修复重试一次 → 降级原文）----
  let result = tryParse(reduceText, params.duration);
  if (!result) {
    try {
      const repaired = await chatOnce({
        ...llmBase,
        messages: repairPrompt(reduceText) as ChatMessage[],
      });
      result = tryParse(repaired, params.duration);
    } catch (e) {
      if (e instanceof LLMError && e.kind === 'aborted') throw e;
      // 修复请求本身失败 → 走降级
    }
  }
  if (!result) {
    result = {
      outline: [],
      sections: [],
      keyPoints: [],
      extensions: [],
      caveats: [],
      rawMarkdown: reduceText,
    };
  }
  result.tokenUsage = { estimatedInput: totalTokens };

  emit({ type: 'done', result });
  return result;
}

function tryParse(text: string, duration: number): AnalysisResult | null {
  try {
    return validateResult(extractJson(text), duration);
  } catch {
    return null;
  }
}
