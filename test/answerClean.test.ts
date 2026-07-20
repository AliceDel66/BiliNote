import { describe, expect, it } from 'vitest';
import { stripThinking } from '../lib/chat/answerClean';

const COT = `The user is asking "什么叫slice" while watching a Go tutorial at 00:01.
Based on the course subtitles, I should answer with proper time anchors.
Let me structure my answer:
1. Direct answer
2. Step-by-step explanation
3. Connection to the course`;

describe('stripThinking', () => {
  it('剥离英文 CoT + 加粗标题', () => {
    const raw = `${COT}\n\n**直接回答**\n\nSlice 由 data、len、cap 三部分组成。`;
    const out = stripThinking(raw);
    expect(out.answer).toBe('**直接回答**\n\nSlice 由 data、len、cap 三部分组成。');
    expect(out.thinking).toContain('Let me structure');
  });

  it('剥离 markdown 标题前的思考', () => {
    const raw = `${COT}\n\n## 直接回答\n\n三部分组成。`;
    expect(stripThinking(raw).answer).toBe('## 直接回答\n\n三部分组成。');
  });

  it('剥离编号项前的思考', () => {
    const raw = `${COT}\n\n1. 直接回答：三部分组成。`;
    expect(stripThinking(raw).answer).toBe('1. 直接回答：三部分组成。');
  });

  it('起点在开头时不处理', () => {
    const raw = '**直接回答**：Slice 由三部分组成。';
    expect(stripThinking(raw)).toEqual({ answer: raw });
  });

  it('前导过短不剥离（防误伤）', () => {
    const raw = '补充一点背景。\n\n**直接回答**：三部分组成。';
    expect(stripThinking(raw).answer).toBe(raw);
    expect(stripThinking(raw).thinking).toBeUndefined();
  });

  it('无结构化标记时原样返回', () => {
    const raw = '这是一段没有标题的回答，回答这个问题需要从三方面看，内容很长很长。';
    expect(stripThinking(raw).answer).toBe(raw);
  });

  it('行首裸词不匹配（防误伤正文）', () => {
    const raw = `${COT}\n\n回答这个问题其实很简单，因为切片只有三部分。`;
    expect(stripThinking(raw).answer).toBe(raw);
  });
});
