/** 分析结果 → Markdown（用于「存为笔记」，F-05）。时间戳保持 mm:ss 纯文本。 */
import { formatTimestamp } from '../types';
import type { AnalysisResult } from './types';

export function analysisToMarkdown(result: AnalysisResult): string {
  if (result.rawMarkdown) return result.rawMarkdown;

  const lines: string[] = [];

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

  return lines.join('\n').trim() + '\n';
}
