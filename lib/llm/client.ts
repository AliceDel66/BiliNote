/**
 * OpenAI 兼容协议客户端（Chat Completions，流式 SSE）。
 * 纯 TS（fetch 可注入），无浏览器依赖，可单测。
 */
import { LLMError, httpError } from './errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** assistant 消息回传的工具调用（Kimi 内置联网等内置工具协议循环用），原样透传 */
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  /** role=tool 消息对应的 tool_call_id */
  tool_call_id?: string;
}

export interface LLMEndpoint {
  baseURL: string;
  apiKey: string;
}

export interface ChatStreamParams extends LLMEndpoint {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** OpenAI 兼容 tools 参数（如 Kimi 内置联网 $web_search），原样透传进请求体 */
  tools?: unknown[];
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
}

function normalizeBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

async function readErrorBody(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return '';
  }
}

/** GET {baseURL}/models → 模型 id 列表 */
export async function fetchModels(
  baseURL: string,
  apiKey: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<string[]> {
  const f = opts?.fetchImpl ?? globalThis.fetch;
  let resp: Response;
  try {
    resp = await f(`${normalizeBase(baseURL)}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: opts?.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new LLMError('aborted', err.message);
    throw new LLMError('network', err.message);
  }
  if (!resp.ok) throw httpError(resp.status, await readErrorBody(resp));
  interface ModelsResp {
    data?: { id?: string }[];
  }
  const json = (await resp.json()) as ModelsResp;
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** 最小 chat completion 连通性测试，返回耗时 ms */
export async function testConnection(
  baseURL: string,
  apiKey: string,
  model: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<number> {
  const f = opts?.fetchImpl ?? globalThis.fetch;
  const started = Date.now();
  let resp: Response;
  try {
    resp = await f(`${normalizeBase(baseURL)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: opts?.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new LLMError('aborted', err.message);
    throw new LLMError('network', err.message);
  }
  if (!resp.ok) throw httpError(resp.status, await readErrorBody(resp));
  return Date.now() - started;
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  choices?: {
    delta?: { content?: string; tool_calls?: StreamToolCallDelta[] };
    finish_reason?: string | null;
  }[];
}

/** 一次流式请求收到的工具调用（跨 chunk 分片已按 index 合并） */
export interface CollectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * chatStream 的结构化结局（generator return value；`for await` 拿不到，
 * 需要时用 `const g = chatStream(p); … await g.next()` 手动迭代读取）。
 */
export interface ChatStreamOutcome {
  /** 终端 finish_reason 原样值（未收到为 undefined） */
  finishReason?: string;
  /** 模型请求客户端执行的工具调用；空数组 = 正常文本回答 */
  toolCalls: CollectedToolCall[];
  /** finish_reason === 'length'：达到 max_tokens，回答不完整（调用方记录/提示用） */
  truncatedByLength: boolean;
  /** finish_reason === 'content_filter' 但仍有正文（无正文时直接抛 filtered 错误） */
  filtered: boolean;
}

/** 视为「Provider 正常收尾」的 finish_reason：缺少 [DONE] 时不误判截断 */
const TERMINAL_FINISH_REASONS = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

/** 把一条 tool_calls 分片按 index 合并进收集表（OpenAI 流式协议：首片带 id/name，后续片只补 arguments） */
function collectToolCallDelta(into: CollectedToolCall[], deltas: StreamToolCallDelta[]): void {
  for (const d of deltas) {
    const idx = d.index ?? into.length;
    const slot = into[idx] ?? { id: '', name: '', arguments: '' };
    if (d.id) slot.id = d.id;
    if (d.function?.name) slot.name = d.function.name;
    if (d.function?.arguments) slot.arguments += d.function.arguments;
    into[idx] = slot;
  }
}

/**
 * 流式 chat completion：async generator，逐段产出 content delta。
 * 解析 SSE（`data: {...}\n\n`，兼容 `[DONE]`）。
 *
 * 结束语义（P2 加固）：
 * - 流结束既没有 `data: [DONE]` 也没有终端 finish_reason → 抛 LLMError('truncated')
 *   （连接中断 / 响应被截断，调用方不得当作成功）；
 * - finish_reason === 'content_filter' 且全程无正文 → 抛 LLMError('filtered')；
 *   有正文则正常完成，经 outcome.filtered 标注；
 * - finish_reason === 'length' → 正常完成，经 outcome.truncatedByLength 标注；
 * - 流中出现 tool_calls 不再抛错：按 index 合并收集，经 outcome.toolCalls 交给
 *   调用方决策（Kimi 内置联网协议循环 / 非内置工具按不支持降级）。
 */
export async function* chatStream(
  params: ChatStreamParams,
): AsyncGenerator<string, ChatStreamOutcome, unknown> {
  const f = params.fetchImpl ?? globalThis.fetch;
  let resp: Response;
  try {
    resp = await f(`${normalizeBase(params.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: true,
        ...(params.temperature !== undefined
          ? { temperature: params.temperature }
          : {}),
        ...(params.maxTokens !== undefined
          ? { max_tokens: params.maxTokens }
          : {}),
        ...(params.tools !== undefined ? { tools: params.tools } : {}),
      }),
      signal: params.signal,
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') throw new LLMError('aborted', err.message);
    throw new LLMError('network', err.message);
  }
  if (!resp.ok) throw httpError(resp.status, await readErrorBody(resp));
  if (!resp.body) throw new LLMError('bad_response', '响应无 body');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;
  let finishReason: string | undefined;
  let receivedContent = false;
  const toolCalls: CollectedToolCall[] = [];

  /** 解析单个 data: 负载（副作用：收集 tool_calls / finish_reason）；返回是否 [DONE] 与 content delta */
  const parsePayload = (payload: string): { done: boolean; delta?: string } => {
    if (payload === '[DONE]') return { done: true };
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return { done: false }; // 忽略非 JSON keep-alive 行
    }
    const choice0 = chunk.choices?.[0];
    const delta0 = choice0?.delta;
    // Provider 请求客户端执行工具：收集合并，由调用方按工具名决策（见函数头注释）
    if (delta0?.tool_calls) collectToolCallDelta(toolCalls, delta0.tool_calls);
    const fr = choice0?.finish_reason;
    if (fr) finishReason = fr;
    return { done: false, delta: delta0?.content || undefined };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行分隔；逐行处理 data: 前缀
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith('data:')) continue;
        const parsed = parsePayload(line.slice(5).trim());
        if (parsed.done) {
          sawDone = true;
          break;
        }
        if (parsed.delta) {
          receivedContent = true;
          yield parsed.delta;
        }
      }
      if (sawDone) break;
    }
    // 处理尾部残留
    if (!sawDone) {
      const tail = buffer.trim();
      if (tail.startsWith('data:')) {
        const parsed = parsePayload(tail.slice(5).trim());
        if (parsed.done) {
          sawDone = true;
        } else if (parsed.delta) {
          receivedContent = true;
          yield parsed.delta;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // 异常结束当成功是数据损坏来源：无 [DONE] 且无终端 finish_reason → 截断错误
  if (!sawDone && !(finishReason && TERMINAL_FINISH_REASONS.has(finishReason))) {
    throw new LLMError(
      'truncated',
      `流式响应非正常结束（无 [DONE]，finish_reason=${finishReason ?? '无'}）`,
    );
  }
  // 内容过滤且无任何正文：按独立错误类型抛出，避免把空回答当成功
  if (finishReason === 'content_filter' && !receivedContent) {
    throw new LLMError('filtered', '模型内容过滤拦截（content_filter），未产出任何内容');
  }
  return {
    finishReason,
    toolCalls,
    truncatedByLength: finishReason === 'length',
    filtered: finishReason === 'content_filter',
  };
}

/** 非流式便捷封装：收集完整文本 */
export async function chatOnce(
  params: ChatStreamParams,
): Promise<string> {
  let out = '';
  for await (const delta of chatStream(params)) out += delta;
  return out;
}
