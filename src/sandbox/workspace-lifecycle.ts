import type { RepositoryGrant } from '../config/types.ts';
import type { SandboxPolicyStorage } from './cloudflare-policy.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

const SANDBOX_WORKSPACE_STORAGE_KEY = 'chickpea.sandbox.workspace.v1';

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
}

interface WorkspaceRecord {
  fingerprint: string;
  reservationId: string;
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
  }): Promise<WorkspaceTurnDecision> {
    const stored = await this.storage.get<unknown>(SANDBOX_WORKSPACE_STORAGE_KEY);
    const record = isWorkspaceRecord(stored) ? stored : undefined;
    if (input.containerRunning && record?.fingerprint === input.fingerprint) {
      return { state: 'warm', reservationId: record.reservationId, retire: false };
    }
    // A running container without a matching record belongs to another owner
    // or predates this record. Fail closed: retire it rather than guess.
    const retire = input.containerRunning;
    await this.storage.put<WorkspaceRecord>(SANDBOX_WORKSPACE_STORAGE_KEY, {
      fingerprint: input.fingerprint,
      reservationId: input.turnId,
    });
    return {
      state: retire ? 'retired' : 'fresh',
      reservationId: input.turnId,
      retire,
    };
  }
}

function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorkspaceRecord>;
  return (
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.reservationId === 'string' &&
    candidate.reservationId.length > 0
  );
}
