// Dexie v3 Chat 持久化测试：fake-indexeddb 提供浏览器级 indexedDB
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../lib/storage/db';
import {
  addTurn,
  createTopic,
  getOrCreateSession,
  getSessionByVideo,
  getTurn,
  getTurnByClientRequestId,
  listTopics,
  listTurnsByTopic,
  updateSession,
  updateTurn,
} from '../lib/chat';

beforeEach(async () => {
  await db.chatSessions.clear();
  await db.chatTopics.clear();
  await db.chatTurns.clear();
});

describe('chatSessions', () => {
  it('按 [bvid+cid] 唯一：getOrCreate 返回同一会话', async () => {
    const s1 = await getOrCreateSession('BV1a', 100);
    const s2 = await getOrCreateSession('BV1a', 100);
    expect(s2.id).toBe(s1.id);
    expect(s2.autoRecord).toBe(true);
    expect(await db.chatSessions.count()).toBe(1);

    // 不同 cid → 不同会话（分 P 隔离，§5.2）
    const s3 = await getOrCreateSession('BV1a', 200);
    expect(s3.id).not.toBe(s1.id);
  });

  it('直接 add 重复 [bvid+cid] 被唯一索引拒绝', async () => {
    const s = await getOrCreateSession('BV1a', 100);
    await expect(
      db.chatSessions.add({ ...s, id: 'another-id' }),
    ).rejects.toThrow();
    expect(await db.chatSessions.count()).toBe(1);
  });

  it('updateSession：targetNoteId / autoRecord', async () => {
    const s = await getOrCreateSession('BV1a', 100);
    await updateSession(s.id, { targetNoteId: 7, autoRecord: false });
    const next = await getSessionByVideo('BV1a', 100);
    expect(next?.targetNoteId).toBe(7);
    expect(next?.autoRecord).toBe(false);
  });
});

describe('chatTurns', () => {
  async function seedTopic() {
    const session = await getOrCreateSession('BV1a', 100);
    return createTopic({ sessionId: session.id, title: '话题', anchorTime: 42 });
  }

  function turnInput(topicId: string, clientRequestId: string) {
    return {
      clientRequestId,
      topicId,
      question: '问题',
      answerMd: '',
      anchorTime: 42,
      status: 'streaming' as const,
      noteWriteStatus: 'pending' as const,
    };
  }

  it('clientRequestId 唯一：重复提交被拒（重连/重试不产生双写，§9.8）', async () => {
    const topic = await seedTopic();
    await addTurn(turnInput(topic.id, 'req-1'));
    await expect(addTurn(turnInput(topic.id, 'req-1'))).rejects.toThrow();
    expect((await listTurnsByTopic(topic.id)).length).toBe(1);

    const hit = await getTurnByClientRequestId('req-1');
    expect(hit?.topicId).toBe(topic.id);
  });

  it('状态流转：streaming → done → noteWriteStatus written', async () => {
    const topic = await seedTopic();
    const turn = await addTurn(turnInput(topic.id, 'req-2'));
    expect((await getTurn(turn.id))?.status).toBe('streaming');

    await updateTurn(turn.id, { answerMd: '完整回答', status: 'done' });
    await updateTurn(turn.id, { noteWriteStatus: 'written', noteEntryId: turn.id });
    const done = await getTurn(turn.id);
    expect(done?.status).toBe('done');
    expect(done?.answerMd).toBe('完整回答');
    expect(done?.noteWriteStatus).toBe('written');
    expect(done?.noteEntryId).toBe(turn.id);

    // 撤销流转
    await updateTurn(turn.id, { noteWriteStatus: 'undone' });
    expect((await getTurn(turn.id))?.noteWriteStatus).toBe('undone');
  });

  it('listTurnsByTopic 按创建时间升序', async () => {
    const topic = await seedTopic();
    const a = await addTurn(turnInput(topic.id, 'req-a'));
    await new Promise((r) => setTimeout(r, 2)); // 保证 createdAt 不同毫秒
    const b = await addTurn(turnInput(topic.id, 'req-b'));
    const turns = await listTurnsByTopic(topic.id);
    expect(turns.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it('listTopics 按创建时间升序且隔离会话', async () => {
    const s1 = await getOrCreateSession('BV1a', 100);
    const s2 = await getOrCreateSession('BV1a', 200);
    await createTopic({ sessionId: s1.id, title: 's1话题', anchorTime: 0 });
    await createTopic({ sessionId: s2.id, title: 's2话题', anchorTime: 0 });
    const topics = await listTopics(s1.id);
    expect(topics).toHaveLength(1);
    expect(topics[0].title).toBe('s1话题');
  });
});
