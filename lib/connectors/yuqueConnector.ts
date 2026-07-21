/**
 * 语雀官方 OpenAPI 连接器（Beta）。
 *
 * 扩展后台直接请求语雀 API，不依赖本机 stdio MCP / Local Bridge。首次同步在用户选择的
 * 知识库创建 Markdown 文档；后续正文经 YFM API 整篇覆盖，标题变化则另走 metadata API。
 * Token 仅作为 X-Auth-Token 发往用户确认的 *.yuque.com 精确 origin。
 */
import type {
  ConnectorDeps,
  ConnectorProfile,
  ConnectorTestResult,
  KnowledgeConnector,
  UpsertNoteInput,
  UpsertNoteResult,
} from './types';

export const YUQUE_DEFAULT_HOST = 'https://www.yuque.com';
const YUQUE_REQUEST_TIMEOUT_MS = 15_000;
const YUQUE_PAGE_SIZE = 100;
const YUQUE_MAX_PAGES = 20;

export interface YuqueKnowledgeBase {
  id: string;
  name: string;
  namespace?: string;
}

interface YuqueConfig {
  token: string;
  host: string;
  repoId: string;
  repoName: string;
}

interface YuqueExternalRef {
  v: 1;
  docId: number;
  repoId: string;
  host: string;
  title: string;
}

interface YuqueEnvelope<T> {
  data?: T;
  message?: unknown;
  error?: unknown;
}

export type YuqueErrorKind =
  | 'config'
  | 'connect'
  | 'auth'
  | 'rate'
  | 'http'
  | 'api'
  | 'protocol';

export class YuqueError extends Error {
  constructor(
    readonly kind: YuqueErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'YuqueError';
  }

  get userMessage(): string {
    switch (this.kind) {
      case 'config':
        return this.message;
      case 'auth':
        return '语雀 OpenAPI 鉴权失败，请检查 API Token、空间 Host 与知识库权限';
      case 'rate':
        return '语雀 OpenAPI 请求过于频繁（429），请稍后重试';
      case 'connect':
        return `无法连接语雀 OpenAPI：${this.message}`;
      case 'http':
        return `语雀 OpenAPI 返回 HTTP ${this.status ?? '?'}：${this.message}`;
      case 'protocol':
        return `语雀 OpenAPI 响应格式异常：${this.message}`;
      default:
        return `语雀 OpenAPI 返回错误：${this.message}`;
    }
  }
}

/** 只允许语雀官方云域名；路径统一剥离，API 路径由连接器固定拼接。 */
export function normalizeYuqueHost(raw: string): string {
  const value = raw.trim() || YUQUE_DEFAULT_HOST;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new YuqueError('config', '语雀 Host 必须是合法 HTTPS URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:') {
    throw new YuqueError('config', '语雀 Host 仅允许 HTTPS');
  }
  if (url.username || url.password) {
    throw new YuqueError('config', '语雀 Host 不允许包含用户名或密码');
  }
  if (hostname !== 'yuque.com' && !hostname.endsWith('.yuque.com')) {
    throw new YuqueError('config', '语雀官方连接仅允许 yuque.com 域名');
  }
  return url.origin;
}

function configOf(profile: ConnectorProfile): YuqueConfig {
  const config: YuqueConfig = {
    token: String(profile.config.token ?? '').trim(),
    host: normalizeYuqueHost(String(profile.config.host ?? YUQUE_DEFAULT_HOST)),
    repoId: String(profile.config.repoId ?? '').trim(),
    repoName: String(profile.config.repoName ?? '').trim(),
  };
  if (!config.token) throw new YuqueError('config', '请填写语雀 API Token');
  return config;
}

function safeServerMessage(value: unknown, token: string): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, 200);
  return token ? trimmed.replaceAll(token, '[redacted]') : trimmed;
}

function createYuqueRequester(
  config: Pick<YuqueConfig, 'token' | 'host'>,
  deps?: ConnectorDeps,
) {
  const f = deps?.fetchImpl ?? globalThis.fetch;
  if (!f) throw new YuqueError('connect', '当前环境无可用 fetch');
  const base = `${config.host}/api/v2`;

  return async function request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: Record<string, unknown> | string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), YUQUE_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await f(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': config.token,
        },
        ...(body !== undefined
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw new YuqueError('connect', '请求超时（15s）');
      throw new YuqueError('connect', (e as Error).message ?? String(e));
    } finally {
      clearTimeout(timer);
    }

    let envelope: YuqueEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as YuqueEnvelope<T>;
    } catch {
      /* 非 JSON 错误体只暴露 HTTP 状态，不回显可能含敏感信息的正文。 */
    }

    if (response.status === 401 || response.status === 403) {
      throw new YuqueError('auth', `HTTP ${response.status}`, response.status);
    }
    if (response.status === 429) {
      throw new YuqueError('rate', 'HTTP 429', response.status);
    }
    if (!response.ok) {
      const message =
        safeServerMessage(envelope?.message, config.token) ||
        safeServerMessage(envelope?.error, config.token) ||
        response.statusText ||
        '请求失败';
      throw new YuqueError('http', message, response.status);
    }
    if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      const message = safeServerMessage(envelope?.message, config.token);
      throw new YuqueError(message ? 'api' : 'protocol', message || '缺少 data');
    }
    return envelope.data as T;
  };
}

/** 配置表单用：验证 Token，并列出当前账号可见知识库。 */
export async function listYuqueKnowledgeBases(
  credentials: { token: string; host?: string },
  deps?: ConnectorDeps,
): Promise<YuqueKnowledgeBase[]> {
  const token = credentials.token.trim();
  if (!token) throw new YuqueError('config', '请先填写语雀 API Token');
  const host = normalizeYuqueHost(credentials.host ?? YUQUE_DEFAULT_HOST);
  const request = createYuqueRequester({ token, host }, deps);
  const user = await request<{ login?: unknown }>('GET', '/user');
  const login = typeof user.login === 'string' ? user.login.trim() : '';
  if (!login) throw new YuqueError('protocol', '用户信息缺少 login');

  const out: YuqueKnowledgeBase[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < YUQUE_MAX_PAGES; page++) {
    const offset = page * YUQUE_PAGE_SIZE;
    const repos = await request<unknown>(
      'GET',
      `/users/${encodeURIComponent(login)}/repos?limit=${YUQUE_PAGE_SIZE}&offset=${offset}`,
    );
    if (!Array.isArray(repos)) throw new YuqueError('protocol', '知识库列表不是数组');
    for (const raw of repos) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const id =
        typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: typeof item.name === 'string' && item.name ? item.name : '未命名知识库',
        ...(typeof item.namespace === 'string' && item.namespace
          ? { namespace: item.namespace }
          : {}),
      });
    }
    if (repos.length < YUQUE_PAGE_SIZE) break;
  }
  return out;
}

function titleOf(input: UpsertNoteInput): string {
  return input.courseTitle + (input.partLabel ? ` · ${input.partLabel}` : '');
}

function encodeExternalRef(ref: YuqueExternalRef): string {
  return JSON.stringify(ref);
}

function parseExternalRef(raw: string): YuqueExternalRef | null {
  try {
    const value = JSON.parse(raw) as Partial<YuqueExternalRef>;
    if (
      value.v !== 1 ||
      typeof value.docId !== 'number' ||
      !Number.isSafeInteger(value.docId) ||
      value.docId <= 0 ||
      typeof value.repoId !== 'string' ||
      !value.repoId ||
      typeof value.host !== 'string' ||
      !value.host ||
      typeof value.title !== 'string'
    ) {
      return null;
    }
    return value as YuqueExternalRef;
  } catch {
    return null;
  }
}

export function createYuqueConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const config = configOf(profile);
  const request = createYuqueRequester(config, deps);

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const repos = await listYuqueKnowledgeBases(config, deps);
        if (!config.repoId) {
          return {
            ok: false,
            detail: `Token 有效，发现 ${repos.length} 个知识库；请先选择写入目标`,
          };
        }
        const selected = repos.find((item) => item.id === config.repoId);
        if (!selected) {
          return {
            ok: false,
            detail: 'Token 有效，但当前账号已无法访问所选语雀知识库，请重新选择',
          };
        }
        return { ok: true, detail: `已连接语雀，可写入「${selected.name}」` };
      } catch (e) {
        return {
          ok: false,
          detail: e instanceof YuqueError ? e.userMessage : (e as Error).message,
        };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      if (!config.repoId) throw new YuqueError('config', '请先在设置页选择语雀目标知识库');
      const title = titleOf(input);
      const existing = input.externalId ? parseExternalRef(input.externalId) : null;
      const sameTarget =
        existing && existing.repoId === config.repoId && existing.host === config.host;

      if (!sameTarget) {
        const doc = await request<{ id?: unknown; url?: unknown }>(
          'POST',
          `/repos/${encodeURIComponent(config.repoId)}/docs`,
          { title, body: input.contentMd, format: 'markdown', public: 0 },
        );
        const docId = typeof doc.id === 'number' ? doc.id : Number(doc.id);
        if (!Number.isSafeInteger(docId) || docId <= 0) {
          throw new YuqueError('protocol', '创建文档未返回有效 id');
        }

        // 文档已创建后，TOC 失败不能把整个同步标成失败，否则下次会重复建文档。
        try {
          await request(
            'PUT',
            `/repos/${encodeURIComponent(config.repoId)}/toc`,
            JSON.stringify({
              action: 'appendNode',
              action_mode: 'child',
              target_uuid: '',
              type: 'DOC',
              doc_id: docId,
            }),
          );
        } catch {
          /* best-effort：用户可在语雀目录中手动编排已创建文档。 */
        }

        return {
          externalId: encodeExternalRef({
            v: 1,
            docId,
            repoId: config.repoId,
            host: config.host,
            title,
          }),
          ...(typeof doc.url === 'string' && /^https:\/\//.test(doc.url)
            ? { externalUrl: doc.url }
            : {}),
          editedAt: Date.now(),
        };
      }

      await request('PUT', '/yfm/docs', {
        doc_id: existing.docId,
        yfm: input.contentMd,
      });
      if (existing.title !== title) {
        await request(
          'PUT',
          `/repos/${encodeURIComponent(config.repoId)}/docs/${existing.docId}`,
          { title },
        );
      }
      return {
        externalId: encodeExternalRef({ ...existing, title }),
        editedAt: Date.now(),
      };
    },
  };
}
