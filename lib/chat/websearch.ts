/**
 * 模型原生联网搜索能力检测（讨论稿 §5.4）。
 * 策略：已知 Provider 查表 + 尝试后按错误特征检测，不做持久化探测。
 * 纯 TS，可单测。
 */
import type { ToolMode } from './types';

/**
 * Kimi（Moonshot）内置联网工具：服务端执行搜索并流式返回答案，
 * 无需客户端处理 tool_calls。见 https://platform.moonshot.cn/docs/guide/use-web-search
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
