/** LLM 层统一错误类型 */
export type LLMErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'http'
  | 'aborted'
  | 'bad_response';

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }

  /** 面向用户的可操作提示（中文） */
  get userMessage(): string {
    switch (this.kind) {
      case 'auth':
        return 'API Key 无效或已过期（401），请检查设置页中的密钥';
      case 'rate_limit':
        return '模型限流（429），请稍后重试或切换其他模型配置';
      case 'timeout':
        return '请求超时，请检查网络或稍后重试';
      case 'aborted':
        return '已取消';
      case 'network':
        return `网络错误：${this.message}，请检查 baseURL 与网络连接`;
      case 'http':
        return `模型服务返回 HTTP ${this.status}：${this.message}`;
      default:
        return `响应解析失败：${this.message}`;
    }
  }
}

export function httpError(status: number, body: string): LLMError {
  const short = body.slice(0, 200);
  if (status === 401 || status === 403) return new LLMError('auth', short, status);
  if (status === 429) return new LLMError('rate_limit', short, status);
  if (status === 408 || status === 504) return new LLMError('timeout', short, status);
  return new LLMError('http', short, status);
}
