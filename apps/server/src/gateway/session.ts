import type { ChatMessage, ChannelType } from "@chvor/shared";
import {
  getSessionById,
  upsertSession,
  addMessage,
} from "../db/session-store.ts";

export interface SessionData {
  id: string;
  channelType: ChannelType;
  channelId: string;
  threadId?: string;
  workspaceId: string;
  messages: ChatMessage[];
  persistedCount: number;
  createdAt: string;
  updatedAt: string;
  /** Set when orchestrator hit the round limit with real progress — next message gets extra rounds.
   *  Note: in-memory only, not persisted to DB. Lost on server restart (acceptable). */
  continuationPending?: boolean;
}

const MAX_CACHE = 50;
/** In-memory cap per session — keeps only the most recent messages to bound RAM usage.
 *  DB always has the full history; this cap only affects the working set. */
const MAX_SESSION_MESSAGES = 500;

export class SessionManager {
  private cache = new Map<string, SessionData>();

  private makeKey(channelType: ChannelType, channelId: string, threadId?: string): string {
    return `${channelType}:${channelId}:${threadId ?? "default"}`;
  }

  getOrCreate(channelType: ChannelType, channelId: string, threadId?: string): SessionData {
    const key = this.makeKey(channelType, channelId, threadId);

    // 1. Check cache (refresh MRU position on hit)
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    // 2. Check DB
    const dbSession = getSessionById(key);
    if (dbSession) {
      const data: SessionData = {
        id: dbSession.id,
        channelType: dbSession.channelType,
        channelId: dbSession.channelId,
        threadId: dbSession.threadId,
        workspaceId: dbSession.workspaceId,
        messages: dbSession.messages,
        persistedCount: dbSession.messages.length,
        createdAt: dbSession.createdAt,
        updatedAt: dbSession.updatedAt,
      };
      this.addToCache(key, data);
      return data;
    }

    // 3. Create new
    const now = new Date().toISOString();
    const session: SessionData = {
      id: key,
      channelType,
      channelId,
      threadId,
      workspaceId: "default-constellation",
      messages: [],
      persistedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    upsertSession(key, channelType, channelId, threadId, "default-constellation");
    this.addToCache(key, session);
    return session;
  }

  get(channelType: ChannelType, channelId: string, threadId?: string): SessionData | undefined {
    const key = this.makeKey(channelType, channelId, threadId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const dbSession = getSessionById(key);
    if (!dbSession) return undefined;
    const data: SessionData = {
      id: dbSession.id,
      channelType: dbSession.channelType,
      channelId: dbSession.channelId,
      threadId: dbSession.threadId,
      workspaceId: dbSession.workspaceId,
      messages: dbSession.messages,
      persistedCount: dbSession.messages.length,
      createdAt: dbSession.createdAt,
      updatedAt: dbSession.updatedAt,
    };
    this.addToCache(key, data);
    return data;
  }

  /** Remove a session from the in-memory cache (e.g. after reset) */
  evict(key: string): void {
    this.cache.delete(key);
  }

  persist(session: SessionData): void {
    // Only persist new messages (incremental INSERTs)
    for (let i = session.persistedCount; i < session.messages.length; i++) {
      addMessage(session.id, session.messages[i]);
    }
    session.persistedCount = session.messages.length;

    // Cap in-memory messages to prevent unbounded RAM growth.
    // DB always has the full history; this only trims the working set.
    if (session.messages.length > MAX_SESSION_MESSAGES) {
      const overflow = session.messages.length - MAX_SESSION_MESSAGES;
      session.messages = session.messages.slice(overflow);
      session.persistedCount = Math.max(0, session.persistedCount - overflow);
    }
  }

  private addToCache(key: string, data: SessionData): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= MAX_CACHE) {
      // Evict LRU entry (first key in Map iteration order)
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(key, data);
  }
}
