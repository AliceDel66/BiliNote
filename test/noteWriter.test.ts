import { describe, expect, it } from 'vitest';
import {
  appendQaBlock,
  buildChatNoteInit,
  hasQaBlock,
  QA_SECTION_HEADING,
  removeQaBlock,
  type QaEntry,
} from '../lib/chat';

const entryA: QaEntry = {
  chatEntryId: 'turn-aaa',
  anchorTime: 754, // 12:34
  question: '为什么这里要使用指针？',
  answerMd: '因为要共享同一份内存。\n\n- 要点一\n- 要点二',
};

const entryB: QaEntry = {
  chatEntryId: 'turn-bbb',
  anchorTime: 65,
  question: '那栈和堆有什么区别？',
  answerMd: '栈自动回收，堆手动管理。',
};

const START_MARK = '<!-- bilinote-chat:start';

function countBlocks(content: string): number {
  return content.split(START_MARK).length - 1;
}

describe('buildChatNoteInit', () => {
  it('生成元信息头 + 学习问答小节', () => {
    const init = buildChatNoteInit({
      videoTitle: '操作系统原理',
      partLabel: 'P3 内存管理',
      owner: '某UP主',
      url: 'https://www.bilibili.com/BV1xx?p=3',
      generatedAt: new Date('2026-07-20T10:00:00'),
    });
    expect(init).toContain('> 视频：操作系统原理 · P3 内存管理');
    expect(init).toContain('UP 主：某UP主');
    expect(init).toContain(QA_SECTION_HEADING);
  });
});

describe('appendQaBlock', () => {
  it('新笔记：小节已存在则块追加在小节内，且小节只出现一次', () => {
    let content = buildChatNoteInit({ videoTitle: '课程' });
    content = appendQaBlock(content, entryA);
    content = appendQaBlock(content, entryB);
    expect(countBlocks(content)).toBe(2);
    expect(content.split(QA_SECTION_HEADING).length - 1).toBe(1);
    // 块标题含 mm:ss 锚点与问题首行
    expect(content).toContain('### 12:34 · 为什么这里要使用指针？');
    expect(content).toContain('### 01:05 · 那栈和堆有什么区别？');
  });

  it('已有笔记（无问答小节）：在末尾创建小节再追加', () => {
    const base = '> 视频：某课程\n\n## 课程大纲\n\n- 00:00 开场\n';
    const next = appendQaBlock(base, entryA);
    expect(next).toContain('## 课程大纲');
    expect(next).toContain(QA_SECTION_HEADING);
    expect(countBlocks(next)).toBe(1);
    // 原大纲内容保留
    expect(next).toContain('- 00:00 开场');
  });

  it('幂等：同 chatEntryId 重复追加 = 原地替换，不产生重复块', () => {
    let content = appendQaBlock('', entryA);
    const once = content;
    content = appendQaBlock(content, entryA);
    expect(content).toBe(once);
    expect(countBlocks(content)).toBe(1);

    // 同 id 但回答更新 → 原地替换为新内容
    const updated = appendQaBlock(content, { ...entryA, answerMd: '更新后的回答' });
    expect(countBlocks(updated)).toBe(1);
    expect(updated).toContain('更新后的回答');
    expect(updated).not.toContain('要点一');
  });

  it('问题首行超过 40 字时标题截断', () => {
    const longQ = `${'很长的提问'.repeat(10)}\n第二行`;
    const content = appendQaBlock('', { ...entryA, question: longQ });
    const heading = content.split('\n').find((l) => l.startsWith('### '));
    expect(heading).toBeDefined();
    expect(heading!.length).toBeLessThanOrEqual('### 12:34 · '.length + 40);
  });
});

describe('removeQaBlock', () => {
  it('只移除目标块，保留周围手工编辑与其他问答块', () => {
    let content = `# 我的课程笔记\n\n手写的第一段。\n\n${QA_SECTION_HEADING}\n\n`;
    content = appendQaBlock(content, entryA);
    content = appendQaBlock(content, entryB);
    content += '\n问答区后面的手写补充。\n';

    const removed = removeQaBlock(content, entryA.chatEntryId);
    expect(hasQaBlock(removed, entryA.chatEntryId)).toBe(false);
    expect(hasQaBlock(removed, entryB.chatEntryId)).toBe(true);
    expect(removed).toContain('手写的第一段。');
    expect(removed).toContain('问答区后面的手写补充。');
    expect(countBlocks(removed)).toBe(1);
  });

  it('撤销后重新记录：块再次写回且只有一份', () => {
    let content = appendQaBlock(buildChatNoteInit({ videoTitle: '课程' }), entryA);
    content = removeQaBlock(content, entryA.chatEntryId);
    expect(hasQaBlock(content, entryA.chatEntryId)).toBe(false);
    content = appendQaBlock(content, entryA);
    expect(countBlocks(content)).toBe(1);
    expect(hasQaBlock(content, entryA.chatEntryId)).toBe(true);
  });

  it('移除不存在的块 = 原样返回（无异常）', () => {
    const base = '随便一段笔记\n\n第二行\n';
    expect(removeQaBlock(base, 'not-exist')).toBe(base);
  });
});
