/**
 * Markdown → Notion blocks 受限映射（PRD 6.2 / F-07）。
 * 支持：# / ## / ### 标题、- 无序列表、1. 有序列表、- [ ] 待办、``` 代码块、
 * > 引用、段落；行内 **加粗** / *斜体* / `代码` / [链接](url)。
 * 时间戳（如 12:35）保持纯文本，不做特殊处理。
 *
 * 限制处理：
 * - 单块纯文本 > 2000 字符（Notion rich_text 上限）时拆成多个连续块；
 *   标题的续块降级为段落，其余块保持原类型
 * - #### 及更深标题按 ### 处理；嵌套列表拍平为一级
 */

/** Notion rich_text / 标题单段内容上限 */
export const NOTION_TEXT_LIMIT = 2000;

export interface NotionRichText {
  type: 'text';
  text: { content: string; link?: { url: string } };
  annotations: {
    bold: boolean;
    italic: boolean;
    code: boolean;
    strikethrough: boolean;
    underline: boolean;
    color: string;
  };
}

/** 松散类型的块结构（type + 同名字段），交由 Notion API 校验 */
export interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

// ---------- 行内解析 ----------

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

function richText(content: string, style: InlineStyle): NotionRichText {
  return {
    type: 'text',
    text: {
      content,
      ...(style.link ? { link: { url: style.link } } : {}),
    },
    annotations: {
      bold: style.bold ?? false,
      italic: style.italic ?? false,
      code: style.code ?? false,
      strikethrough: false,
      underline: false,
      color: 'default',
    },
  };
}

function sameStyle(a: NotionRichText, b: NotionRichText): boolean {
  return (
    a.annotations.bold === b.annotations.bold &&
    a.annotations.italic === b.annotations.italic &&
    a.annotations.code === b.annotations.code &&
    (a.text.link?.url ?? '') === (b.text.link?.url ?? '')
  );
}

/** 合并相邻同样式片段，控制 rich_text 数组长度 */
function mergeAdjacent(items: NotionRichText[]): NotionRichText[] {
  const out: NotionRichText[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (last && sameStyle(last, item)) {
      last.text.content += item.text.content;
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * 行内格式解析：逐个位置尝试匹配 链接 / 行内代码 / 加粗 / 斜体，
 * 命中后递归解析内部内容（支持组合，如 **加粗 `code`**）。
 */
export function parseInline(text: string, style: InlineStyle = {}): NotionRichText[] {
  const out: NotionRichText[] = [];
  let buf = '';
  let i = 0;
  const pushBuf = () => {
    if (buf) {
      out.push(richText(buf, style));
      buf = '';
    }
  };
  while (i < text.length) {
    if (!style.code) {
      const rest = text.slice(i);
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
      if (link) {
        pushBuf();
        out.push(...parseInline(link[1], { ...style, link: link[2] }));
        i += link[0].length;
        continue;
      }
      const code = /^`([^`]+)`/.exec(rest);
      if (code) {
        pushBuf();
        out.push(richText(code[1], { ...style, code: true }));
        i += code[0].length;
        continue;
      }
      const bold = /^\*\*(.+?)\*\*/.exec(rest);
      if (bold) {
        pushBuf();
        out.push(...parseInline(bold[1], { ...style, bold: true }));
        i += bold[0].length;
        continue;
      }
      const italic = /^\*([^*\n]+)\*/.exec(rest);
      if (italic) {
        pushBuf();
        out.push(...parseInline(italic[1], { ...style, italic: true }));
        i += italic[0].length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  pushBuf();
  return mergeAdjacent(out);
}

// ---------- 块级解析 ----------

/** Notion code 块 language 枚举的常见映射，未知语言回退 plain text */
const LANGUAGE_MAP: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  py: 'python',
  python: 'python',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  json: 'json',
  html: 'html',
  css: 'css',
  java: 'java',
  c: 'c',
  'c++': 'c++',
  cpp: 'c++',
  go: 'go',
  rust: 'rust',
  sql: 'sql',
  yaml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
};

/** 把长文本切成 ≤ limit 的若干段（优先在换行处断开） */
export function splitLongText(text: string, limit = NOTION_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit; // 附近没有换行则硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

type BlockType =
  | 'paragraph'
  | 'heading_1'
  | 'heading_2'
  | 'heading_3'
  | 'bulleted_list_item'
  | 'numbered_list_item'
  | 'to_do'
  | 'quote'
  | 'code';

function makeBlock(type: BlockType, richTextArr: NotionRichText[], extra?: Record<string, unknown>): NotionBlock {
  return { type, [type]: { rich_text: richTextArr, ...extra } } as NotionBlock;
}

/** 追加带 rich_text 的块，超长按 2000 字拆分；标题续块降级为段落 */
function pushTextBlocks(out: NotionBlock[], type: BlockType, text: string): void {
  if (!text.trim()) return;
  const chunks = splitLongText(text);
  chunks.forEach((chunk, idx) => {
    const actual: BlockType =
      idx > 0 && (type === 'heading_1' || type === 'heading_2' || type === 'heading_3')
        ? 'paragraph'
        : type;
    out.push(makeBlock(actual, parseInline(chunk)));
  });
}

function pushTodoBlock(out: NotionBlock[], text: string, checked: boolean): void {
  if (!text.trim()) return;
  for (const chunk of splitLongText(text)) {
    out.push(makeBlock('to_do', parseInline(chunk), { checked }));
  }
}

function pushCodeBlocks(out: NotionBlock[], text: string, lang: string): void {
  const language = LANGUAGE_MAP[lang.toLowerCase()] ?? 'plain text';
  const chunks = splitLongText(text === '' ? ' ' : text);
  for (const chunk of chunks) {
    out.push(
      makeBlock('code', [
        {
          type: 'text',
          text: { content: chunk },
          annotations: {
            bold: false,
            italic: false,
            code: false,
            strikethrough: false,
            underline: false,
            color: 'default',
          },
        },
      ], { language }),
    );
  }
}

export function markdownToNotionBlocks(md: string): NotionBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: NotionBlock[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length > 0) {
      pushTextBlocks(blocks, 'paragraph', paragraph.join('\n'));
      paragraph = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\S*)\s*$/.exec(line.trim());
    if (fence) {
      flushParagraph();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过收尾 ```
      pushCodeBlocks(blocks, buf.join('\n'), fence[1] || 'plain text');
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }

    const heading = /^[ \t]*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(3, heading[1].length);
      pushTextBlocks(blocks, `heading_${level}` as BlockType, heading[2].trim());
      i++;
      continue;
    }

    const todo = /^[ \t]*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (todo) {
      flushParagraph();
      pushTodoBlock(blocks, todo[2].trim(), todo[1] !== ' ');
      i++;
      continue;
    }

    const numbered = /^[ \t]*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      pushTextBlocks(blocks, 'numbered_list_item', numbered[1].trim());
      i++;
      continue;
    }

    const bulleted = /^[ \t]*[-*+]\s+(.*)$/.exec(line);
    if (bulleted) {
      flushParagraph();
      pushTextBlocks(blocks, 'bulleted_list_item', bulleted[1].trim());
      i++;
      continue;
    }

    const quote = /^[ \t]*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      pushTextBlocks(blocks, 'quote', quote[1].trim());
      i++;
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flushParagraph();
  return blocks;
}
