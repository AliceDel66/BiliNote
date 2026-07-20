import { describe, expect, it } from 'vitest';
import { analysisToMarkdown, type AnalysisResult } from '../lib/summarize';

function makeResult(patch?: Partial<AnalysisResult>): AnalysisResult {
  return {
    outline: [{ title: '进程与线程', time: 755 }],
    sections: [
      { title: '进程概念', start: 0, end: 300, points: ['进程是资源分配的最小单位'] },
    ],
    keyPoints: [{ point: 'PCB', explanation: '进程控制块，保存进程状态', time: 100 }],
    extensions: [{ title: '协程', detail: '用户态轻量线程，切换成本更低' }],
    caveats: [{ title: '混淆进程与线程', detail: '线程是调度单位，进程是资源单位' }],
    ...patch,
  };
}

const fullMeta = {
  videoTitle: '操作系统课程',
  partLabel: 'P2 进程管理',
  owner: '张三',
  url: 'https://www.bilibili.com/BV1xx?p=2',
  generatedAt: new Date(2026, 6, 20, 9, 5),
};

describe('analysisToMarkdown 元信息头', () => {
  it('有 meta：文档顶部渲染引用块（视频 / UP 主与链接 / 生成时间）', () => {
    const md = analysisToMarkdown(makeResult(), fullMeta);
    expect(md.startsWith('> 视频：操作系统课程 · P2 进程管理\n')).toBe(true);
    expect(md).toContain('> UP 主：张三 ｜ 链接：https://www.bilibili.com/BV1xx?p=2\n');
    expect(md).toContain('> 生成于 2026-07-20 09:05\n');
    // 头部之后才是正文
    expect(md.indexOf('## 课程大纲')).toBeGreaterThan(md.indexOf('> 生成于'));
  });

  it('meta 缺字段：省略对应段（无 UP 主则只渲染链接；无分P则第一行无后缀）', () => {
    const md = analysisToMarkdown(makeResult(), {
      videoTitle: '单P视频',
      url: 'https://www.bilibili.com/BV1yy',
    });
    expect(md).toContain('> 视频：单P视频\n');
    expect(md).not.toContain('单P视频 ·');
    expect(md).toContain('> 链接：https://www.bilibili.com/BV1yy\n');
    expect(md).not.toContain('UP 主');
    expect(md).not.toContain('生成于');
  });

  it('meta 只有 UP 主（无链接）：渲染 UP 主段且无分隔符', () => {
    const md = analysisToMarkdown(makeResult(), {
      videoTitle: 'v',
      owner: '李四',
    });
    expect(md).toContain('> UP 主：李四\n');
    expect(md).not.toContain('｜');
  });

  it('无 meta：输出与旧版一致（无引用块，直接正文）', () => {
    const md = analysisToMarkdown(makeResult());
    expect(md.startsWith('## 课程大纲')).toBe(true);
    expect(md).not.toContain('> ');
  });
});

describe('analysisToMarkdown 拓展知识 / 注意事项', () => {
  it('渲染两个新板块：- **{title}**：{detail}，位于重点难点之后', () => {
    const md = analysisToMarkdown(makeResult());
    expect(md).toContain('## 拓展知识\n\n- **协程**：用户态轻量线程，切换成本更低\n');
    expect(md).toContain('## 注意事项\n\n- **混淆进程与线程**：线程是调度单位，进程是资源单位\n');
    expect(md.indexOf('## 拓展知识')).toBeGreaterThan(md.indexOf('## 重点 / 难点'));
    expect(md.indexOf('## 注意事项')).toBeGreaterThan(md.indexOf('## 拓展知识'));
  });

  it('空数组：省略对应板块', () => {
    const md = analysisToMarkdown(makeResult({ extensions: [], caveats: [] }));
    expect(md).not.toContain('拓展知识');
    expect(md).not.toContain('注意事项');
    // 其余板块不受影响
    expect(md).toContain('## 课程大纲');
    expect(md).toContain('## 重点 / 难点');
  });

  it('rawMarkdown 降级：有 meta 时同样补元信息头', () => {
    const md = analysisToMarkdown(
      makeResult({ rawMarkdown: '模型原文输出' }),
      fullMeta,
    );
    expect(md.startsWith('> 视频：操作系统课程 · P2 进程管理\n')).toBe(true);
    expect(md).toContain('模型原文输出');
  });
});
