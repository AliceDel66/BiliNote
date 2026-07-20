/**
 * Markdown 预览（笔记编辑器用）：
 * - marked 渲染 → DOMPurify 严格消毒（防 XSS，PRD 5 安全要求）
 * - 文本中的时间戳（mm:ss / h:mm:ss）预渲染为 #seek-<秒> 锚点，
 *   点击触发播放器跳转；代码围栏内不做替换
 * - 外部链接强制 target=_blank rel=noopener
 */
import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { parseTimestamp } from '../lib/types';

const TS_RE = /(?<!\d)(?:(?:\d+):)?[0-5]?\d:[0-5]\d(?!\d)/g;

/** 把非代码块文本里的时间戳替换为 markdown 锚点链接 */
export function linkifyTimestamps(md: string): string {
  const segments = md.split(/(```[\s\S]*?(?:```|$))/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // 代码围栏段原样保留
      return seg.replace(TS_RE, (m) => {
        const seconds = parseTimestamp(m);
        return seconds === null ? m : `[${m}](#seek-${seconds})`;
      });
    })
    .join('');
}

let hookReady = false;
function ensureSanitizeHook(): void {
  if (hookReady) return;
  hookReady = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^https?:/i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

export default function MarkdownPreview(props: {
  markdown: string;
  onSeek: (seconds: number) => void;
}) {
  const html = useMemo(() => {
    ensureSanitizeHook();
    const rendered = marked.parse(linkifyTimestamps(props.markdown), {
      async: false,
      gfm: true,
      breaks: true,
    }) as string;
    return DOMPurify.sanitize(rendered);
  }, [props.markdown]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (!anchor) return;
    const m = /^#seek-(\d+)$/.exec(anchor.getAttribute('href') ?? '');
    if (m) {
      e.preventDefault();
      props.onSeek(Number(m[1]));
    }
  };

  return (
    // eslint-disable-next-line react/no-danger -- 已经 DOMPurify 消毒
    <div
      className="markdown-preview text-[13px] leading-relaxed text-ink-2 dark:text-ink-2-dark"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
