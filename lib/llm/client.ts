/**
 * OpenAI 兼容协议客户端（Chat Completions，流式 SSE）。
 * 纯 TS（fetch 可注入），无浏览器依赖，可单测。
 */
import { LLMError, httpError } from './errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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

interface StreamChunk {
  choices?: {
    delta?: { content?: string; tool_calls?: unknown };
    finish_reason?: string | null;
  }[];
}

/**
 * 流式 chat completion：async generator，逐段产出 content delta。
 * 解析 SSE（`data: {...}\n\n`，兼容 `[DONE]`）。
 */
export async function* chatStream(
  params: ChatStreamParams,
): AsyncGenerator<string, void, unknown> {
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
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          continue; // 忽略非 JSON keep-alive 行
        }
        const delta0 = chunk.choices?.[0]?.delta;
        // Provider 请求客户端执行工具（tool_calls）：扩展无法执行，抛错交给上层按「不支持」降级
        if (delta0?.tool_calls) {
          throw new LLMError(
            'tool_calls',
            '模型返回了客户端工具调用（tool_calls），当前无法执行',
          );
        }
        const delta = delta0?.content;
        if (delta) yield delta;
      }
    }
    // 处理尾部残留
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload !== '[DONE]') {
        let chunk: StreamChunk | null = null;
        try {
          chunk = JSON.parse(payload) as StreamChunk;
        } catch {
          /* ignore */
        }
        const delta0 = chunk?.choices?.[0]?.delta;
        if (delta0?.tool_calls) {
          throw new LLMError(
            'tool_calls',
            '模型返回了客户端工具调用（tool_calls），当前无法执行',
          );
        }
        const delta = delta0?.content;
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 非流式便捷封装：收集完整文本 */
export async function chatOnce(
  params: ChatStreamParams,
): Promise<string> {
  let out = '';
  for await (const delta of chatStream(params)) out += delta;
  return out;
}
