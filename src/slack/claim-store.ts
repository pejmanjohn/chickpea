import { openStateDb, type NodeStateDb } from '../state/node-state-db.ts';
import type { StateDb } from '../state/state-db.ts';
import { WorkStoreLogic } from '../work/store.ts';
import type { AdmitShadowRunInput, ShadowRunAdmission } from '../work/types.ts';
import type {
  SlackInteractionProgressPatch,
  SlackRuntimeDrainCounts,
  SlackTurnRecoveryItem,
} from '../config/state-rpc.ts';
import { TurnJobStoreLogic, type PendingTurnJob } from './turn-jobs.ts';
import type { TurnJob } from './turn-job-types.ts';
import type {
  FlueDispatchReceiptV1,
  FlueObservationTarget,
  FlueSettlementCheckpointV1,
  FlueTurnObservationV1,
  FrozenRuntimePlanDecision,
  SlackAgentBinding,
  SlackAgentBindingExpectation,
} from './turn-job-types.ts';
import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import type { SlackInteractionIntent } from './interaction-intent.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackAppendReservation,
  type SlackPresentationActivity,
  type SlackPresentationOwner,
  type SlackPresentationTransitionInput,
  type SlackPresentationTransitionResult,
  type SlackPresentationSummary,
  type SlackPresentationRoot,
  type SlackRunPresentation,
} from './run-presentations.ts';
import { localSlackStateStore } from './local-state-store.ts';
import { ACTIVE_WORK_TTL_MS, CLAIM_TTL_MS, THREAD_TTL_MS } from './state-limits.ts';
import { slackTimestampUnits } from './thread-context.ts';

export { ACTIVE_WORK_TTL_MS, CLAIM_TTL_MS, THREAD_TTL_MS } from './state-limits.ts';

export interface SlackCanonicalAdmissionInput {
  evtKey: string;
  msgKey: string;
  threadKey: string;
  admission: AdmitShadowRunInput;
  turnJob?: TurnJob;
  presentation?: {
    schemaVersion: 3;
    root: SlackPresentationRoot;
    owner: SlackPresentationOwner;
    sessionGeneration: number;
    currentActivity?: SlackPresentationActivity;
    taskLabels?: readonly string[];
  };
}

export function slackSessionGenerationFromTimestamp(messageTs: string): number {
  if (!/^\d+\.\d{6}$/.test(messageTs)) {
    throw new Error('Slack session generation requires a microsecond timestamp.');
  }
  const units = slackTimestampUnits(messageTs);
  if (units === null || units < 1n || units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Slack session generation exceeds the safe integer range.');
  }
  return Number(units);
}

export function selectSlackPresentationOwner(input: {
  installationHealth: 'pending' | 'healthy' | 'needs_attention' | 'revoked';
  agentId: string;
  agentName: string;
  avatarUrl?: string;
  slackPresence?: {
    desiredState: 'unpublished' | 'active' | 'disabled';
    health: 'unpublished' | 'pending' | 'healthy' | 'needs_attention';
    avatar: { revision: number };
  };
}): SlackPresentationOwner {
  if (input.agentId === CHICKPEA_AGENT_ID) return { kind: 'chickpea' };
  const presence = input.slackPresence;
  if (
    input.installationHealth !== 'healthy' ||
    !input.avatarUrl ||
    !presence ||
    presence.desiredState !== 'active' ||
    presence.health !== 'healthy' ||
    !Number.isSafeInteger(presence.avatar.revision) ||
    presence.avatar.revision < 1
  ) {
    return { kind: 'chickpea' };
  }
  return {
    kind: 'selected_agent',
    persona: {
      name: input.agentName,
      avatarUrl: input.avatarUrl,
      avatarRevision: presence.avatar.revision,
    },
  };
}

export type SlackCanonicalAdmissionResult =
  | { claimed: false }
  | { claimed: true; admission: ShadowRunAdmission };

/**
 * Application-owned duplicate-admission store.
 *
 * `@flue/slack` deliberately does NOT dedupe Events API retries or the
 * app_mention + message fan-out (Slack delivers both for a single mention).
 * The channel claims each event before dispatch and releases on failure so a
 * Slack retry can re-drive the turn.
 *
 * All public store interfaces are async: the Node backend answers from local
 * SQLite (the awaits resolve immediately), while the Cloudflare backend calls
 * into a Durable Object over RPC. Consumers are written against the async
 * shape so the two backends are interchangeable.
 */
export interface SlackClaimStore {
  /** Resolves true if the key was newly claimed; false if it was already held. */
  claim(key: string): Promise<boolean>;
  /** Release a previously claimed key so a retry can re-claim it. */
  release(key: string): Promise<void>;
}

/**
 * Registry of thread keys this app has actively started (via a mention or DM).
 * It gates implicit thread replies: a reply whose thread was never started is
 * ignored (scenario S13).
 */
export interface SlackThreadRegistry {
  /** Mark a thread key as started so its later implicit replies are admitted. */
  start(key: string): Promise<void>;
  /** True if a mention/DM already started this thread. */
  has(key: string): Promise<boolean>;
  isActiveWork(key: string): Promise<boolean>;
  setActiveWork(key: string, generation: string, active: boolean): Promise<void>;
}

/** The combined claims + thread-registry surface the Slack channel consumes. */
export interface SlackStateStore extends SlackClaimStore, SlackThreadRegistry {
  admitCanonical(input: SlackCanonicalAdmissionInput): Promise<SlackCanonicalAdmissionResult>;
  /** Node fallback when Slack truth cannot authorize a canonical Work/Run. */
  enqueueTurn?(job: TurnJob): Promise<boolean>;
  resumeTurnAfterOAuth?(originalTaskId: string, continuationId: string): Promise<boolean>;
  pinAgentBinding(
    input: SlackAgentBinding,
    expected?: SlackAgentBindingExpectation,
  ): Promise<SlackAgentBinding>;
  getAgentBinding(continuityKey: string): Promise<SlackAgentBinding | undefined>;
  runtimeDrainCounts(): Promise<SlackRuntimeDrainCounts>;
  countPendingDeliveriesForWorkspace(workspaceId: string): Promise<number>;
  /** Node-only durable legacy relay operations; Cloudflare owns these in its DO alarm. */
  listPendingTurns?(): Promise<PendingTurnJob[]>;
  getPendingTurnByRunId?(runId: string): Promise<PendingTurnJob | undefined>;
  freezeRuntimePlan?(
    id: string,
    candidate: RuntimePlanV2,
  ): Promise<FrozenRuntimePlanDecision>;
  prepareFlueDispatch?(
    id: string,
    message: string,
    observation: FlueTurnObservationV1,
  ): Promise<import('./turn-job-types.ts').FlueDispatchEnvelopeV1>;
  reconcileFlueExistingInstance?(
    id: string,
    uid: string,
  ): Promise<import('./turn-job-types.ts').FlueDispatchEnvelopeV1>;
  recordFlueReceipt?(id: string, receipt: FlueDispatchReceiptV1): Promise<FlueDispatchReceiptV1>;
  recordFlueSettlement?(
    id: string,
    settlement: FlueSettlementCheckpointV1,
  ): Promise<FlueSettlementCheckpointV1>;
  matchFlueObservation?(
    instanceId: string,
    submissionId?: string,
  ): Promise<FlueObservationTarget | undefined>;
  recordTurnAttempt?(id: string, attempts: number): Promise<void>;
  recordInteractionIntent?(id: string, intent: SlackInteractionIntent): Promise<void>;
  recordSlackInteractionProgress?(
    id: string,
    patch: SlackInteractionProgressPatch,
  ): Promise<void>;
  listPendingSlackInteractionCleanups?(): Promise<PendingTurnJob[]>;
  hasPendingSlackInteractionCleanup?(): Promise<boolean>;
  markTurnDelivered?(id: string): Promise<void>;
  markTurnError?(id: string): Promise<void>;
  markTurnRecoveryRequired?(id: string, reason: string): Promise<void>;
  listTurnRecoveryRequired?(limit?: number): Promise<SlackTurnRecoveryItem[]>;
  retrySlackInstallationRecovery?(workspaceId: string): Promise<number>;
  resolveTurnRecoveryRequired?(id: string): Promise<boolean>;
  getRunPresentation?(runId: string): Promise<SlackRunPresentation | undefined>;
  getLatestThreadSessionGeneration?(
    root: Pick<SlackPresentationRoot, 'workspaceId' | 'channelId' | 'threadTs'>,
  ): Promise<number | undefined>;
  transitionRunPresentation?(
    input: SlackPresentationTransitionInput,
  ): Promise<SlackPresentationTransitionResult>;
  reserveSlackAppend?(workspaceId: string): Promise<SlackAppendReservation>;
  applySlackAppendCooldown?(
    workspaceId: string,
    retryAfterMs: number,
  ): Promise<{ cooldownUntil: number; budgetVersion: number }>;
  reserveSlackActivityStatus?(workspaceId: string): Promise<SlackAppendReservation>;
  applySlackActivityStatusCooldown?(
    workspaceId: string,
    retryAfterMs: number,
  ): Promise<{ cooldownUntil: number; budgetVersion: number }>;
  listRunPresentationsForRepair?(limit?: number): Promise<SlackRunPresentation[]>;
  maintainRunPresentations?(
    limit?: number,
  ): Promise<{ finalizedPurged: number; expiredTombstoned: number }>;
  summarizeRunPresentations?(workspaceId: string): Promise<SlackPresentationSummary>;
  discardTurn?(id: string): Promise<boolean>;
  /** Node backend only (closes the SQLite handle); absent on RPC proxies. */
  close?(): void;
}

// Orphan claims expire after Slack's redelivery horizon. Claims referenced by
// a nonterminal TurnJob or pending Slack cleanup are retained for that durable
// owner's full lifetime, including recovery-required rows beyond 30 days.
// Joined threads stay continuable for much longer, but not forever — expiring
// them bounds the table and matches how stale a weeks-old thread really is. A
// thread's config snapshot is bounded to the same horizon (see snapshot-store):
// past it, an implicit reply is no longer admitted, so the snapshot is dead.

/**
 * Target-neutral claims + thread-registry logic over the StateDb
 * mini-interface: the single source of the tables, TTL purges, and the
 * INSERT OR IGNORE claim semantics. The Node backend runs it over
 * `node:sqlite`; the Cloudflare Durable Object runs the same class over
 * `ctx.storage.sql`. Methods are synchronous — both backends execute SQL
 * synchronously — and the async public interface wraps them.
 */
export class SlackStateLogic {
  private turnJobsAvailable = false;

  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    // One statement per exec: DO SQLite rejects multi-statement strings.
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_claims (key TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_threads (key TEXT PRIMARY KEY, started_at INTEGER NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS slack_active_work (key TEXT NOT NULL, generation TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, generation))',
    );
  }

  claim(key: string): boolean {
    this.purgeExpired();
    const inserted = this.db.run(
      'INSERT OR IGNORE INTO slack_claims (key, claimed_at) VALUES (?, ?)',
      key,
      this.now(),
    );
    return inserted.changes === 1;
  }

  release(key: string): void {
    this.db.run('DELETE FROM slack_claims WHERE key = ?', key);
  }

  start(key: string): void {
    this.db.run('INSERT OR REPLACE INTO slack_threads (key, started_at) VALUES (?, ?)', key, this.now());
  }

  has(key: string): boolean {
    const row = this.db.get(
      'SELECT started_at FROM slack_threads WHERE key = ? AND started_at >= ?',
      key,
      this.now() - THREAD_TTL_MS,
    );
    return row !== undefined;
  }

  isActiveWork(key: string): boolean {
    const row = this.db.get(
      'SELECT updated_at FROM slack_active_work WHERE key = ? AND updated_at >= ?',
      key,
      this.now() - ACTIVE_WORK_TTL_MS,
    );
    return row !== undefined;
  }

  setActiveWork(key: string, generation: string, active: boolean): void {
    if (!active) {
      this.db.run(
        'DELETE FROM slack_active_work WHERE key = ? AND generation = ?',
        key,
        generation,
      );
      return;
    }
    this.db.run(
      'INSERT OR REPLACE INTO slack_active_work (key, generation, updated_at) VALUES (?, ?, ?)',
      key,
      generation,
      this.now(),
    );
  }

  admitCanonical(
    input: SlackCanonicalAdmissionInput,
    work: WorkStoreLogic,
    turnJobs?: TurnJobStoreLogic,
    presentations?: SlackRunPresentationStoreLogic,
  ): SlackCanonicalAdmissionResult {
    return this.db.transaction(() => {
      if (!this.claim(input.evtKey)) return { claimed: false };
      if (!this.claim(input.msgKey)) {
        this.release(input.evtKey);
        return { claimed: false };
      }
      const admission = work.admitShadowRunInTransaction(input.admission);
      this.start(input.threadKey);
      if (input.turnJob && turnJobs) {
        const jobAuthority = input.turnJob.executionAuthority ?? 'legacy';
        if (
          input.turnJob.runId !== admission.run.id ||
          jobAuthority !== admission.run.executionAuthority
        ) {
          throw new Error('Turn job authority does not match its canonical Run.');
        }
        turnJobs.enqueue(input.turnJob);
      }
      if (input.presentation) {
        if (!input.turnJob || !presentations) {
          throw new Error('Slack presentation requires its canonical TurnJob owner.');
        }
        presentations.createInTransaction({
          schemaVersion: 3,
          runId: admission.run.id,
          turnJobId: input.turnJob.id,
          bindingId: admission.binding.id,
          workBindingGeneration: admission.binding.generation,
          runFencingToken: admission.run.fencingToken,
          root: input.presentation.root,
          owner: input.presentation.owner,
          sessionGeneration: input.presentation.sessionGeneration,
          ...(input.presentation.currentActivity
            ? { currentActivity: input.presentation.currentActivity }
            : {}),
          ...(input.presentation.taskLabels
            ? { taskLabels: input.presentation.taskLabels }
            : {}),
        });
      }
      return { claimed: true, admission };
    });
  }

  private purgeExpired(): void {
    // A nonterminal TurnJob (including delivered work with pending adapter
    // cleanup) keeps all three admission claims alive. Expiring one would let
    // a late Slack redelivery create a second TurnJob while the original still
    // owns an unread Flue receipt or external cleanup.
    this.turnJobsAvailable ||= this.db.get(
      "SELECT 1 AS available FROM sqlite_master WHERE type = 'table' AND name = 'turn_jobs'",
    ) !== undefined;
    if (this.turnJobsAvailable) {
      this.db.run(
        `DELETE FROM slack_claims
         WHERE claimed_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM turn_jobs
             WHERE (
               turn_jobs.evt_key = slack_claims.key OR
               turn_jobs.msg_key = slack_claims.key OR
               'decision:' || turn_jobs.msg_key = slack_claims.key
             )
             AND (
               turn_jobs.delivered = 0 OR
               turn_jobs.progress_json LIKE '%"cleanup":"pending"%'
             )
           )`,
        this.now() - CLAIM_TTL_MS,
      );
    } else {
      this.db.run(
        'DELETE FROM slack_claims WHERE claimed_at < ?',
        this.now() - CLAIM_TTL_MS,
      );
    }
    this.db.run('DELETE FROM slack_threads WHERE started_at < ?', this.now() - THREAD_TTL_MS);
    this.db.run(
      'DELETE FROM slack_active_work WHERE updated_at < ?',
      this.now() - ACTIVE_WORK_TTL_MS,
    );
  }
}

/**
 * SQLite-backed claims + thread registry so dedupe and joined-thread admission
 * survive a process restart — the durability class `db.node.ts` already gives the
 * agent transcript. Lives in its OWN database file (not the Flue transcript
 * DB) so the app never contends with the runtime's connection. `:memory:`
 * yields a per-process store with the exact pre-durability semantics — the
 * parity suite and offline harnesses rely on that isolation.
 */
export interface SqliteSlackStateStore extends SlackStateStore {
  close(): void;
}

export class SqliteSlackStateStore {
  private readonly db: NodeStateDb;

  constructor(path: string, now: () => number = Date.now) {
    this.db = openStateDb(path);
    const slack = new SlackStateLogic(this.db, now);
    const turnJobs = new TurnJobStoreLogic(this.db, now);
    const presentations = new SlackRunPresentationStoreLogic(this.db, now);
    const work = new WorkStoreLogic(this.db, { now });
    Object.assign(this, localSlackStateStore({ slack, work, turnJobs, presentations }));
  }

  close(): void {
    this.db.close();
  }
}
