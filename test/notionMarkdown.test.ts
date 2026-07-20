import { describe, expect, it } from 'vitest';
import {
  markdownToNotionBlocks,
  parseInline,
  splitLongText,
  type NotionBlock,
  type NotionRichText,
} from '../lib/notion';

function richTextOf(block: NotionBlock): NotionRichText[] {
  return (block as Record<string, { rich_text: NotionRichText[] }>)[block.type].rich_text;
}

function plainOf(block: NotionBlock): string {
  return richTextOf(block)
    .map((t) => t.text.content)
    .join('');
}

describe('markdownToNotionBlocks 块级结构', () => {
  it('标题 1-3 级，#### 降级为 heading_3', () => {
    const blocks = markdownToNotionBlocks('# H1\n## H2\n### H3\n#### H4');
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_1',
      'heading_2',
      'heading_3',
      'heading_3',
    ]);
    expect(plainOf(blocks[0])).toBe('H1');
  });

  it('无序 / 有序列表', () => {
    const blocks = markdownToNotionBlocks('- 苹果\n- 香蕉\n\n1. 第一步\n2. 第二步');
    expect(blocks.map((b) => b.type)).toEqual([
      'bulleted_list_item',
      'bulleted_list_item',
      'numbered_list_item',
      'numbered_list_item',
    ]);
    expect(plainOf(blocks[3])).toBe('第二步');
  });

  it('待办事项（勾选状态）', () => {
    const blocks = markdownToNotionBlocks('- [ ] 待做\n- [x] 已做');
    expect(blocks.map((b) => b.type)).toEqual(['to_do', 'to_do']);
    expect((blocks[0].to_do as { checked: boolean }).checked).toBe(false);
    expect((blocks[1].to_do as { checked: boolean }).checked).toBe(true);
  });

  it('代码围栏（含语言映射，内容不做行内解析）', () => {
    const blocks = markdownToNotionBlocks('```ts\nconst a = **1**;\n```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('code');
    const code = blocks[0].code as { language: string; rich_text: NotionRichText[] };
    expect(code.language).toBe('typescript');
    expect(code.rich_text[0].text.content).toBe('const a = **1**;');
    expect(code.rich_text[0].annotations.code).toBe(false);
  });

  it('未知语言回退 plain text', () => {
    const blocks = markdownToNotionBlocks('```brainfuck\n+++\n```');
    expect((blocks[0].code as { language: string }).language).toBe('plain text');
  });

  it('引用与段落', () => {
    const blocks = markdownToNotionBlocks('> 引用一句话\n\n普通段落文本');
    expect(blocks.map((b) => b.type)).toEqual(['quote', 'paragraph']);
    expect(plainOf(blocks[0])).toBe('引用一句话');
  });

  it('连续普通行合并为一个段落', () => {
    const blocks = markdownToNotionBlocks('第一行\n第二行');
    expect(blocks).toHaveLength(1);
    expect(plainOf(blocks[0])).toBe('第一行\n第二行');
  });

  it('时间戳保持纯文本', () => {
    const blocks = markdownToNotionBlocks('- 12:35 重点讲解');
    const rt = richTextOf(blocks[0]);
    expect(rt).toHaveLength(1);
    expect(rt[0].text.content).toBe('12:35 重点讲解');
    expect(rt[0].annotations.bold).toBe(false);
  });
});

describe('parseInline 行内格式', () => {
  it('加粗 / 斜体 / 行内代码 / 链接', () => {
    const rt = parseInline('这是 **加粗** 和 *斜体* 和 `code` 和 [链接](https://notion.so) 完');
    expect(rt.map((t) => [t.text.content, t.annotations.bold, t.annotations.italic, t.annotations.code, t.text.link?.url ?? ''])).toEqual([
      ['这是 ', false, false, false, ''],
      ['加粗', true, false, false, ''],
      [' 和 ', false, false, false, ''],
      ['斜体', false, true, false, ''],
      [' 和 ', false, false, false, ''],
      ['code', false, false, true, ''],
      [' 和 ', false, false, false, ''],
      ['链接', false, false, false, 'https://notion.so'],
      [' 完', false, false, false, ''],
    ]);
  });

  it('组合：加粗内嵌行内代码', () => {
    const rt = parseInline('**加粗 `code` 结束**');
    expect(rt).toHaveLength(3);
    expect(rt[0]).toMatchObject({ text: { content: '加粗 ' }, annotations: { bold: true, code: false } });
    expect(rt[1]).toMatchObject({ text: { content: 'code' }, annotations: { bold: true, code: true } });
    expect(rt[2]).toMatchObject({ text: { content: ' 结束' }, annotations: { bold: true } });
  });

  it('时间戳不被误解析', () => {
    const rt = parseInline('见 12:35 处');
    expect(rt).toHaveLength(1);
    expect(rt[0].text.content).toBe('见 12:35 处');
  });
});

describe('长文本拆分（Notion 2000 字上限）', () => {
  it('splitLongText 硬切与换行优先', () => {
    const chunks = splitLongText('a'.repeat(4500));
    expect(chunks.map((c) => c.length)).toEqual([2000, 2000, 500]);

    const withNewline = `${'x'.repeat(1500)}\n${'y'.repeat(900)}`;
    const c2 = splitLongText(withNewline);
    expect(c2).toHaveLength(2);
    expect(c2[0]).toBe('x'.repeat(1500));
    expect(c2[1]).toBe('y'.repeat(900));
  });

  it('超长段落拆成多个块，每块 ≤2000', () => {
    const blocks = markdownToNotionBlocks('a'.repeat(4500));
    expect(blocks).toHaveLength(3);
    for (const b of blocks) {
      expect(b.type).toBe('paragraph');
      expect(plainOf(b).length).toBeLessThanOrEqual(2000);
    }
  });

  it('超长标题的续块降级为段落', () => {
    const blocks = markdownToNotionBlocks(`# ${'b'.repeat(2100)}`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('heading_1');
    expect(blocks[1].type).toBe('paragraph');
  });
});
