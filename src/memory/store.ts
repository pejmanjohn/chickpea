import { promisify } from '../state/async-facade.ts';
import { openStateDb, resolveStateDbPath } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import {
  MemoryStateError,
  type AgentMemory,
  type MemoryRpcRequest,
  type MemoryRpcResponse,
  type MemoryStateStore,
  type PutAgentMemoryInput,
} from './types.ts';

const MAX_AGENT_MEMORY_BYTES = 64 * 1_024;
const MAX_MUTATION_RECEIPTS_PER_AGENT = 1_024;

/** Target-neutral single-body Agent memory storage. */
export class MemoryStoreLogic {
  constructor(private readonly db: StateDb, _now: () => number = Date.now) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memories (
        agent_id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_memory_mutation_receipts (
        agent_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        result_revision INTEGER NOT NULL CHECK (result_revision >= 1),
        PRIMARY KEY (agent_id, idempotency_key)
      )
    `);
  }

  execute(request: MemoryRpcRequest): MemoryRpcResponse {
    switch (request.kind) {
      case 'get_agent_memory':
        return { kind: 'agent_memory', memory: this.getAgentMemory(request.agentId) };
      case 'put_agent_memory':
        return { kind: 'agent_memory', memory: this.putAgentMemory(request.input) };
    }
  }

  getAgentMemory(agentId: string): AgentMemory {
    const row = this.db.get(
      'SELECT agent_id, body, revision FROM agent_memories WHERE agent_id = ?',
      agentId,
    ) as { agent_id: string; body: string; revision: number } | undefined;
    return row
      ? { agentId: row.agent_id, body: row.body, revision: Number(row.revision) }
      : { agentId, body: '', revision: 0 };
  }

  putAgentMemory(input: PutAgentMemoryInput): AgentMemory {
    if ((input.idempotencyKey === undefined) !== (input.idempotencyDigest === undefined)) {
      throw new MemoryStateError(
        'memory_idempotency_invalid',
        'Memory idempotency key and digest must be provided together.',
      );
    }
    return this.db.transaction(() => {
      const current = this.getAgentMemory(input.agentId);
      if (input.idempotencyKey && input.idempotencyDigest) {
        const receipt = this.db.get(
          `SELECT request_digest FROM agent_memory_mutation_receipts
           WHERE agent_id = ? AND idempotency_key = ?`,
          input.agentId,
          input.idempotencyKey,
        ) as { request_digest: string } | undefined;
        if (receipt) {
          if (receipt.request_digest !== input.idempotencyDigest) {
            throw new MemoryStateError(
              'memory_idempotency_conflict',
              'Memory idempotency key was reused for another mutation.',
            );
          }
          return current;
        }
      }
      if (current.revision !== input.expectedRevision) {
        throw new MemoryStateError('memory_version_conflict', 'Agent memory changed.');
      }
      if (new TextEncoder().encode(input.body).byteLength > MAX_AGENT_MEMORY_BYTES) {
        throw new MemoryStateError('memory_entry_too_large', 'Agent memory is too large.');
      }
      if (current.revision === 0) {
        this.db.run(
          'INSERT INTO agent_memories (agent_id, body, revision) VALUES (?, ?, 1)',
          input.agentId,
          input.body,
        );
      } else {
        const result = this.db.run(
          'UPDATE agent_memories SET body = ?, revision = revision + 1 WHERE agent_id = ? AND revision = ?',
          input.body,
          input.agentId,
          input.expectedRevision,
        );
        if (result.changes !== 1) {
          throw new MemoryStateError('memory_version_conflict', 'Agent memory changed.');
        }
      }
      const saved = this.getAgentMemory(input.agentId);
      if (input.idempotencyKey && input.idempotencyDigest) {
        this.db.run(
          `INSERT INTO agent_memory_mutation_receipts (
             agent_id, idempotency_key, request_digest, result_revision
           ) VALUES (?, ?, ?, ?)`,
          input.agentId,
          input.idempotencyKey,
          input.idempotencyDigest,
          saved.revision,
        );
        this.db.run(
          `DELETE FROM agent_memory_mutation_receipts
           WHERE agent_id = ? AND result_revision <= ?`,
          input.agentId,
          saved.revision - MAX_MUTATION_RECEIPTS_PER_AGENT,
        );
      }
      return saved;
    });
  }

  deleteAgentMemory(agentId: string): number {
    return this.db.transaction(() => {
      this.db.run('DELETE FROM agent_memory_mutation_receipts WHERE agent_id = ?', agentId);
      return this.db.run('DELETE FROM agent_memories WHERE agent_id = ?', agentId).changes;
    });
  }
}

export interface SqliteMemoryStateStore extends MemoryStateStore {
  close(): void;
}

export class SqliteMemoryStateStore {
  constructor(path: string = resolveStateDbPath(), now: () => number = Date.now) {
    const db = openStateDb(path);
    db.exec('PRAGMA secure_delete = ON');
    const _conforms: MemoryStateStore = promisify(new MemoryStoreLogic(db, now), {
      close: () => db.close(),
    });
    return _conforms as unknown as SqliteMemoryStateStore;
  }
}
