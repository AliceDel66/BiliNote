// 笔记 CAS（C3）与字幕/分析缓存原子写（P2）回归测试：fake-indexeddb 提供浏览器级 indexedDB
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NoteRevConflict,
  createNote,
  db,
  findCoursePageId,
  getCachedSummary,
  getNote,
  saveNote,
  saveNoteCAS,
  saveSubtitle,
  saveSummary,
  type NoteRow,
} from '../lib/storage';

beforeEach(async () => {
  await db.notes.clear();
  await db.noteVersions.clear();
  await db.subtitles.clear();
  await db.summaries.clear();
  await db.notionMappings.clear();
});

function noteInput(contentMd = '# 初始内容') {
  return { bvid: 'BV1a', cid: 100, title: '测试笔记', contentMd };
}

describe('NoteRow.rev 与 saveNoteCAS（C3）', () => {
  it('createNote 初始 rev=1；saveNote 每次成功写入 rev+1', async () => {
    const note = await createNote(noteInput());
    expect(note.rev).toBe(1);

    await saveNote(note.id!, { contentMd: '# 第二版' });
    expect((await getNote(note.id!))?.rev).toBe(2);
    await saveNote(note.id!, { title: '只改标题' });
    expect((await getNote(note.id!))?.rev).toBe(3);
  });

  it('saveNoteCAS：expectedRev 匹配 → 写入成功并 rev+1，返回最新行', async () => {
    const note = await createNote(noteInput());
    const saved = await saveNoteCAS(note.id!, { contentMd: '# CAS 写入' }, 1);
    expect(saved.rev).toBe(2);
    expect(saved.contentMd).toBe('# CAS 写入');
    expect((await getNote(note.id!))?.contentMd).toBe('# CAS 写入');

    // 连续 CAS：用返回的 rev 链式推进
    const again = await saveNoteCAS(note.id!, { contentMd: '# CAS 第二次' }, saved.rev);
    expect(again.rev).toBe(3);
  });

  it('saveNoteCAS：expectedRev 不匹配 → 抛 NoteRevConflict 且内容不变，冲突对象携带最新行', async () => {
    const note = await createNote(noteInput());
    await saveNote(note.id!, { contentMd: '# 别人先写了' }); // rev 1 → 2

    const err = await saveNoteCAS(note.id!, { contentMd: '# 基于旧版的写入' }, 1).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NoteRevConflict);
    const conflict = err as NoteRevConflict;
    expect(conflict.latest.rev).toBe(2);
    expect(conflict.latest.contentMd).toBe('# 别人先写了');
    // 冲突写入未生效
    expect((await getNote(note.id!))?.contentMd).toBe('# 别人先写了');
  });

  it('模拟并发 lost update：两个基于同一 rev 的 CAS 只有一个成功', async () => {
    const note = await createNote(noteInput());
    const results = await Promise.allSettled([
      saveNoteCAS(note.id!, { contentMd: '# 写入 A' }, 1),
      saveNoteCAS(note.id!, { contentMd: '# 写入 B' }, 1),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && r.reason instanceof NoteRevConflict,
    );
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect((await getNote(note.id!))?.rev).toBe(2);
  });

  it('升级前的旧行（无 rev 字段）按 rev=1 处理', async () => {
    const note = await createNote(noteInput());
    // 直接 put 一条不带 rev 的行，模拟老版本写入的数据
    const legacy: Omit<NoteRow, 'rev'> & { rev?: number } = { ...note, contentMd: '# 旧数据' };
    delete legacy.rev;
    await db.notes.put(legacy as NoteRow);
    expect(((await getNote(note.id!)) as NoteRow).rev).toBeUndefined();

    const saved = await saveNoteCAS(note.id!, { contentMd: '# 升级后写入' }, 1);
    expect(saved.rev).toBe(2);
    // 错误的 expectedRev（把旧行当 0）→ 冲突
    await expect(saveNoteCAS(note.id!, { contentMd: '# x' }, 0)).rejects.toBeInstanceOf(
      NoteRevConflict,
    );
  });

  it('saveNoteCAS 同样写版本历史（内容变化时）', async () => {
    const note = await createNote(noteInput());
    await saveNoteCAS(note.id!, { contentMd: '# 有版本' }, 1);
    const versions = await db.noteVersions.where('noteId').equals(note.id!).toArray();
    // 创建时 1 版 + CAS 写入 1 版
    expect(versions).toHaveLength(2);
    expect(versions[1].contentMd).toBe('# 有版本');
  });
});

describe('saveSubtitle / saveSummary 原子写（P2：无 delete→add）', () => {
  const cues = [{ start: 0, end: 1, text: '你好' }];

  it('saveSubtitle 重复写同一 [bvid+cid] → 仍只有一行且 id 稳定', async () => {
    await saveSubtitle({ bvid: 'BV1a', cid: 1, lang: 'zh', source: 'human', cues, fetchedAt: 1 });
    const first = await db.subtitles.where('[bvid+cid]').equals(['BV1a', 1]).first();
    await saveSubtitle({
      bvid: 'BV1a',
      cid: 1,
      lang: 'zh-CN',
      source: 'ai',
      cues: [...cues, { start: 1, end: 2, text: '世界' }],
      fetchedAt: 2,
    });
    const rows = await db.subtitles.where('[bvid+cid]').equals(['BV1a', 1]).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first?.id);
    expect(rows[0].lang).toBe('zh-CN');
    expect(rows[0].cues).toHaveLength(2);
  });

  it('saveSubtitle 并发写同一键 → 最终仍只有一行', async () => {
    await Promise.all([
      saveSubtitle({ bvid: 'BV1a', cid: 1, lang: 'zh', source: 'human', cues, fetchedAt: 1 }),
      saveSubtitle({ bvid: 'BV1a', cid: 1, lang: 'zh', source: 'ai', cues, fetchedAt: 2 }),
    ]);
    expect(await db.subtitles.where('[bvid+cid]').equals(['BV1a', 1]).count()).toBe(1);
  });

  it('saveSummary 重复写同一 [bvid+cid+modelId] → 一行；不同 modelId → 各自一行', async () => {
    const result = { outline: [], sections: [], keyPoints: [], extensions: [], caveats: [] };
    await saveSummary({ bvid: 'BV1a', cid: 1, modelId: 'kimi/k2@https://a', result, createdAt: 1 });
    await saveSummary({ bvid: 'BV1a', cid: 1, modelId: 'kimi/k2@https://a', result, createdAt: 2 });
    expect(await db.summaries.count()).toBe(1);
    expect((await getCachedSummary('BV1a', 1, 'kimi/k2@https://a'))?.createdAt).toBe(2);

    await saveSummary({ bvid: 'BV1a', cid: 1, modelId: 'kimi/k2@https://b', result, createdAt: 3 });
    expect(await db.summaries.count()).toBe(2);
  });
});

describe('findCoursePageId scope（C4）', () => {
  it('只返回同一 rootPageId（及 botId 双侧已知时一致）下的课程页', async () => {
    const n1 = await createNote(noteInput());
    await db.notionMappings.add({
      noteId: n1.id!,
      coursePageId: 'course-root1',
      rootPageId: 'root-1',
      lastSyncedAt: 1,
      notionLastEditedTime: '',
      syncStatus: 'synced',
    });

    // 同根 → 复用
    expect(await findCoursePageId('BV1a', { rootPageId: 'root-1' })).toBe('course-root1');
    // 不同根 → 不复用
    expect(await findCoursePageId('BV1a', { rootPageId: 'root-2' })).toBeUndefined();
    // 不传 scope → 旧行为（任意映射）
    expect(await findCoursePageId('BV1a')).toBe('course-root1');
  });
});
