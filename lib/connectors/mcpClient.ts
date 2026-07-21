/**
 * 最小 MCP（Model Context Protocol）streamable-HTTP 客户端。
 *
 * 仅实现知识连接需要的三个方法：initialize → tools/list → tools/call，
 * 传输为单端点 POST（JSON-RPC 2.0），响应同时兼容：
 * - 普通 JSON（Content-Type: application/json）
 * - SSE 流（Content-Type: text/event-stream，取与请求 id 匹配的 data 帧）
 *
 * 无会话状态（不处理 Mcp-Session-Id 协商）、不支持通知与批量请求；
 * 每个请求独立 10s 超时。token 永不进入错误信息（§8：凭据不进日志）。
 */

export type McpErrorKind = 'connect' | 'auth' | 'timeout' | 'protocol';

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'McpError';
  }

  /** 面向用户的一行中文提示 */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'MCP 端点拒绝访问（401/403），请检查 Bearer Token';
      case 'timeout':
        return 'MCP 端点响应超时（10s），请确认服务可达后重试';
      case 'protocol':
        return `MCP 协议错误：${this.message}`;
      default:
        return `无法连接 MCP 端点：${this.message}`;
    }
  }
}

export interface McpToolInfo {
  name: string;
  description?: string;
  /** tools/list 原样返回的 inputSchema（用于推断参数键名） */
  inputSchema?: { properties?: Record<string, unknown> };
}

export interface McpServerInfo {
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
}

export interface McpClientOptions {
  endpoint: string;
  token?: string;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
  /** 单请求超时，默认 10000ms */
  timeoutMs?: number;
}

export interface McpClient {
  initialize(): Promise<McpServerInfo>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** 从 SSE 文本中取与请求 id 匹配的 data 帧（忽略通知等非匹配消息） */
export function parseSseForId(text: string, id: number): JsonRpcResponse | null {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(dataLines.join('\n')) as JsonRpcResponse;
    } catch {
      continue;
    }
    if (msg && msg.id === id) return msg;
  }
  return null;
}

export function createMcpClient(opts: McpClientOptions): McpClient {
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new McpError('connect', '当前环境无可用 fetch');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let nextId = 1;

  async function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await f(opts.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (resp.status === 401 || resp.status === 403) {
        throw new McpError('auth', `HTTP ${resp.status}`);
      }
      if (!resp.ok) throw new McpError('connect', `HTTP ${resp.status}`);
      const ct = resp.headers.get('content-type') ?? '';
      const msg: JsonRpcResponse | null = ct.includes('text/event-stream')
        ? parseSseForId(await resp.text(), id)
        : ((await resp.json()) as JsonRpcResponse);
      if (!msg || typeof msg !== 'object') {
        throw new McpError('protocol', '响应中找不到匹配的 JSON-RPC 回复');
      }
      if (msg.error) {
        throw new McpError('protocol', `RPC ${msg.error.code ?? ''} ${msg.error.message ?? ''}`.trim());
      }
      return msg.result;
    } catch (e) {
      if (e instanceof McpError) throw e;
      if (controller.signal.aborted) throw new McpError('timeout', '请求被超时中止');
      throw new McpError('connect', (e as Error).message ?? String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async initialize() {
      const result = (await rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'BiliNote', version: '0.1.0' },
      })) as {
        protocolVersion?: string;
        serverInfo?: { name?: string; version?: string };
      } | undefined;
      return {
        serverName: result?.serverInfo?.name,
        serverVersion: result?.serverInfo?.version,
        protocolVersion: result?.protocolVersion,
      };
    },

    async listTools() {
      const result = (await rpc('tools/list', {})) as
        | { tools?: { name?: string; description?: string; inputSchema?: McpToolInfo['inputSchema'] }[] }
        | undefined;
      const out: McpToolInfo[] = [];
      for (const t of result?.tools ?? []) {
        if (typeof t.name === 'string' && t.name) {
          out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        }
      }
      return out;
    },

    async callTool(name, args) {
      return rpc('tools/call', { name, arguments: args });
    },
  };
}

// ---------- 工具名 → 能力映射（§2.3 通用能力子集） ----------

export const MCP_CAPABILITY_KEYS = ['search', 'read', 'get', 'create', 'append', 'update'] as const;
export type McpCapability = (typeof MCP_CAPABILITY_KEYS)[number];

/** 工具名包含子串即视为具备对应能力（大小写不敏感），按规范顺序去重返回 */
export function mapToolCapabilities(toolNames: string[]): McpCapability[] {
  const found = new Set<string>();
  for (const name of toolNames) {
    const lower = name.toLowerCase();
    for (const key of MCP_CAPABILITY_KEYS) {
      if (lower.includes(key)) found.add(key);
    }
  }
  return MCP_CAPABILITY_KEYS.filter((k) => found.has(k));
}
