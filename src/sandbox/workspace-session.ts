import type { Sandbox } from '@flue/runtime';

import type { RepositoryGrant } from '../config/types.ts';
import type { SandboxCredentialMode, SandboxEgressPolicyInput } from './cloudflare-policy.ts';
import { validEnabledRepositoryGrants } from './egress-handler.ts';
import { SandboxSessionCapError } from './errors.ts';
import {
  acquireSandbox,
  serializeSandboxActivation,
  type DestroyableSandbox,
} from './lifecycle.ts';
import { sandboxThreadKey } from './thread-key.ts';
import { requireSandboxTurnId, type SandboxTurnContext } from './turn-context.ts';
import {
  WORKSPACE_DIR,
  workspaceFingerprint,
  type WorkspaceTurnState,
} from './workspace-lifecycle.ts';

/** The one workspace a conversation has until named workspaces exist. */
export const DEFAULT_WORKSPACE_NAME = 'main';

/**
 * The Sandbox Durable Object id of a conversation's default workspace. It is
 * the thread key the attached container has always used, so warm containers
 * and checkpoints carry over unchanged when tools address the workspace.
 */
export function defaultWorkspaceId(conversationKey: string): string {
  return sandboxThreadKey(conversationKey);
}

/** What the Sandbox DO reports about a workspace without starting a container. */
export type WorkspaceDescription = {
  running: boolean;
  hasCheckpoint: boolean;
};

/** The Sandbox DO surface a workspace session drives. */
export interface WorkspaceSandboxStub extends DestroyableSandbox, SandboxTurnContext {
  exists(path: string): Promise<unknown>;
  configureEgress(input: SandboxEgressPolicyInput, turnId: string): Promise<void>;
  beginWorkspaceTurn(input: {
    fingerprint: string;
    turnId: string;
  }): Promise<{ state: WorkspaceTurnState; reservationId: string; restorable: boolean }>;
  restoreWorkspace(fingerprint: string): Promise<'restored' | 'unavailable'>;
  describeWorkspace(fingerprint: string): Promise<WorkspaceDescription>;
  discardWorkspace(): Promise<void>;
}

/**
 * How this request found the workspace. `restored` means a cold workspace
 * whose checkpoint is brought back on first use; the others follow
 * {@link WorkspaceTurnState}.
 */
export type WorkspaceOpenState = 'warm' | 'fresh' | 'restored' | 'retired';

export interface WorkspaceSessionOptions<TStub extends WorkspaceSandboxStub> {
  id: string;
  name: string;
  agentId: string;
  grants: readonly RepositoryGrant[];
  credentialMode?: SandboxCredentialMode;
  /** Mint a fresh DO stub. Never cached across acquisitions: stubs are bound to one I/O context. */
  mintStub: () => Promise<TStub>;
  /** Reserve one counted container start; false when the monthly cap refuses it. */
  reserveSession: (reservationId: string) => Promise<boolean>;
  /** Wrap the activatable stub into a Flue Sandbox (Workers-only import stays with the caller). */
  toSandbox: (stub: TStub) => Promise<Sandbox>;
}

/**
 * One request's handle on one coding workspace. Opening it prepares Durable
 * Object state only (turn binding, owner check, egress grants); the first
 * file or exec operation is the container-create boundary, where the session
 * cap is reserved and a checkpoint is restored. Every consumer this request
 * (the attached container and the workspace tools) shares one activation, so
 * a checkpoint is restored and a session counted at most once.
 */
export class WorkspaceSession<TStub extends WorkspaceSandboxStub = WorkspaceSandboxStub> {
  readonly id: string;
  readonly name: string;
  private readonly fingerprint: string;
  private opened: Promise<{ stub: TStub; state: WorkspaceOpenState }> | undefined;
  private flueSandbox: Promise<Sandbox> | undefined;

  constructor(private readonly options: WorkspaceSessionOptions<TStub>) {
    this.id = options.id;
    this.name = options.name;
    this.fingerprint = workspaceFingerprint(options.agentId, options.grants);
  }

  /** Whether this request already opened the workspace. */
  get isOpen(): boolean {
    return this.opened !== undefined;
  }

  /** Prepare DO state for this request. Idempotent; never starts a container. */
  async open(): Promise<WorkspaceOpenState> {
    return (await this.prepare()).state;
  }

  /**
   * The activatable stub: a proxy whose first file/exec operation reserves the
   * session and restores the checkpoint. The attached container wraps this.
   */
  async activatable(): Promise<TStub> {
    return (await this.prepare()).stub;
  }

  /** This request's own Flue Sandbox on the workspace (never the coordinator's). */
  async sandbox(): Promise<Sandbox> {
    this.flueSandbox ??= this.activatable().then((stub) => this.options.toSandbox(stub));
    try {
      return await this.flueSandbox;
    } catch (error) {
      this.flueSandbox = undefined;
      throw error;
    }
  }

  /** DO records only: running state and checkpoint presence. Starts nothing. */
  async describe(): Promise<WorkspaceDescription> {
    const stub = await this.options.mintStub();
    return stub.describeWorkspace(this.fingerprint);
  }

  /**
   * Destroy the container and drop its checkpoint. The next open in this
   * request starts fresh.
   */
  async discard(): Promise<void> {
    const stub = await this.options.mintStub();
    await stub.discardWorkspace();
    this.opened = undefined;
    this.flueSandbox = undefined;
  }

  private prepare(): Promise<{ stub: TStub; state: WorkspaceOpenState }> {
    this.opened ??= this.acquire().catch((error: unknown) => {
      this.opened = undefined;
      throw error;
    });
    return this.opened;
  }

  private async acquire(): Promise<{ stub: TStub; state: WorkspaceOpenState }> {
    const options = this.options;
    let reservationId: string | undefined;
    let decision: { state: WorkspaceTurnState; restorable: boolean } | undefined;
    const stub = await acquireSandbox(options.mintStub, async (candidate) => {
      const turnId = await requireSandboxTurnId(candidate);
      if (!options.credentialMode) {
        throw new Error('Sandbox repository credential mode is unavailable');
      }
      // Reuse or retire the warm workspace before this turn's grants are
      // installed, so a different Agent or changed grants never see the prior
      // checkout.
      const workspace = await candidate.beginWorkspaceTurn({
        fingerprint: this.fingerprint,
        turnId,
      });
      reservationId = workspace.reservationId;
      decision = { state: workspace.state, restorable: workspace.restorable };
      await candidate.configureEgress(
        { grants: validEnabledRepositoryGrants(options.grants), mode: options.credentialMode },
        turnId,
      );
    });
    const restorable = decision?.restorable === true;
    const activatable = serializeSandboxActivation(stub, WORKSPACE_DIR, async () => {
      if (!reservationId) {
        throw new Error('Sandbox turn context is unavailable at activation');
      }
      // Counted per container start: a warm follow-up carries the starting
      // turn's reservation and does not consume the cap again.
      if (!(await options.reserveSession(reservationId))) {
        throw new SandboxSessionCapError();
      }
      // A cold follow-up resumes from the thread's checkpoint. The restore
      // starts the container, so it happens only once the turn needs it.
      if (restorable) await stub.restoreWorkspace(this.fingerprint);
    });
    const state: WorkspaceOpenState = restorable ? 'restored' : decision?.state ?? 'fresh';
    return { stub: activatable, state };
  }
}
