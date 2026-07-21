/**
 * 模型原生联网搜索能力检测（讨论稿 §5.4）。
 * 策略：已知 Provider 查表 + 尝试后按错误特征检测，不做持久化探测。
 * 纯 TS，可单测。
 */
import { LLMError, type ChatMessage, type ChatStreamOutcome } from '../llm';
import type { ToolMode } from './types';

/**
 * Kimi（Moonshot）内置联网工具：搜索在服务端执行，但协议上模型仍以流式
 * tool_calls 请求 $web_search，客户端需回传 assistant tool_calls + role=tool
 * 空 ack 后再次请求（见 runBuiltinToolLoop）。
 * 见 https://platform.moonshot.cn/docs/guide/use-web-search
 */
const KIMI_WEB_SEARCH_TOOLS: unknown[] = [
  { type: 'builtin_function', function: { name: '$web_search' } },
];

/**
 * 已知 Provider 的联网工具表。命中返回 tools 参数；未命中返回 null（能力未知，
 * 不盲目透传 tools —— 部分 Provider 对未知字段直接 400，会白白烧掉一次模型调用）。
 */
export function webSearchToolsFor(baseURL: string): unknown[] | null {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.includes('moonshot.cn')) return KIMI_WEB_SEARCH_TOOLS;
  return null;
}

/** 工具被拒的错误特征：HTTP 400/404/422 且报错文案提及 tool/function/内置联网 */
const TOOL_UNSUPPORTED_RE =
  /tool|function|builtin|web_search|not support|unsupported|unknown/i;

/**
 * 判断一次失败是否属于「Provider/模型不支持 tools 参数或该内置工具」。
 * body 传 LLMError.message（httpError 已截断到 200 字符的错误响应体）。
 */
export function looksLikeToolUnsupported(
  status: number | undefined,
  body: string,
): boolean {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return TOOL_UNSUPPORTED_RE.test(body);
}

/** 联网编排决策：不联网 / 带 tools 尝试 / 直接走「不支持」路径（不消耗模型调用） */
export type SearchPlan = 'none' | 'attempt' | 'unsupported';

/**
 * 模式 × Provider 能力决策矩阵：
 * - 仅课程：永远不联网；
 * - 自动拓展 / 强制联网：能力表命中 → 带 tools 尝试；未命中 → 直接按不支持处理
 *   （自动拓展降级为仅课程，强制联网报硬错误，均不发模型请求）。
 */
export function decideSearchPlan(mode: ToolMode, hasTools: boolean): SearchPlan {
  if (mode === 'course') return 'none';
  return hasTools ? 'attempt' : 'unsupported';
}

// ---------- Kimi 内置联网工具协议循环 ----------

/** Kimi 内置联网工具名：搜索在服务端执行，客户端只需按协议回传 tool_call 消息 */
export const BUILTIN_WEB_SEARCH_TOOL = '$web_search';

/** 内置工具循环轮次上限（含首轮）：防止模型反复要求调用把请求打满 */
export const WEB_SEARCH_MAX_ROUNDS = 3;

/**
 * Kimi 内置工具协议循环（https://platform.moonshot.cn/docs/guide/use-web-search）：
 * 某轮流式结局带 tool_calls 且全部叫 $web_search 时——
 * 1. 回传一条 assistant 消息（携带原样 tool_calls）；
 * 2. 每个 tool_call 追加一条 role=tool 空 ack（tool_call_id 对应）；
 * 3. 用同一 messages 数组重新发起请求，继续流式产出。
 * 某轮无 tool_calls → 返回该轮结局（正常回答流程）。
 * 出现非内置工具名，或达到 WEB_SEARCH_MAX_ROUNDS 仍要调用 → 抛 LLMError('tool_calls')，
 * 由上层按既有「工具不支持」路径降级/报错。
 *
 * roundFn 由调用方实现：发起一轮流式请求并实时透出 delta，返回结构化结局。
 */
export async function runBuiltinToolLoop(
  messages: ChatMessage[],
  tools: unknown[] | undefined,
  roundFn: (roundMessages: ChatMessage[], tools: unknown[] | undefined) => Promise<ChatStreamOutcome>,
): Promise<ChatStreamOutcome> {
  const history = [...messages];
  for (let round = 1; ; round++) {
    const outcome = await roundFn(history, tools);
    if (outcome.toolCalls.length === 0) return outcome;
    const allBuiltin = outcome.toolCalls.every((c) => c.name === BUILTIN_WEB_SEARCH_TOOL);
    if (!allBuiltin || round >= WEB_SEARCH_MAX_ROUNDS) {
      throw new LLMError(
        'tool_calls',
        '模型返回了无法执行的客户端工具调用（tool_calls），当前无法执行',
      );
    }
    history.push({
      role: 'assistant',
      content: '',
      tool_calls: outcome.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments },
      })),
    });
    for (const call of outcome.toolCalls) {
      history.push({ role: 'tool', tool_call_id: call.id, content: '' });
    }
  }
}
