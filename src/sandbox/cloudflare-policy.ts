import type {
  TurnProgress,
  TurnPullRequestProgress,
} from '../config/state-rpc.ts';
import type { RepositoryGrant } from '../config/types.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';

const SANDBOX_EGRESS_POLICY_STORAGE_KEY = 'chickpea.sandbox.egress-policy.v2';
const SANDBOX_TURN_ID_STORAGE_KEY = 'chickpea.sandbox.turn-id.v1';
const SANDBOX_TURN_PROGRESS_STORAGE_KEY = 'chickpea.sandbox.turn-progress.v1';

export type SandboxCredentialMode = 'app' | 'pat';

export interface SandboxEgressPolicy {
  grants: RepositoryGrant[];
  mode: SandboxCredentialMode | null;
}

export interface SandboxEgressPolicyInput {
  grants: readonly RepositoryGrant[];
  mode: SandboxCredentialMode;
}

export interface SandboxPolicyStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

const EMPTY_EGRESS_POLICY: SandboxEgressPolicy = {
  grants: [],
  mode: null,
};

/**
 * Durable policy and turn state shared by the Cloudflare Sandbox DO methods.
 * Kept target-neutral so mode-switch and cross-turn races are unit-testable
 * without importing the Workers runtime.
 */
export class SandboxPolicyState {
  constructor(private readonly storage: SandboxPolicyStorage) {}

  async prepareTurn(turnId: string): Promise<void> {
    const previousTurnId = await this.getTurnId();
    // Revoke the prior policy before current grants are resolved. The mode is
    // cleared with the grants so no credential can pair with stale scope.
    await this.storage.put(SANDBOX_EGRESS_POLICY_STORAGE_KEY, EMPTY_EGRESS_POLICY);
    await this.storage.put(SANDBOX_TURN_ID_STORAGE_KEY, turnId);
    if (previousTurnId !== turnId) {
      await this.storage.put<TurnProgress>(SANDBOX_TURN_PROGRESS_STORAGE_KEY, {});
    }
  }

  async configureEgress(
    input: SandboxEgressPolicyInput,
    turnId: string,
  ): Promise<void> {
    const policy: SandboxEgressPolicy = {
      grants: validEnabledRepositoryGrants(input.grants).map(copyRepositoryGrant),
      mode: input.mode,
    };
    await this.prepareTurn(turnId);
    await this.storage.put(SANDBOX_EGRESS_POLICY_STORAGE_KEY, policy);
  }

  async getEgressPolicy(): Promise<SandboxEgressPolicy> {
    const stored = await this.storage.get<unknown>(SANDBOX_EGRESS_POLICY_STORAGE_KEY);
    if (!isSandboxEgressPolicy(stored)) {
      return { ...EMPTY_EGRESS_POLICY, grants: [] };
    }
    return {
      grants: validEnabledRepositoryGrants(stored.grants).map(copyRepositoryGrant),
      mode: stored.mode,
    };
  }

  async getTurnId(): Promise<string | undefined> {
    return this.storage.get<string>(SANDBOX_TURN_ID_STORAGE_KEY);
  }

  async getTurnProgress(): Promise<TurnProgress> {
    return (
      (await this.storage.get<TurnProgress>(SANDBOX_TURN_PROGRESS_STORAGE_KEY)) ?? {}
    );
  }

  async recordPullRequestProgress(
    pullRequest: TurnPullRequestProgress,
    capturedTurnId: string,
  ): Promise<boolean> {
    if ((await this.getTurnId()) !== capturedTurnId) return false;
    const current = await this.getTurnProgress();
    if (current.pullRequest) return false;
    // Re-check after reading progress so a turn reset that interleaved at an
    // await boundary cannot receive the prior turn's late GitHub response.
    if ((await this.getTurnId()) !== capturedTurnId) return false;
    await this.storage.put<TurnProgress>(SANDBOX_TURN_PROGRESS_STORAGE_KEY, {
      ...current,
      pullRequest,
    });
    return true;
  }
}

/**
 * Bind policy to the live credential mode and mirror the worker-side PAT rule:
 * App-wide installation grants never authorize a PAT request.
 */
export function sandboxEgressGrantsForMode(
  policy: SandboxEgressPolicy,
  currentMode: SandboxCredentialMode,
): RepositoryGrant[] | undefined {
  if (policy.mode !== currentMode) return undefined;
  const grants = validEnabledRepositoryGrants(policy.grants);
  return currentMode === 'pat'
    ? grants.filter((grant) => grant.allRepos !== true)
    : grants;
}

function isSandboxEgressPolicy(value: unknown): value is SandboxEgressPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SandboxEgressPolicy>;
  if (
    candidate.mode !== null &&
    candidate.mode !== 'app' &&
    candidate.mode !== 'pat'
  ) {
    return false;
  }
  return (
    Array.isArray(candidate.grants) &&
    candidate.grants.every(isRepositoryGrant)
  );
}

function isRepositoryGrant(value: unknown): value is RepositoryGrant {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<RepositoryGrant>;
  return (
    typeof candidate.id === 'string' &&
    (typeof candidate.installationId === 'number' ||
      candidate.installationId === null) &&
    typeof candidate.accountLogin === 'string' &&
    typeof candidate.fullName === 'string' &&
    (candidate.allRepos === undefined ||
      typeof candidate.allRepos === 'boolean') &&
    typeof candidate.enabled === 'boolean'
  );
}

function copyRepositoryGrant(grant: RepositoryGrant): RepositoryGrant {
  return {
    id: grant.id,
    installationId: grant.installationId,
    accountLogin: grant.accountLogin,
    fullName: grant.fullName,
    ...(grant.allRepos === undefined ? {} : { allRepos: grant.allRepos }),
    enabled: grant.enabled,
  };
}
