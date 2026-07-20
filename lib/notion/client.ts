/**
 * Notion API 客户端（内部集成令牌，Notion-Version: 2022-06-28）。
 * 纯 TS（fetch / sleep 可注入），无浏览器依赖，可单测。
 *
 * 限流策略（PRD F-07 / 6.5）：
 * - 所有请求经同一队列串行发出，相邻请求间隔 ≥ minIntervalMs（默认 300ms）
 * - HTTP 429：优先按 Retry-After 头等待，否则指数退避（1s / 2s / 4s），最多重试 3 次
 */
import { NOTION_TEXT_LIMIT, type NotionBlock } from './markdown';

export { NOTION_TEXT_LIMIT };

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_RETRIES = 3;
/** 单次 append children 的 block 上限 */
export const NOTION_APPEND_BATCH = 100;

export type NotionErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'network'
  | 'http'
  | 'bad_response';

export class NotionError extends Error {
  constructor(
    readonly kind: NotionErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'NotionError';
  }

  /** 面向用户的可操作提示（中文） */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'Notion 令牌无效（401），请在设置页重新粘贴内部集成令牌';
      case 'forbidden':
        return '页面未共享给集成（403），请在 Notion 中将目标页面「共享」给你的集成';
      case 'not_found':
        return 'Notion 页面不存在或已被删除（404），请重新选择同步根页面';
      case 'rate_limit':
        return 'Notion 接口限流（429），已自动重试仍失败，请稍后再试';
      case 'network':
        return `网络错误：${this.message}，请检查网络连接`;
      case 'http':
        return `Notion 接口返回 HTTP ${this.status}：${this.message}`;
      default:
        return `Notion 响应解析失败：${this.message}`;
    }
  }
}

function httpError(status: number, body: string): NotionError {
  const short = body.slice(0, 200);
  if (status === 401) return new NotionError('auth', short, status);
  if (status === 403) return new NotionError('forbidden', short, status);
  if (status === 404) return new NotionError('not_found', short, status);
  if (status === 429) return new NotionError('rate_limit', short, status);
  return new NotionError('http', short, status);
}

// ---------- 公开类型 ----------

export interface NotionPageSummary {
  id: string;
  title: string;
  url: string;
  lastEditedTime: string;
}

export interface NotionBotInfo {
  id: string;
  botName: string;
  workspaceName?: string;
}

export interface NotionClientOptions {
  token: string;
  /** 测试注入用 */
  fetchImpl?: typeof fetch;
  /** 测试注入用（默认 setTimeout 实现） */
  sleep?: (ms: number) => Promise<void>;
  /** 请求最小间隔，默认 300ms；测试可设 0 */
  minIntervalMs?: number;
}

export interface NotionClient {
  /** GET /users/me：校验令牌，返回集成（bot）信息 */
  validateToken(): Promise<NotionBotInfo>;
  /** POST /search：按标题搜索页面（仅 page，最多 10 条） */
  searchPages(query: string): Promise<NotionPageSummary[]>;
  /** GET /pages/{id}：取页面（主要用 last_edited_time 做冲突检测） */
  getPage(pageId: string): Promise<{ id: string; lastEditedTime: string }>;
  /** POST /pages：在指定页面下创建子页面 */
  createPage(params: { parentPageId: string; title: string }): Promise<{ id: string }>;
  /** GET /blocks/{id}/children：列出全部子块（自动翻页） */
  listChildren(blockId: string): Promise<{ id: string }[]>;
  /** DELETE /blocks/{id}：归档（删除）块 */
  archiveBlock(blockId: string): Promise<void>;
  /** PATCH /blocks/{id}/children：追加块，超过 100 个自动分批 */
  appendBlocks(pageId: string, blocks: NotionBlock[]): Promise<void>;
}

// ---------- Notion 响应的松散结构 ----------

interface NotionRichTextItem {
  plain_text?: string;
}

interface NotionPageRaw {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<
    string,
    { type?: string; title?: NotionRichTextItem[] } | undefined
  >;
}

function pageTitle(page: NotionPageRaw): string {
  for (const prop of Object.values(page.properties ?? {})) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('');
    }
  }
  return '';
}

function toPageSummary(page: NotionPageRaw): NotionPageSummary {
  return {
    id: page.id ?? '',
    title: pageTitle(page),
    url: page.url ?? '',
    lastEditedTime: page.last_edited_time ?? '',
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createNotionClient(opts: NotionClientOptions): NotionClient {
  const f = opts.fetchImpl ?? globalThis.fetch;
  if (!f) throw new NotionError('network', '当前环境无可用 fetch');
  const sleep = opts.sleep ?? defaultSleep;
  const minInterval = opts.minIntervalMs ?? 300;

  // ---- 请求串行化 + 最小间隔 ----
  let chain: Promise<void> = Promise.resolve();
  let lastAt = 0;
  function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const wait = minInterval - (Date.now() - lastAt);
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      return fn();
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function rawRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    try {
      return await f(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new NotionError('network', (e as Error).message);
    }
  }

  /** 单请求（含 429 重试），经串行队列发出 */
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return schedule(async () => {
      let attempt = 0;
      for (;;) {
        const resp = await rawRequest(method, path, body);
        if (resp.status === 429 && attempt < MAX_RETRIES) {
          attempt++;
          const retryAfter = Number(resp.headers.get('Retry-After') ?? '');
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** (attempt - 1) * 1000; // 1s / 2s / 4s
          await sleep(waitMs);
          continue;
        }
        if (!resp.ok) {
          let text = '';
          try {
            text = await resp.text();
          } catch {
            /* ignore */
          }
          throw httpError(resp.status, text);
        }
        if (resp.status === 204 || method === 'DELETE') {
          return undefined as T;
        }
        try {
          return (await resp.json()) as T;
        } catch (e) {
          throw new NotionError('bad_response', (e as Error).message, resp.status);
        }
      }
    });
  }

  return {
    async validateToken() {
      interface UsersMeResp {
        id?: string;
        type?: string;
        name?: string;
        bot?: { workspace_name?: string };
      }
      const json = await request<UsersMeResp>('GET', '/users/me');
      return {
        id: json.id ?? '',
        botName: json.name ?? '',
        workspaceName: json.bot?.workspace_name,
      };
    },

    async searchPages(query: string) {
      interface SearchResp {
        results?: NotionPageRaw[];
      }
      const json = await request<SearchResp>('POST', '/search', {
        query,
        filter: { property: 'object', value: 'page' },
        page_size: 10,
      });
      return (json.results ?? []).map(toPageSummary).filter((p) => p.id);
    },

    async getPage(pageId: string) {
      const json = await request<NotionPageRaw>(
        'GET',
        `/pages/${encodeURIComponent(pageId)}`,
      );
      return { id: json.id ?? pageId, lastEditedTime: json.last_edited_time ?? '' };
    },

    async createPage({ parentPageId, title }) {
      const json = await request<NotionPageRaw>('POST', '/pages', {
        parent: { page_id: parentPageId },
        properties: {
          title: [
            { type: 'text', text: { content: title.slice(0, NOTION_TEXT_LIMIT) } },
          ],
        },
      });
      if (!json.id) throw new NotionError('bad_response', '创建页面未返回 id');
      return { id: json.id };
    },

    async listChildren(blockId: string) {
      interface ChildrenResp {
        results?: { id?: string }[];
        has_more?: boolean;
        next_cursor?: string | null;
      }
      const out: { id: string }[] = [];
      let cursor: string | undefined;
      for (;;) {
        const qs = new URLSearchParams({ page_size: '100' });
        if (cursor) qs.set('start_cursor', cursor);
        const json = await request<ChildrenResp>(
          'GET',
          `/blocks/${encodeURIComponent(blockId)}/children?${qs}`,
        );
        for (const b of json.results ?? []) {
          if (b.id) out.push({ id: b.id });
        }
        if (!json.has_more || !json.next_cursor) break;
        cursor = json.next_cursor;
      }
      return out;
    },

    async archiveBlock(blockId: string) {
      await request<undefined>('DELETE', `/blocks/${encodeURIComponent(blockId)}`);
    },

    async appendBlocks(pageId: string, blocks: NotionBlock[]) {
      for (let i = 0; i < blocks.length; i += NOTION_APPEND_BATCH) {
        const batch = blocks.slice(i, i + NOTION_APPEND_BATCH);
        // 注意：追加子块是 PATCH（Notion 对该路径未定义 POST，
        // 用 POST 会返回 400 invalid_request_url）
        await request<unknown>(
          'PATCH',
          `/blocks/${encodeURIComponent(pageId)}/children`,
          { children: batch },
        );
      }
    },
  };
}
