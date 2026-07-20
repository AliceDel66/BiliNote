/** 分析结果 → Markdown（用于「存为笔记」，F-05）。时间戳保持 mm:ss 纯文本。 */
import { formatTimestamp } from '../types';
import type { AnalysisResult, ExtensionItem } from './types';

/** 笔记元信息头（可选；保持单参调用兼容） */
export interface NoteMeta {
  videoTitle: string;
  partLabel?: string;
  owner?: string;
  url?: string;
  generatedAt?: Date;
}

/** YYYY-MM-DD HH:mm（本地时区） */
function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 元信息头：引用块（视频 / UP 主与链接 / 生成时间），字段缺失则省略对应段 */
function metaHeaderLines(meta: NoteMeta): string[] {
  const lines: string[] = [];
  lines.push(`> 视频：${meta.videoTitle}${meta.partLabel ? ` · ${meta.partLabel}` : ''}`);
  const attribution = [
    meta.owner ? `UP 主：${meta.owner}` : '',
    meta.url ? `链接：${meta.url}` : '',
  ]
    .filter(Boolean)
    .join(' ｜ ');
  if (attribution) lines.push(`> ${attribution}`);
  if (meta.generatedAt) lines.push(`> 生成于 ${formatDateTime(meta.generatedAt)}`);
  return lines;
}

function extensionSection(title: string, items: ExtensionItem[]): string[] {
  const lines: string[] = [`## ${title}`, ''];
  for (const e of items) {
    lines.push(`- **${e.title}**：${e.detail}`);
  }
  lines.push('');
  return lines;
}

export function analysisToMarkdown(result: AnalysisResult, meta?: NoteMeta): string {
  const header = meta ? [...metaHeaderLines(meta), ''] : [];

  if (result.rawMarkdown) return [...header, result.rawMarkdown].join('\n').trim() + '\n';

  const lines: string[] = [...header];

  if (result.outline.length > 0) {
    lines.push('## 课程大纲', '');
    for (const o of result.outline) {
      lines.push(`- ${formatTimestamp(o.time)} ${o.title}`);
    }
    lines.push('');
  }

  if (result.sections.length > 0) {
    lines.push('## 分段总结', '');
    for (const s of result.sections) {
      lines.push(
        `### ${s.title}（${formatTimestamp(s.start)} - ${formatTimestamp(s.end)}）`,
        '',
      );
      for (const p of s.points) {
        lines.push(`- ${p}`);
      }
      lines.push('');
    }
  }

  if (result.keyPoints.length > 0) {
    lines.push('## 重点 / 难点', '');
    for (const k of result.keyPoints) {
      const time = k.time !== undefined ? `（${formatTimestamp(k.time)}）` : '';
      lines.push(`- **${k.point}**${time}${k.explanation ? `：${k.explanation}` : ''}`);
    }
    lines.push('');
  }

  // 旧缓存的 AnalysisResult 可能还没有 extensions / caveats 字段，这里做防御性判断
  if (result.extensions && result.extensions.length > 0) {
    lines.push(...extensionSection('拓展知识', result.extensions));
  }

  if (result.caveats && result.caveats.length > 0) {
    lines.push(...extensionSection('注意事项', result.caveats));
  }

  return lines.join('\n').trim() + '\n';
}
