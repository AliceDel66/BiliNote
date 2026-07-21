/**
 * MCP 连接器：覆盖 remote-mcp（腾讯文档 / 飞书文档 Beta 预设）、custom-mcp（自定义端点）
 * 与 local-mcp（语雀等 stdio MCP，经本机 bridge mcp-proxy 转成 HTTP）。
 *
 * - 鉴权按 config.authScheme 映射（缺省 'bearer'，兼容旧 profile）：
 *   raw → Authorization: <token 原值>（腾讯文档官方要求，无 Bearer 前缀）；
 *   bearer → Authorization: Bearer <token>；none → 不带鉴权头
 *   （飞书个人 MCP 的凭据内嵌在 URL 路径 https://open.feishu.cn/mcp/stream/mcp_<token>）。
 * - 401 兜底（withAuthFallback）：腾讯文档 token 的鉴权格式存在现实不确定性
 *   （官方示例为裸值，但部分客户端/网关签发习惯是 Bearer）—— raw 遇 401 自动用
 *   bearer 重试一次，bearer 遇 401 对称降级 raw；重试成功则把新 scheme 持久化回
 *   profile（持久化失败静默降级为仅本次生效）；两次都 401 维持原鉴权错误、不写回；
 *   'none'（URL 内嵌凭据）不重试。
 * - local-mcp 端点由 port 构造（http://127.0.0.1:<port>/mcp，bridge token 走 Bearer），
 *   仅此 kind 允许指向本机 —— custom-mcp / remote-mcp 仍走公网 HTTPS SSRF 拦截（§8）。
 * - testConnection：initialize + tools/list，返回服务器名与映射出的能力清单；
 *   Beta 预设的具体能力完全以端点 tools/list 实际返回为准。
 * - upsertCourseNote：按工具名优先级选写入工具（新建时 create* > append* > update*；
 *   已有 externalId 时翻转为 update* > append* > create*，避免重复同步反复新建文档），
 *   参数键名优先按工具 inputSchema 匹配常见变体（content/markdown/text/body、
 *   id/pageId/docId/documentId/noteId），无 schema 时用 content / id 兜底。
 */
import { assertPublicHttpsUrl } from './ssrf';
import {
  createMcpClient,
  mapToolCapabilities,
  McpError,
  type McpClient,
  type McpToolInfo,
} from './mcpClient';
import {
  DEFAULT_LOCAL_MCP_PORT,
  type ConnectorAuthScheme,
  type ConnectorDeps,
  type ConnectorProfile,
  type ConnectorTestResult,
  type KnowledgeConnector,
  type UpsertNoteInput,
  type UpsertNoteResult,
} from './types';

const CONTENT_KEY_CANDIDATES = ['content', 'markdown', 'text', 'body'] as const;
const ID_KEY_CANDIDATES = ['id', 'pageId', 'docId', 'documentId', 'noteId'] as const;

/** 选写入工具：无 externalId 时 create* > append* > update*；有则 update* > append* > create* */
export function pickBestWriteTool(
  tools: McpToolInfo[],
  externalId?: string,
): McpToolInfo | undefined {
  const order = externalId ? ['update', 'append', 'create'] : ['create', 'append', 'update'];
  for (const key of order) {
    const hit = tools.find((t) => t.name.toLowerCase().includes(key));
    if (hit) return hit;
  }
  return undefined;
}

function pickKey(tool: McpToolInfo, candidates: readonly string[]): string | undefined {
  const props = tool.inputSchema?.properties;
  if (!props) return undefined;
  return candidates.find((k) => k in props);
}

function buildToolArgs(tool: McpToolInfo, input: UpsertNoteInput): Record<string, unknown> {
  const title = input.courseTitle + (input.partLabel ? ` · ${input.partLabel}` : '');
  const args: Record<string, unknown> = { title };
  args[pickKey(tool, CONTENT_KEY_CANDIDATES) ?? 'content'] = input.contentMd;
  if (input.externalId) {
    args[pickKey(tool, ID_KEY_CANDIDATES) ?? 'id'] = input.externalId;
  }
  return args;
}

/** 从 tools/call 结果中提取外部文档 id（id/pageId/docId/…，或首条 text 内容里的 JSON） */
export function extractExternalId(result: unknown): string | undefined {
  const fromObj = (obj: Record<string, unknown>): string | undefined => {
    for (const k of ID_KEY_CANDIDATES) {
      const v = obj[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  };
  if (typeof result === 'string' && result) return result;
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const direct = fromObj(r);
  if (direct) return direct;
  const sc = r.structuredContent;
  if (sc && typeof sc === 'object') {
    const hit = fromObj(sc as Record<string, unknown>);
    if (hit) return hit;
  }
  const content = r.content;
  if (Array.isArray(content)) {
    const text = (content[0] as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') return fromObj(parsed);
      } catch {
        /* 非 JSON 文本，放弃提取 */
      }
    }
  }
  return undefined;
}

/** config.authScheme（或显式覆盖 scheme）→ 鉴权头（raw = 原始 token 值；none / 无 token = 不带头；bearer = 旧行为） */
function resolveAuth(
  config: ConnectorProfile['config'],
  schemeOverride?: ConnectorAuthScheme,
): {
  token?: string;
  authHeader?: { name: string; value: string };
} {
  const token = config.token ? String(config.token) : '';
  const scheme =
    schemeOverride ?? (config.authScheme as ConnectorAuthScheme | undefined) ?? 'bearer';
  if (!token || scheme === 'none') return {};
  if (scheme === 'raw') return { authHeader: { name: 'Authorization', value: token } };
  return { token };
}

/** local-mcp：由端口构造本机端点（仅此 kind 允许 127.0.0.1，见文件头注释） */
function localMcpEndpoint(config: ConnectorProfile['config']): string {
  const port = Number(config.port) || DEFAULT_LOCAL_MCP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('local-mcp 端口必须是 1–65535 的整数');
  }
  return `http://127.0.0.1:${port}/mcp`;
}

export interface AuthFallbackContext {
  profile: ConnectorProfile;
  /** 按指定 scheme 构造客户端（raw ↔ bearer 互换重试用） */
  makeClient: (scheme: ConnectorAuthScheme) => McpClient;
  /** 重试成功后持久化新 scheme（注入失败时静默降级为仅本次生效） */
  persist?: (scheme: 'raw' | 'bearer') => Promise<void>;
}

/**
 * 401 鉴权兜底：先按 profile 当前 scheme 调用；遇 401（且 scheme 为 raw/bearer、
 * 有 token）自动互换 scheme 重试一次。重试成功 → 持久化新 scheme 并在返回值里
 * 标注 switchedTo；第二次仍失败（含再次 401）→ 错误原样抛出，不持久化任何变更。
 * persist 缺省时仅本次调用生效（生产路径由 registry.buildConnector 注入默认写回）。
 */
export async function withAuthFallback<T>(
  ctx: AuthFallbackContext,
  call: (client: McpClient) => Promise<T>,
): Promise<{ value: T; switchedTo?: 'raw' | 'bearer' }> {
  const current =
    (ctx.profile.config.authScheme as ConnectorAuthScheme | undefined) ?? 'bearer';
  try {
    return { value: await call(ctx.makeClient(current)) };
  } catch (e) {
    const isAuth = e instanceof McpError && e.kind === 'auth';
    // 'none'（凭据内嵌在 URL）与无 token 的 profile 没有可互换的 scheme，不重试
    if (!isAuth || current === 'none' || !ctx.profile.config.token) throw e;
    const flipped: 'raw' | 'bearer' = current === 'raw' ? 'bearer' : 'raw';
    const value = await call(ctx.makeClient(flipped));
    try {
      await ctx.persist?.(flipped);
    } catch {
      /* 持久化失败不阻断主流程：仅本次调用生效 */
    }
    return { value, switchedTo: flipped };
  }
}

export function createMcpConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const isLocal = profile.kind === 'local-mcp';
  const endpoint = isLocal
    ? localMcpEndpoint(profile.config)
    : String(profile.config.endpoint ?? '');
  // 保存时已校验；构造时复查兜底（SSRF，§8。local-mcp 是本机回环，不走公网校验）
  if (!isLocal) assertPublicHttpsUrl(endpoint);

  const makeClient = (scheme?: ConnectorAuthScheme): McpClient =>
    createMcpClient({
      endpoint,
      ...resolveAuth(profile.config, scheme),
      fetchImpl: deps?.fetchImpl,
    });

  const fallbackCtx: AuthFallbackContext = {
    profile,
    makeClient,
    // persist 缺省时仅本次调用生效；默认 registry 写回由 buildConnector 注入
    persist: deps?.persistAuthScheme
      ? (scheme) => deps.persistAuthScheme!(profile, scheme)
      : undefined,
  };

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const { value, switchedTo } = await withAuthFallback(fallbackCtx, async (client) => {
          const info = await client.initialize();
          const tools = await client.listTools();
          return { info, tools };
        });
        const { info, tools } = value;
        const caps = mapToolCapabilities(tools.map((t) => t.name));
        const name = info.serverName ? `「${info.serverName}」` : '';
        const switchNote =
          switchedTo === 'bearer'
            ? '；已自动切换为 Bearer 鉴权'
            : switchedTo === 'raw'
              ? '；已自动切换为裸值鉴权'
              : '';
        return {
          ok: true,
          detail:
            `已连接${name}，发现 ${tools.length} 个工具` +
            (caps.length > 0 ? `，能力：${caps.join('、')}` : '（未识别到标准能力，将以 Raw Tools 模式尝试写入）') +
            switchNote,
        };
      } catch (e) {
        if (isLocal && e instanceof McpError && e.kind === 'connect') {
          return {
            ok: false,
            detail:
              '无法连接本机 MCP 代理：请先按配置表单的启动指引运行 node scripts/bridge.mjs mcp-proxy …',
          };
        }
        return { ok: false, detail: e instanceof McpError ? e.userMessage : (e as Error).message };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      const { value } = await withAuthFallback(fallbackCtx, async (client) => {
        const tools = await client.listTools();
        const tool = pickBestWriteTool(tools, input.externalId);
        if (!tool) {
          throw new McpError(
            'protocol',
            '端点未提供可用的写入工具（工具名需包含 create / append / update）',
          );
        }
        return client.callTool(tool.name, buildToolArgs(tool, input));
      });
      const externalId =
        extractExternalId(value) ??
        input.externalId ??
        JSON.stringify(value ?? null).slice(0, 200);
      return { externalId, editedAt: Date.now() };
    },
  };
}
