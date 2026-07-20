/**
 * AI Chat 持久化 CRUD（Dexie v3：chatSessions / chatTopics / chatTurns）。
 * 稳定 id（uuid）+ clientRequestId 唯一约束，保证重开面板 / Port 重连 / 重试不产生重复写入。
 */
import { db } from '../storage/db';
import type { ChatSession, ChatTopic, ChatTurn } from './types';

// ---------- Session ----------

export async function getSessionByVideo(
  bvid: string,
  cid: number,
): Promise<ChatSession | undefined> {
  return db.chatSessions.where('[bvid+cid]').equals([bvid, cid]).first();
}

export async function getSession(id: string): Promise<ChatSession | undefined> {
  return db.chatSessions.get(id);
}

/** 按 bvid+cid 取会话，没有则创建（autoRecord 默认开） */
export async function getOrCreateSession(bvid: string, cid: number): Promise<ChatSession> {
  const existing = await getSessionByVideo(bvid, cid);
  if (existing) return existing;
  const now = Date.now();
  const session: ChatSession = {
    id: crypto.randomUUID(),
    bvid,
    cid,
    autoRecord: true,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await db.chatSessions.add(session);
    return session;
  } catch {
    // 并发创建撞唯一索引：回读已有会话
    const raced = await getSessionByVideo(bvid, cid);
    if (raced) return raced;
    throw new Error('创建课程会话失败');
  }
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<ChatSession, 'targetNoteId' | 'autoRecord'>>,
): Promise<void> {
  await db.chatSessions.update(id, { ...patch, updatedAt: Date.now() });
}

// ---------- Topic ----------

export async function getTopic(id: string): Promise<ChatTopic | undefined> {
  return db.chatTopics.get(id);
}

export async function listTopics(sessionId: string): Promise<ChatTopic[]> {
  return db.chatTopics.where('sessionId').equals(sessionId).sortBy('createdAt');
}

export async function createTopic(input: {
  sessionId: string;
  title: string;
  anchorTime: number;
}): Promise<ChatTopic> {
  const now = Date.now();
  const topic: ChatTopic = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  await db.chatTopics.add(topic);
  return topic;
}

export async function updateTopic(
  id: string,
  patch: Partial<Pick<ChatTopic, 'title' | 'anchorTime'>>,
): Promise<void> {
  await db.chatTopics.update(id, { ...patch, updatedAt: Date.now() });
}

// ---------- Turn ----------

export async function getTurn(id: string): Promise<ChatTurn | undefined> {
  return db.chatTurns.get(id);
}

export async function getTurnByClientRequestId(
  clientRequestId: string,
): Promise<ChatTurn | undefined> {
  return db.chatTurns.where('clientRequestId').equals(clientRequestId).first();
}

export async function addTurn(
  input: Omit<ChatTurn, 'id' | 'createdAt'> & { id?: string },
): Promise<ChatTurn> {
  const turn: ChatTurn = {
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: Date.now(),
  };
  await db.chatTurns.add(turn);
  return turn;
}

export async function updateTurn(
  id: string,
  patch: Partial<
    Pick<ChatTurn, 'answerMd' | 'status' | 'noteWriteStatus' | 'noteEntryId' | 'error'>
  >,
): Promise<void> {
  await db.chatTurns.update(id, patch);
}

export async function listTurnsByTopic(topicId: string): Promise<ChatTurn[]> {
  return db.chatTurns.where('topicId').equals(topicId).sortBy('createdAt');
}
