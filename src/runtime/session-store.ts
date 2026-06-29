import type { AgentSnapshot, CustomAgentConfig, ProviderId } from '../config/types.ts';
import { stableHash } from './hash.ts';

export interface SessionRecord {
  id: string;
  threadKey: string;
  snapshot: AgentSnapshot;
  turnCount: number;
}

export interface SessionView extends SessionRecord {
  isNew: boolean;
}

export class ThreadSessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  getOrCreate(input: {
    threadKey: string;
    agent: CustomAgentConfig;
    providerId: ProviderId;
    model: string;
    now: number;
  }): SessionView {
    const existing = this.sessions.get(input.threadKey);
    if (existing) {
      return { ...existing, isNew: false };
    }

    const snapshotBasis = {
      agentId: input.agent.id,
      instructions: input.agent.instructions,
      allowedTools: input.agent.allowedTools,
      providerId: input.providerId,
      model: input.model,
    };
    const snapshot: AgentSnapshot = {
      agent: input.agent,
      model: input.model,
      providerId: input.providerId,
      allowedTools: [...input.agent.allowedTools],
      snapshotHash: stableHash(snapshotBasis),
      createdAt: input.now,
    };
    const session: SessionRecord = {
      id: `slack_${stableHash(input.threadKey).replace('fnv1a64:', '')}`,
      threadKey: input.threadKey,
      snapshot,
      turnCount: 0,
    };
    this.sessions.set(input.threadKey, session);
    return { ...session, isNew: true };
  }

  incrementTurn(threadKey: string): SessionRecord {
    const session = this.sessions.get(threadKey);
    if (!session) {
      throw new Error(`Unknown session for thread ${threadKey}`);
    }
    session.turnCount += 1;
    return session;
  }
}
