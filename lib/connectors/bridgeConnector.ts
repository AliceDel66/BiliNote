/**
 * Local Markdown/Desktop Bridge 连接器（stable）。
 *
 * 配套本机 bridge（scripts/bridge.mjs，Node ≥20 零依赖）协议 —— JSON in/out，
 * 除约定外所有请求带 Authorization: Bearer <token>，仅监听 127.0.0.1：
 * - GET  /v1/health                  → {ok, name, version, root}
 * - POST /v1/search  {query}         → {results: [{path, snippet}]}
 * - POST /v1/read    {path}          → {path, content}
 * - POST /v1/create  {path, content} → 全量写入（存在即覆盖，自动建目录）
 * - POST /v1/append  {path, content} → 幂等追加：已有内容是 incoming 的前缀则只补
 *   后缀；内容一致则不变；否则全量覆盖（本地笔记永远整篇发送，重复同步不产生重复）
 *
 * 笔记落盘路径：BiliNote/<课程标题>/<分P标签或课程标题>.md（非法文件名字符清洗）。
 */
import type {
  ConnectorDeps,
  ConnectorProfile,
  ConnectorTestResult,
  KnowledgeConnector,
  UpsertNoteInput,
  UpsertNoteResult,
} from './types';

export const DEFAULT_BRIDGE_PORT = 27183;

export type BridgeErrorKind = 'connect' | 'auth' | 'http';

export class BridgeError extends Error {
  constructor(
    readonly kind: BridgeErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BridgeError';
  }

  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'bridge 令牌不正确（401），请与 bridge 启动时打印 / 设置的 token 核对';
      case 'connect':
        return '无法连接本机 bridge：请先在终端运行 node scripts/bridge.mjs --root <你的笔记目录>';
      default:
        return `bridge 返回错误（HTTP ${this.status ?? '?'}）：${this.message}`;
    }
  }
}

/** 清洗文件名片段：去掉 / \ : * ? " < > | 与控制字符，折叠空白；空名兜底 */
export function sanitizePathSegment(raw: string): string {
  const cleaned = raw
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || '未命名';
}

/** 笔记 → bridge 内的相对路径（posix 风格，bridge 侧再做根目录 containment 校验） */
export function bridgeNotePath(input: { courseTitle: string; partLabel?: string }): string {
  const course = sanitizePathSegment(input.courseTitle);
  const leaf = sanitizePathSegment(input.partLabel ?? input.courseTitle);
  return `BiliNote/${course}/${leaf}.md`;
}

export function createBridgeConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const port = Number(profile.config.port) || DEFAULT_BRIDGE_PORT;
  const token = String(profile.config.token ?? '');
  const base = `http://127.0.0.1:${port}`;
  const f = deps?.fetchImpl ?? globalThis.fetch;
  if (!f) throw new BridgeError('connect', '当前环境无可用 fetch');

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let resp: Response;
    try {
      resp = await f(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new BridgeError('connect', (e as Error).message);
    }
    if (resp.status === 401) throw new BridgeError('auth', 'HTTP 401', 401);
    if (!resp.ok) {
      let message = '';
      try {
        const j = (await resp.json()) as { error?: string };
        message = j.error ?? '';
      } catch {
        /* 非 JSON 错误体 */
      }
      throw new BridgeError('http', message || resp.statusText, resp.status);
    }
    return (await resp.json()) as T;
  }

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const j = await request<{ ok?: boolean; root?: string; version?: number }>(
          'GET',
          '/v1/health',
        );
        return {
          ok: true,
          detail: `已连接本机 bridge（端口 ${port}${j.root ? `，目录：${j.root}` : ''}）`,
        };
      } catch (e) {
        return {
          ok: false,
          detail: e instanceof BridgeError ? e.userMessage : (e as Error).message,
        };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      const path = input.externalId ?? bridgeNotePath(input);
      if (input.externalId) {
        await request('POST', '/v1/append', { path, content: input.contentMd });
      } else {
        await request('POST', '/v1/create', { path, content: input.contentMd });
      }
      return { externalId: path, editedAt: Date.now() };
    },
  };
}
