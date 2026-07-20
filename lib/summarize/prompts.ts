/** Prompt 模板（版本化，见 PRD 6.4） */
import type { Cue } from '../bilibili/types';
import type { DanmakuItem } from '../bilibili/danmaku';
import { formatTimestamp } from '../types';
import type { CueChunk } from './chunk';

export function cuesToTranscript(cues: Cue[]): string {
  return cues.map((c) => `[${formatTimestamp(c.start)}] ${c.text}`).join('\n');
}

/** Map 阶段：单块要点提取 */
export function mapPrompt(
  videoTitle: string,
  partTitle: string,
  chunk: CueChunk,
): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content:
        '你是课程内容分析助手。基于给定的视频字幕片段，提取 3-6 条要点（bullet），每条一句话，紧扣字幕内容，禁止编造字幕中不存在的信息。只输出要点列表（每行一条，以 "- " 开头），不要输出其他内容。',
    },
    {
      role: 'user',
      content: `视频标题：《${videoTitle}》${partTitle ? `\n分P标题：${partTitle}` : ''}
片段时间范围：${formatTimestamp(chunk.start)} - ${formatTimestamp(chunk.end)}
字幕（每行带时间戳）：
${cuesToTranscript(chunk.cues)}`,
    },
  ];
}

export const REDUCE_SCHEMA_HINT = `{
  "outline": [{ "title": "章节标题", "time": "mm:ss" }],
  "sections": [{ "title": "小节标题", "start": "mm:ss", "end": "mm:ss", "points": ["要点1", "要点2"] }],
  "keyPoints": [{ "point": "知识点/难点", "explanation": "面向初学者的讲解", "time": "mm:ss" }]
}`;

/** Reduce 阶段：合并块摘要为全局大纲与分段总结 */
export function reducePrompt(
  videoTitle: string,
  partTitle: string,
  durationSeconds: number,
  chunkSummaries: string[],
  /** 可选：弹幕采样（F-02），作为「弹幕高光」辅助上下文 */
  danmaku?: DanmakuItem[],
): { role: 'system' | 'user'; content: string }[] {
  const danmakuSection =
    danmaku && danmaku.length > 0
      ? `\n弹幕高光（观众互动较多的片段，仅供定位重点参考，不要当作字幕内容引用）：\n${danmaku
          .map((d) => `[${formatTimestamp(d.t)}] ${d.text}`)
          .join('\n')}`
      : '';
  return [
    {
      role: 'system',
      content: `你是课程结构分析助手。基于各片段要点，生成整节课程的结构化笔记。
要求：
1. 严格输出 JSON（不要 markdown 代码块围栏），Schema 如下：
${REDUCE_SCHEMA_HINT}
2. 时间戳一律使用 mm:ss（超过 1 小时用 h:mm:ss），且必须在 00:00 到 ${formatTimestamp(durationSeconds)} 之间
3. outline 3-8 条，sections 3-8 段（每段 3-5 条要点），keyPoints 2-6 条
4. 禁止编造内容中没有出现的知识点`,
    },
    {
      role: 'user',
      content: `视频标题：《${videoTitle}》${partTitle ? `\n分P标题：${partTitle}` : ''}
视频总时长：${formatTimestamp(durationSeconds)}
各片段要点（按时间顺序）：
${chunkSummaries.map((s, i) => `【片段 ${i + 1}】\n${s}`).join('\n\n')}${danmakuSection}`,
    },
  ];
}

/** JSON 修复重试 */
export function repairPrompt(badOutput: string): {
  role: 'system' | 'user';
  content: string;
}[] {
  return [
    {
      role: 'system',
      content: `你是 JSON 修复助手。把用户给出的文本修复为合法 JSON，Schema 如下，只输出 JSON 本身：
${REDUCE_SCHEMA_HINT}`,
    },
    { role: 'user', content: badOutput.slice(0, 6000) },
  ];
}
