/**
 * 远程 MCP 连接器：覆盖 remote-mcp（腾讯文档 Beta 预设）与 custom-mcp（自定义端点）。
 *
 * - testConnection：initialize + tools/list，返回服务器名与映射出的能力清单；
 *   腾讯文档预设为 Beta 质量 —— 具体能力完全以端点 tools/list 实际返回为准。
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
import type {
  ConnectorDeps,
  ConnectorProfile,
  ConnectorTestResult,
  KnowledgeConnector,
  UpsertNoteInput,
  UpsertNoteResult,
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

export function createMcpConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const endpoint = String(profile.config.endpoint ?? '');
  const token = profile.config.token ? String(profile.config.token) : undefined;
  // 保存时已校验；构造时复查兜底（SSRF，§8）
  assertPublicHttpsUrl(endpoint);

  const client: McpClient = createMcpClient({ endpoint, token, fetchImpl: deps?.fetchImpl });

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const info = await client.initialize();
        const tools = await client.listTools();
        const caps = mapToolCapabilities(tools.map((t) => t.name));
        const name = info.serverName ? `「${info.serverName}」` : '';
        return {
          ok: true,
          detail:
            `已连接${name}，发现 ${tools.length} 个工具` +
            (caps.length > 0 ? `，能力：${caps.join('、')}` : '（未识别到标准能力，将以 Raw Tools 模式尝试写入）'),
        };
      } catch (e) {
        return { ok: false, detail: e instanceof McpError ? e.userMessage : (e as Error).message };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      const tools = await client.listTools();
      const tool = pickBestWriteTool(tools, input.externalId);
      if (!tool) {
        throw new McpError(
          'protocol',
          '端点未提供可用的写入工具（工具名需包含 create / append / update）',
        );
      }
      const result = await client.callTool(tool.name, buildToolArgs(tool, input));
      const externalId =
        extractExternalId(result) ??
        input.externalId ??
        JSON.stringify(result ?? null).slice(0, 200);
      return { externalId, editedAt: Date.now() };
    },
  };
}
