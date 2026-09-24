import type { RepositoryGrant } from '../config/types.ts';
import type { SandboxPolicyStorage } from './cloudflare-policy.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

const SANDBOX_WORKSPACE_STORAGE_KEY = 'chickpea.sandbox.workspace.v1';

/** How long a thread's checkpoint can be restored after its last turn. */
export const WORKSPACE_CHECKPOINT_TTL_SECONDS = 3 * 24 * 60 * 60;

export const WORKSPACE_DIR = '/workspace';

// Rebuildable dependency and cache trees stay out of checkpoints; the Agent
// reinstalls them. Keep these to bare directory names: the Sandbox container
// already adds a `... <name>` variant that matches at any depth, and a pattern
// with a wildcard directory segment (for example `*/node_modules`) under that
// prefix makes mksquashfs exclude everything, leaving an empty checkpoint.
export const WORKSPACE_CHECKPOINT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.venv',
  '__pycache__',
  '.next',
  '.turbo',
  '.cache',
];

/**
 * How a turn found the thread's coding workspace:
 * - `warm`: the container from an earlier turn is still running for the same
 *   Agent and grants, so its files carry over.
 * - `fresh`: no container is running; the first command starts a new one.
 * - `retired`: a container was running for a different Agent or different
 *   grants, so it was destroyed before this turn could see it.
 */
export type WorkspaceTurnState = 'warm' | 'fresh' | 'retired';

export interface WorkspaceTurnDecision {
  state: WorkspaceTurnState;
  /**
   * Monthly session-cap reservation for the container this turn uses: the id
   * of the turn that started it. Warm follow-ups reuse it, so a conversation
   * counts once per container start rather than once per turn.
   */
  reservationId: string;
  /** The caller must destroy the running container before continuing. */
  retire: boolean;
  /**
   * A cold turn for the same owner whose last checkpoint has not expired. The
   * caller restores it when the turn first uses the workspace.
   */
  restorable: boolean;
}

interface WorkspaceCheckpoint {
  /** The Sandbox SDK's serializable backup handle. */
  backup: unknown;
  createdAt: number;
}

interface WorkspaceRecord {
  fingerprint: string;
  reservationId: string;
  checkpoint?: WorkspaceCheckpoint;
}

/**
 * The owner identity a warm workspace is bound to. The Sandbox DO is keyed by
 * Slack thread, not by Agent, so a thread handed to another Agent, or an Agent
 * whose repository grants changed, must never inherit the prior checkout.
 */
export function workspaceFingerprint(
  agentId: string,
  grants: readonly RepositoryGrant[],
): string {
  const scopes = validEnabledRepositoryGrants(grants)
    .map((grant) =>
      JSON.stringify([
        grant.installationId,
        grant.accountLogin.toLowerCase(),
        grant.fullName.toLowerCase(),
        grant.allRepos === true,
      ]),
    )
    .sort();
  return JSON.stringify({ v: 1, agentId, scopes });
}

/**
 * Durable per-thread workspace record kept in the Sandbox DO's storage, which
 * survives container sleep and destroy. Target-neutral so the reuse and
 * retirement rules are unit-testable without the Workers runtime.
 */
export class SandboxWorkspaceState {
  constructor(private readonly storage: SandboxPolicyStorage) {}

  async beginTurn(input: {
    fingerprint: string;
    turnId: string;
    containerRunning: boolean;
    now: number;
  }): Promise<WorkspaceTurnDecision> {
    const record = await this.record();
    const sameOwner = record?.fingerprint === input.fingerprint;
    if (input.containerRunning && sameOwner && record) {
      return {
        state: 'warm',
        reservationId: record.reservationId,
        retire: false,
        restorable: false,
      };
    }
    // A running container without a matching record belongs to another owner
    // or predates this record. Fail closed: retire it rather than guess. A
    // changed owner also drops the checkpoint, so it can never be restored.
    const retire = input.containerRunning;
    const checkpoint =
      !retire && sameOwner && record?.checkpoint && !checkpointExpired(record.checkpoint, input.now)
        ? record.checkpoint
        : undefined;
    await this.storage.put<WorkspaceRecord>(SANDBOX_WORKSPACE_STORAGE_KEY, {
      fingerprint: input.fingerprint,
      reservationId: input.turnId,
      ...(checkpoint ? { checkpoint } : {}),
    });
    return {
      state: retire ? 'retired' : 'fresh',
      reservationId: input.turnId,
      retire,
      restorable: checkpoint !== undefined,
    };
  }

  /** Attach a new checkpoint to the current owner's record. */
  async recordCheckpoint(backup: unknown, now: number): Promise<void> {
    const record = await this.record();
    if (!record) return;
    await this.storage.put<WorkspaceRecord>(SANDBOX_WORKSPACE_STORAGE_KEY, {
      ...record,
      checkpoint: { backup, createdAt: now },
    });
  }

  /**
   * The backup handle to restore, re-checked against the owner at restore
   * time so a handoff that interleaved since `beginTurn` gets nothing.
   */
  async checkpointForRestore(fingerprint: string, now: number): Promise<unknown> {
    const record = await this.record();
    if (!record || record.fingerprint !== fingerprint || !record.checkpoint) return undefined;
    if (checkpointExpired(record.checkpoint, now)) return undefined;
    return record.checkpoint.backup;
  }

  /** Whether the current owner has an unexpired checkpoint. Reads storage only. */
  async hasCheckpoint(fingerprint: string, now: number): Promise<boolean> {
    return (await this.checkpointForRestore(fingerprint, now)) !== undefined;
  }

  /** Forget the checkpoint so a discarded workspace can never be restored. */
  async dropCheckpoint(): Promise<void> {
    const record = await this.record();
    if (!record?.checkpoint) return;
    const { checkpoint: _dropped, ...rest } = record;
    await this.storage.put<WorkspaceRecord>(SANDBOX_WORKSPACE_STORAGE_KEY, rest);
  }

  private async record(): Promise<WorkspaceRecord | undefined> {
    const stored = await this.storage.get<unknown>(SANDBOX_WORKSPACE_STORAGE_KEY);
    return isWorkspaceRecord(stored) ? stored : undefined;
  }
}

function checkpointExpired(checkpoint: WorkspaceCheckpoint, now: number): boolean {
  return now - checkpoint.createdAt >= WORKSPACE_CHECKPOINT_TTL_SECONDS * 1000;
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorkspaceRecord>;
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.reservationId === 'string' &&
    candidate.reservationId.length > 0 &&
    (candidate.checkpoint === undefined ||
      (typeof candidate.checkpoint === 'object' &&
        candidate.checkpoint !== null &&
        typeof candidate.checkpoint.createdAt === 'number'))
  );
}
