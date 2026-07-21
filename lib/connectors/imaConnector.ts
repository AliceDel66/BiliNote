/**
 * ima OpenAPI 知识库连接器（Beta）。
 *
 * 官方 API 当前提供：Markdown 笔记新建、追加、读取，以及把笔记加入知识库；
 * 没有整篇覆盖接口。因此同步采用 append-only 保护：externalId 保存上次完整内容的
 * 长度 + SHA-256，只有新内容以前次内容为前缀时才追加差量；历史内容被改写时拒绝
 * 同步，避免重复建文档或把整篇内容再次追加。
 *
 * 凭据只作为请求头发送给 https://ima.qq.com，并由 Connector Profile 存入
 * chrome.storage.local；不进入同步域、错误信息或日志。
 */
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  ConnectorDeps,
  ConnectorProfile,
  ConnectorTestResult,
  KnowledgeConnector,
  UpsertNoteInput,
  UpsertNoteResult,
} from './types';

export const IMA_API_ORIGIN = 'https://ima.qq.com';

export interface ImaKnowledgeBase {
  id: string;
  name: string;
}

interface ImaConfig {
  clientId: string;
  apiKey: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
}

interface ImaEnvelope<T> {
  retcode?: number;
  code?: number;
  errmsg?: string;
  message?: string;
  data?: T;
}

interface ImaExternalRef {
  v: 1;
  docId: string;
  knowledgeBaseId: string;
  contentLength: number;
  contentHash: string;
}

export type ImaErrorKind = 'config' | 'connect' | 'auth' | 'http' | 'api' | 'protocol';

export class ImaError extends Error {
  constructor(
    readonly kind: ImaErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ImaError';
  }

  get userMessage(): string {
    switch (this.kind) {
      case 'config':
        return this.message;
      case 'auth':
        return 'ima OpenAPI 鉴权失败，请检查 Client ID 与 API Key 是否有效';
      case 'connect':
        return `无法连接 ima OpenAPI：${this.message}`;
      case 'http':
        return `ima OpenAPI 返回 HTTP ${this.status ?? '?'}：${this.message}`;
      case 'protocol':
        return `ima OpenAPI 响应格式异常：${this.message}`;
      default:
        return `ima OpenAPI 返回错误：${this.message}`;
    }
  }
}

function configOf(profile: ConnectorProfile): ImaConfig {
  const config: ImaConfig = {
    clientId: String(profile.config.clientId ?? '').trim(),
    apiKey: String(profile.config.apiKey ?? '').trim(),
    knowledgeBaseId: String(profile.config.knowledgeBaseId ?? '').trim(),
    knowledgeBaseName: String(profile.config.knowledgeBaseName ?? '').trim(),
  };
  if (!config.clientId || !config.apiKey) {
    throw new ImaError('config', '请填写 ima OpenAPI Client ID 与 API Key');
  }
  return config;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function contentHash(content: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(content)));
}

function encodeExternalRef(
  docId: string,
  knowledgeBaseId: string,
  content: string,
): string {
  const ref: ImaExternalRef = {
    v: 1,
    docId,
    knowledgeBaseId,
    contentLength: content.length,
    contentHash: contentHash(content),
  };
  return JSON.stringify(ref);
}

function parseExternalRef(raw: string): ImaExternalRef | null {
  try {
    const value = JSON.parse(raw) as Partial<ImaExternalRef>;
    if (
      value.v !== 1 ||
      typeof value.docId !== 'string' ||
      !value.docId ||
      typeof value.knowledgeBaseId !== 'string' ||
      typeof value.contentLength !== 'number' ||
      !Number.isInteger(value.contentLength) ||
      value.contentLength < 0 ||
      typeof value.contentHash !== 'string' ||
      !value.contentHash
    ) {
      return null;
    }
    return value as ImaExternalRef;
  } catch {
    return null;
  }
}

function isAuthCode(code: number): boolean {
  return code === 20004 || code === 200002 || code === 200004;
}

function createImaRequester(config: Pick<ImaConfig, 'clientId' | 'apiKey'>, deps?: ConnectorDeps) {
  const f = deps?.fetchImpl ?? globalThis.fetch;
  if (!f) throw new ImaError('connect', '当前环境无可用 fetch');

  return async function request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await f(`${IMA_API_ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ima-openapi-clientid': config.clientId,
          'ima-openapi-apikey': config.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ImaError('connect', (e as Error).message ?? String(e));
    }

    if (response.status === 401 || response.status === 403) {
      throw new ImaError('auth', `HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      throw new ImaError('http', response.statusText || '请求失败', response.status);
    }

    let envelope: ImaEnvelope<T>;
    try {
      envelope = (await response.json()) as ImaEnvelope<T>;
    } catch {
      throw new ImaError('protocol', '响应不是 JSON');
    }
    const code = envelope.retcode ?? envelope.code;
    if (typeof code !== 'number') {
      throw new ImaError('protocol', '缺少 retcode');
    }
    if (code !== 0) {
      const message = envelope.errmsg || envelope.message || `retcode=${code}`;
      throw new ImaError(isAuthCode(code) ? 'auth' : 'api', message);
    }
    if (envelope.data === undefined) {
      throw new ImaError('protocol', '缺少 data');
    }
    return envelope.data;
  };
}

/** 配置表单用：列出当前凭据可写入的全部 ima 知识库。 */
export async function listImaKnowledgeBases(
  credentials: { clientId: string; apiKey: string },
  deps?: ConnectorDeps,
): Promise<ImaKnowledgeBase[]> {
  const clientId = credentials.clientId.trim();
  const apiKey = credentials.apiKey.trim();
  if (!clientId || !apiKey) {
    throw new ImaError('config', '请先填写 ima OpenAPI Client ID 与 API Key');
  }
  const request = createImaRequester({ clientId, apiKey }, deps);
  const out: ImaKnowledgeBase[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const data = await request<{
      addable_knowledge_base_list?: { id?: unknown; name?: unknown }[];
      next_cursor?: unknown;
      is_end?: unknown;
    }>('/openapi/wiki/v1/get_addable_knowledge_base_list', { cursor, limit: 50 });
    for (const item of data.addable_knowledge_base_list ?? []) {
      if (typeof item.id === 'string' && item.id && typeof item.name === 'string') {
        out.push({ id: item.id, name: item.name || '未命名知识库' });
      }
    }
    if (data.is_end === true) break;
    const next = typeof data.next_cursor === 'string' ? data.next_cursor : '';
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

export function createImaConnector(
  profile: ConnectorProfile,
  deps?: ConnectorDeps,
): KnowledgeConnector {
  const config = configOf(profile);
  const request = createImaRequester(config, deps);

  return {
    profile,

    async testConnection(): Promise<ConnectorTestResult> {
      try {
        const knowledgeBases = await listImaKnowledgeBases(config, deps);
        if (!config.knowledgeBaseId) {
          return {
            ok: false,
            detail: `凭据有效，发现 ${knowledgeBases.length} 个可写知识库；请先选择写入目标`,
          };
        }
        const selected = knowledgeBases.find((item) => item.id === config.knowledgeBaseId);
        if (!selected) {
          return {
            ok: false,
            detail: '凭据有效，但当前账号已无权写入所选 ima 知识库，请重新选择',
          };
        }
        return { ok: true, detail: `已连接 ima，可写入「${selected.name}」` };
      } catch (e) {
        return {
          ok: false,
          detail: e instanceof ImaError ? e.userMessage : (e as Error).message,
        };
      }
    },

    async upsertCourseNote(input: UpsertNoteInput): Promise<UpsertNoteResult> {
      if (!config.knowledgeBaseId) {
        throw new ImaError('config', '请先在设置页选择 ima 目标知识库');
      }

      const existing = input.externalId ? parseExternalRef(input.externalId) : null;
      // 用户修改了 profile 的目标知识库：在新目标创建新笔记，旧目标内容保持不动。
      if (!existing || existing.knowledgeBaseId !== config.knowledgeBaseId) {
        const imported = await request<{ doc_id?: unknown }>('/openapi/note/v1/import_doc', {
          content_format: 1,
          content: input.contentMd,
        });
        const docId = typeof imported.doc_id === 'string' ? imported.doc_id : '';
        if (!docId) throw new ImaError('protocol', 'import_doc 未返回 doc_id');

        const title = input.courseTitle + (input.partLabel ? ` · ${input.partLabel}` : '');
        await request('/openapi/wiki/v1/add_knowledge', {
          media_type: 11,
          title,
          knowledge_base_id: config.knowledgeBaseId,
          note_info: { content_id: docId },
        });
        return {
          externalId: encodeExternalRef(docId, config.knowledgeBaseId, input.contentMd),
          editedAt: Date.now(),
        };
      }

      const prefix = input.contentMd.slice(0, existing.contentLength);
      if (
        input.contentMd.length < existing.contentLength ||
        contentHash(prefix) !== existing.contentHash
      ) {
        throw new ImaError(
          'api',
          '官方 OpenAPI 暂不支持整篇覆盖；检测到已同步段落被改写。请在 ima 中保留旧笔记，并在 BiliNote 移除后重新添加该连接以创建新版笔记',
        );
      }

      const delta = input.contentMd.slice(existing.contentLength);
      if (delta) {
        await request('/openapi/note/v1/append_doc', {
          doc_id: existing.docId,
          content_format: 1,
          content: delta,
        });
      }
      return {
        externalId: encodeExternalRef(existing.docId, config.knowledgeBaseId, input.contentMd),
        editedAt: Date.now(),
      };
    },
  };
}
