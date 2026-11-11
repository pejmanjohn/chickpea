import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { withAgentAppExecution } from './agent-apps/index.ts';
import { activityStatus, isSafeTypedActivityStatus, type TypedActivityStatus } from '../activity/status.ts';
import { CfTurnJobsForRunner } from '../config/cf-state-proxies.ts';
import { cloudflareWorkerVersionId } from '../config/cloudflare-version.ts';
import { assertInstallationOwnership, deploymentTenancy, objectInstallationEnv } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  getSlackStateStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { SlackPublicContextEntryInput } from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import { tagStateStub, type StateRpcResult } from '../config/state-rpc.ts';
import { withTurnReads } from '../config/turn-reads.ts';
import {
  cloudflareCodingWorkerStopClient,
  stopCodingTasks,
  threadCodingTaskStopPorts,
} from '../sandbox/coding-task-stop.ts';
import { sandboxTurnReaders } from '../sandbox/sandbox-object.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import { DoSqlStateDb } from '../state/do-state-db.ts';
import { ResidencyHold, residencyHoldMs } from '../state/residency-hold.ts';
import {
  objectHostFunctions,
  type InstallationObjectHostRpc,
  type ObjectExportRequest,
  type ObjectHostRequest,
  type ObjectRestoreBookmarksRequest,
  type ObjectRestoreRequest,
  type ObjectRestoreRestartRequest,
} from '../state/object-host.ts';
import { RunnerBootMarks, type TurnLatencyContext } from '../observability/runtime-latency.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';
import {
  cacheSlackInstallationExecutionContexts,
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
  seedGatewayIdentity,
  verifySlackInstallationTurnAccess,
} from './installation-execution.ts';
import { resolveSlackPublicUrl } from './credentials.ts';
import { abortSlackThreadAgent } from './flue-dispatch.ts';
import { parseMidRunReplyRequest, type MidRunReplyOutcome, type MidRunReplyRequest } from './midrun-reply.ts';
import { drainSlackPresentationRepairs } from './presentation-repair.ts';
import {
  SlackPresentationStateError,
  SlackRunPresentationStoreLogic,
  type SlackPresentationTransitionInput,
  type SlackPresentationTransitionResult,
  type SlackRunPresentation,
} from './run-presentations.ts';
import { repairSlackInteractionProgress, runTurn, sanitizeError, startEarlyJudgment } from './run-turn.ts';
import { SlackStatusRegistry, type SlackRunFactsView } from './status-registry.ts';
import {
  quiesceThreadRunnerForRestore,
  ThreadRunnerJobStore,
  type ThreadRunnerJob,
  type ThreadRunnerStatus,
} from './thread-runner-jobs.ts';
import {
  runnerLoopScheduler,
  createRunnerSupersedeState,
  type RunnerSupersedeState,
  type ThreadRunnerAlarmResult,
  runnerPresentationState,
  runnerSlackPort,
  runnerTurnJobsPort,
  runThreadRunnerAlarm,
} from './thread-runner-loop.ts';
import { parseAdmissionAgentWake, type AdmissionAgentWake } from './admission-agent-wake.ts';
import { parseAdmissionStatusMark } from './admission-activity.ts';
import { RunnerStops, runnerStopRecorded } from './runner-stops.ts';
import type {
  RunnerTurnBegin,
  SlackThreadRunnerRpc,
  ThreadRunnerJobPayload,
} from './thread-runner-rpc.ts';
import { executeTurnJob, type TurnExecutionPorts } from './turn-executor.ts';
import { processSlackAgentAsks, processSlackFrontDeskHandoff } from '../channels/slack.ts';
import type { FlueObservationTarget, TurnStopNotice } from './turn-job-types.ts';
import { MAX_TURN_DRAIN_BATCH } from './turn-jobs.ts';

/**
 * The longest a receipt wake counts toward the next hand-off's
 * `runnerWakeLeadMs`: an older wake belongs to a delivery that became no turn.
 * Also how long a turn's first attempt trusts the wake admission sent its
 * Agent object.
 */
const RUNNER_WAKE_LEAD_WINDOW_MS = 60_000;

/** What a hand-off tells its turn's first attempt for `turn_latency`. */
type HandoffLatency = Pick<TurnLatencyContext, 'handoffMs' | 'runnerWakeLeadMs' | 'admissionStatusMs' | 'admissionStatusAt'>;

/**
 * Per-thread Slack turn runner (binding `SLACK_THREAD_RUNNER`, migration v11),
 * addressed by `idFromName(threadKey)`. By default (unless the emergency gate
 * `SLACK_TAG_TURN_EXECUTOR=alarm` is set) the state store's alarm hands each
 * admitted turn here and returns; this
 * object executes its thread's turns in order (see thread-runner-loop.ts), so
 * a long turn in one thread never delays another thread. It keeps the turn's
 * Slack presentation and live status itself and writes each turn's outcome
 * back to the state store, which stays the record of truth for turn rows.
 * Jobs already handed here always finish here, whatever the switch says.
 */
export class SlackThreadRunner extends DurableObject implements SlackThreadRunnerRpc, InstallationObjectHostRpc {
  /** This activation's `runner_boot` marks; every entry point reports its call first. */
  private readonly boot = new RunnerBootMarks();
  /**
   * Hand-off delays of the jobs this activation admitted (`admit` start minus
   * the state store's send time), how long before the hand-off the state
   * store woke this activation, its status write before the hand-off, and the
   * wake it sent the turn's Agent object, by job id, until the job's first
   * attempt here takes its own.
   */
  private readonly handoffs = new Map<string, HandoffLatency & {
    handoffMs: number;
    agentWake?: AdmissionAgentWake;
  }>();
  /** The state store's send time of the last receipt wake this activation served, until a hand-off counts it. */
  private wokenAt: number | undefined;
  private jobs: ThreadRunnerJobStore | undefined;
  private presentations: SlackRunPresentationStoreLogic | undefined;
  /**
   * Its turns' live status; run facts outlive an eviction in this object's
   * storage. Replaced when the runner is erased.
   */
  private registry = this.statusRegistry();
  /** Jobs an alarm returned without at its hard cap, still running here. */
  private readonly carried = new Map<string, Promise<void>>();
  /** Wakes a running alarm's drain when a job is admitted. */
  private wakeDrain: (() => void) | undefined;
  /** Observation targets of this runner's turns, one lookup per submission. */
  private readonly targets = new Map<string, FlueObservationTarget>();
  /** Consecutive failed alarms, for the retry backoff. */
  private readonly failures = { count: 0 };
  /** Whether a code update replaced this instance's version (see RunnerSupersedeState). */
  private readonly supersede: RunnerSupersedeState = createRunnerSupersedeState();
  /** The stops of this runner's turns (see RunnerStops). */
  private stopHandling: RunnerStops | undefined;
  /** Keeps this runner in memory for the deployment's hold window after a person's turn ends here. */
  private readonly conversationHold = new ResidencyHold(residencyHoldMs(this.env as PlatformEnv));
  /** Runs the loop, one at a time, from the alarm or an admission. */
  private readonly runSoon = runnerLoopScheduler({
    runOnce: () => this.runAlarm(),
    arm: async (nextAlarmAt) => {
      if (nextAlarmAt !== undefined) await this.ctx.storage.setAlarm(nextAlarmAt);
      else await this.ctx.storage.deleteAlarm();
    },
  });

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, objectInstallationEnv(ctx, env));
    // A job still marked running means the previous instance stopped mid-turn
    // (a code update, an eviction): resume now, not at the next backstop. So
    // does a stop whose abort or coding cascade is still owed.
    void this.ctx.blockConcurrencyWhile(async () => {
      try {
        // A runner never handed a job (one a receipt woke) has no tables, and
        // this check creates none.
        if (!ThreadRunnerJobStore.existsIn(new DoSqlStateDb(this.ctx.storage))) return;
        if (!this.store().hasRunning() && !this.store().hasOwedStops()) return;
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > Date.now()) await this.ctx.storage.setAlarm(Date.now());
      } catch {
        // The 5 s backstop armed while the job ran still brings it back.
      } finally {
        this.boot.constructed();
      }
    });
  }

  private store(): ThreadRunnerJobStore {
    this.jobs ??= new ThreadRunnerJobStore(new DoSqlStateDb(this.ctx.storage));
    return this.jobs;
  }

  private statusRegistry(): SlackStatusRegistry {
    return new SlackStatusRegistry({
      runFacts: {
        load: (id) => this.store().runFacts(id),
        save: (id, facts) => this.store().saveRunFacts(id, facts),
      },
    });
  }

  /**
   * This runner's stops: the host abort goes to the turn's Flue coordinator
   * instance, and the coding cascade to the coding workers its task records
   * name (none where no Sandbox binding exists, so no coding job can).
   */
  private stops(): RunnerStops {
    const env = this.env as PlatformEnv;
    this.stopHandling ??= new RunnerStops({
      jobs: this.store(),
      abortHost: (target) => abortSlackThreadAgent(target),
      ...(env.SANDBOX ?? env.Sandbox
        ? {
            stopCodingTasks: (notice: TurnStopNotice) => stopCodingTasks(threadCodingTaskStopPorts({
              sandboxes: sandboxTurnReaders(env),
              // The stopped run's Sandbox: a guest's own, else the thread's.
              turnSandboxKey: notice.guestSandboxKey ?? sandboxThreadKey(notice.runnerKey),
              hostTurnId: notice.turnJobId,
              workers: cloudflareCodingWorkerStopClient(env),
            })),
          }
        : {}),
    });
    return this.stopHandling;
  }

  private presentationStore(): SlackRunPresentationStoreLogic {
    this.presentations ??= new SlackRunPresentationStoreLogic(new DoSqlStateDb(this.ctx.storage));
    return this.presentations;
  }

  /**
   * The state store's wake at a delivery's receipt: it activates this runner
   * while the turn is admitted, so the hand-off finds it in memory. It only
   * reports the activation and keeps the send time for that hand-off's lead;
   * it writes nothing, and runs no job or alarm.
   */
  async wake(sentAt: number, turnJobId?: string): Promise<void> {
    this.boot.call('wake', { sentAt, turnJobId });
    this.wokenAt = sentAt;
  }

  async admit(job: ThreadRunnerJob): Promise<{ admitted: boolean; refused?: string }> {
    const sentAt = job?.sentAt;
    this.boot.call('admit', { sentAt, turnJobId: job?.id });
    const enteredAt = Date.now();
    try {
      assertInstallationOwnership(job?.installation, this.env as PlatformEnv);
    } catch {
      console.warn('[chickpea] thread runner refused a turn of another installation');
      return { admitted: false, refused: 'installation_mismatch' };
    }
    const payload = (job?.payload ?? {}) as ThreadRunnerJobPayload;
    // Only after the ownership check: this installation's identity, checked
    // again against the runner's own reads when the turn resolves it.
    seedGatewayIdentity(payload.gatewayIdentity);
    // The presentation first: the job never runs here without its copy.
    if (payload.presentation) {
      try {
        this.presentationStore().putSnapshot(payload.presentation);
      } catch {
        console.warn('[chickpea] thread runner could not import a turn presentation');
        return { admitted: false, refused: 'presentation_import_failed' };
      }
    }
    const result = this.store().admit({ ...job, payload: {} }, Date.now());
    if (result.admitted && sentAt !== undefined) {
      const lead = this.wokenAt === undefined ? undefined : sentAt - this.wokenAt;
      this.wokenAt = undefined;
      const agentWake = parseAdmissionAgentWake(payload.agentWake);
      const admissionStatus = parseAdmissionStatusMark(payload.admissionStatus);
      this.handoffs.set(job.id, {
        handoffMs: enteredAt - sentAt,
        ...(lead !== undefined && lead >= 0 && lead <= RUNNER_WAKE_LEAD_WINDOW_MS ? { runnerWakeLeadMs: lead } : {}),
        ...(admissionStatus ? { admissionStatusMs: admissionStatus.waitedMs } : {}),
        ...(admissionStatus?.shownAt === undefined ? {} : { admissionStatusAt: admissionStatus.shownAt }),
        ...(agentWake ? { agentWake } : {}),
      });
    }
    // The turn runs in this object's alarm, never in the admitting request.
    // Work left running after that request returns belongs to no invocation:
    // its logs are dropped, objects it creates are bound to a closed request,
    // and nothing retries it when the object is replaced. The alarm is due
    // now (an earlier one is kept); a running alarm's drain takes the job at
    // once.
    this.wakeDrain?.();
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > Date.now()) await this.ctx.storage.setAlarm(Date.now());
    return result;
  }

  /**
   * A stop of one of this runner's turns, from the state store's stop outbox
   * (KTD2). The stop is persisted and the turn's Flue instance aborted here
   * (a single request, while its submission is unsettled, whose answer the
   * RPC awaits for a short bound only); the turn is never unwound and its
   * observation is never touched: the running alarm's live observation
   * reads the `aborted` settlement. Everything else (a repeated abort, the
   * coding cascade, the stopped path of a turn between alarms or not yet
   * dispatched) runs in this object's alarm, made due now as `admit` does,
   * so the outbox is never held for the up to 14 s a coding cascade can take.
   */
  async stop(notice: TurnStopNotice): Promise<{ acknowledged: boolean }> {
    this.boot.call('stop');
    let taken: { acknowledged: boolean; wake: boolean };
    try {
      taken = await this.stops().receive(notice);
    } catch {
      console.warn('[chickpea] thread runner could not take a stop yet');
      return { acknowledged: false };
    }
    if (taken.wake) {
      this.wakeDrain?.();
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > Date.now()) await this.ctx.storage.setAlarm(Date.now());
    }
    return { acknowledged: taken.acknowledged };
  }

  async status(): Promise<ThreadRunnerStatus> {
    this.boot.call('status');
    return this.store().status();
  }

  /**
   * Activity the agent observed for one of this runner's turns, landing in
   * the registry where the running turn registered its status presenter.
   * Best-effort like the state store's: a miss is a success.
   */
  async observedStatus(
    instanceId: string,
    submissionId: string,
    status: TypedActivityStatus,
  ): Promise<StateRpcResult<null>> {
    this.boot.call('observedStatus');
    try {
      if (!isSafeTypedActivityStatus(status)) return { ok: true, value: null };
      const key = `${instanceId}\n${submissionId}`;
      let target = this.targets.get(key);
      if (!target) {
        target = await this.stateStore().matchFlueObservation(instanceId, submissionId);
        if (!target) return { ok: true, value: null };
        if (this.targets.size >= 32) this.targets.clear();
        this.targets.set(key, target);
      }
      this.registry.setObservedStatus(
        instanceId,
        target.generation,
        activityStatus(status.kind, status.action, status.object, status.family, status.phase),
      );
    } catch {
      // A dropped status update never fails a turn.
    }
    return { ok: true, value: null };
  }

  /**
   * A reply the Agent wrote mid-run for one of this runner's turns, posted
   * by the turn's presenter through the registry it registered in.
   */
  async midRunReply(
    instanceId: string,
    submissionId: string,
    request: MidRunReplyRequest,
  ): Promise<MidRunReplyOutcome> {
    this.boot.call('midRunReply');
    const parsed = parseMidRunReplyRequest(request);
    if (!parsed) return { posted: false, refusal: 'unavailable' };
    try {
      const target = await this.stateStore().matchFlueObservation(instanceId, submissionId);
      if (!target) return { posted: false, refusal: 'unavailable' };
      return await this.registry.midRunReply(instanceId, target.generation, parsed);
    } catch {
      return { posted: false, refusal: 'failed' };
    }
  }

  /**
   * The run facts of one of this runner's turns, for a check-in answered at
   * admission (KTD8): its live status turn's, or those saved here before an
   * eviction. Reading them never touches the run. Null when the turn has not
   * started here.
   */
  async runFacts(turnJobId: string): Promise<StateRpcResult<SlackRunFactsView | null>> {
    this.boot.call('runFacts');
    try {
      return { ok: true, value: this.registry.runFactsView(turnJobId) ?? null };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async presentationGet(runId: string): Promise<StateRpcResult<SlackRunPresentation | null>> {
    this.boot.call('presentationGet');
    return presentationResult(() => this.presentationStore().get(runId) ?? null);
  }

  async presentationTransition(
    input: SlackPresentationTransitionInput,
  ): Promise<StateRpcResult<SlackPresentationTransitionResult>> {
    this.boot.call('presentationTransition');
    const result = presentationResult(() => this.presentationStore().transition(input));
    if (result.ok && result.value.outcome === 'applied') {
      // Keep the state store's readers current; best-effort like any publish.
      await this.stateStore()
        .putPresentation(result.value.presentation)
        .catch(() => console.warn('[chickpea] thread runner presentation publish failed'));
    }
    return result;
  }

  async alarm(): Promise<void> {
    this.boot.call('alarm');
    await this.runSoon();
  }

  // ── host functions (installation tenancy; see state/installation-objects.ts) ──

  async chickpeaHostExportPage(request: ObjectExportRequest) {
    return this.host().chickpeaHostExportPage(request);
  }

  async chickpeaHostRestoreBookmarks(request: ObjectRestoreBookmarksRequest) {
    return this.host().chickpeaHostRestoreBookmarks(request);
  }

  async chickpeaHostRestore(request: ObjectRestoreRequest) {
    return this.host().chickpeaHostRestore(request);
  }

  async chickpeaHostRestoreRestart(request: ObjectRestoreRestartRequest) {
    return this.host().chickpeaHostRestoreRestart(request);
  }

  /**
   * Delete every table, key-value entry and the alarm of this runner. It must
   * be the runner's last contact: any later call, an admission or a host
   * function, creates its job tables again, empty.
   */
  async chickpeaHostErase(request: ObjectHostRequest) {
    return this.host().chickpeaHostErase(request);
  }

  /** Settle every open job not running without running it, report the running ones, and clear the alarm. */
  async chickpeaHostCancelPendingWork(request: ObjectHostRequest) {
    return this.host().chickpeaHostCancelPendingWork(request);
  }

  private host(): InstallationObjectHostRpc {
    this.boot.call('host');
    return objectHostFunctions({
      env: this.env as PlatformEnv,
      storage: this.ctx.storage,
      restoreContext: this.ctx,
      // Nothing of the erased runner stays in memory: its stores, its turns'
      // live status, their observation targets and the jobs it carried.
      onErased: () => {
        this.jobs = undefined;
        this.presentations = undefined;
        this.stopHandling = undefined;
        this.registry = this.statusRegistry();
        this.targets.clear();
        this.carried.clear();
        this.handoffs.clear();
      },
      cancel: (now) => {
        const { settled, running } = this.store().cancelOpen(now);
        return { runnerJobs: settled, runnerJobsRunning: running };
      },
      // What its constructor resumes on waking would move the storage before a restore is scheduled.
      quiesce: async () => quiesceThreadRunnerForRestore(this.store()),
    });
  }

  /**
   * A job's hand-off delay and wake lead for its `turn_latency`, and the wake
   * admission sent its Agent object, once: a later attempt of the job carries
   * none. An Agent object woken longer ago than the window may have been
   * evicted since, so its turn's freeze wakes it again.
   */
  private takeHandoff(jobId: string): {
    latency: HandoffLatency;
    agentWake?: AdmissionAgentWake;
  } {
    const handoff = this.handoffs.get(jobId);
    this.handoffs.delete(jobId);
    if (!handoff) return { latency: {} };
    const { agentWake, ...latency } = handoff;
    return agentWake && Date.now() - agentWake.sentAt <= RUNNER_WAKE_LEAD_WINDOW_MS
      ? { latency, agentWake }
      : { latency };
  }

  /** The state store, over a fresh stub per call (see CfTurnJobsForRunner). */
  private stateStore(): CfTurnJobsForRunner {
    const env = this.env as PlatformEnv;
    return new CfTurnJobsForRunner(() => tagStateStub(env));
  }

  private async runAlarm(): Promise<ThreadRunnerAlarmResult> {
    const env = this.env as PlatformEnv;
    const versionId = cloudflareWorkerVersionId(env);
    const rows = this.stateStore();
    const jobs = this.store();
    const local = this.presentationStore();
    const presentation = runnerPresentationState({
      local,
      remote: rows,
      putRemote: (value) => rows.putPresentation(value),
      ...(deploymentTenancy(env) === 'installation' ? { sharedSlackReads: getSlackStateStore(env) } : {}),
    });
    // Resolved at most once per identity per alarm, so credential rotation
    // is observed by the next alarm. A turn's own resolution reuses what its
    // `begin` round trip already read (the installation, gateway settings).
    const installations = new Map<string, RunnerTurnBegin>();
    const resolveInstallation = withAgentAppExecution(cacheSlackInstallationExecutionContexts((workspaceId) => {
      const start = installations.get(workspaceId);
      const settings = getSettingsStore(env);
      return resolveSlackInstallationExecutionContext(workspaceId, env, {
        config: {
          getWorkspaceInstallation: async (id) =>
            start?.installation?.workspaceId === id
              ? start.installation
              : getConfigStore(env).getWorkspaceInstallation(id),
        },
        settings: start ? prefetchedSettings(settings, start.settings) : settings,
        credentialDependencies: {
          state: start?.slackCredentials
            ? prefetchedCredentials(getIdentityStore(env), start.slackCredentials)
            : getIdentityStore(env),
          env,
        },
      });
    }), env);
    const config = {
      // Thread context for a delivered message; the answer is already out,
      // so a store that cannot be reached only loses this context entry.
      putSlackPublicContext: async (input: SlackPublicContextEntryInput) =>
        rows.putSlackPublicContext(input).catch(() => {
          console.warn('[chickpea] thread runner could not record thread context');
          return undefined as never;
        }),
    };
    const ports: TurnExecutionPorts = {
      env,
      turnJobs: runnerTurnJobsPort(rows, jobs, Date.now, this.stops()),
      slack: runnerSlackPort({
        setActiveWork: (key, generation, active) => rows.setActiveWork(key, generation, active),
        markCodingActiveWork: (key, generation) => rows.markCodingActiveWork(key, generation),
        isCodingActiveWork: (key, generation) => rows.isCodingActiveWork(key, generation),
        release: (key) => rows.release(key),
        noteFrontDeskHandoff: (note) => rows.noteFrontDeskHandoff(note),
      }, jobs),
      config,
      presentationState: presentation.state,
      statusRegistry: this.registry,
      telemetry: createPlatformProductTelemetry({
        env,
        settings: getSettingsStore(env),
        config: getConfigStore(env),
      }),
      // The state store applies an approval against its own management
      // stores; this runner holds none. One RPC per approval, never replayed.
      invokeManagementApproval: (request) => tagStateStub(env).slackManagementApprovalInvoke(request),
      resolveInstallation,
      sandboxes: sandboxTurnReaders(env),
      // Admitted here like a Worker admits a Slack event, into this thread's
      // queue: the asked Agent answers after this turn.
      dispatchAgentAsks: (request) => processSlackAgentAsks(request, env),
      dispatchFrontDeskHandoff: (request) => processSlackFrontDeskHandoff(request, env),
      runTurn,
      startJudgment: startEarlyJudgment,
    };
    const result = await runThreadRunnerAlarm({
      jobs,
      turns: rows,
      execute: async (job, control, onRetry, threadKey, start) => {
        installations.set(job.turn.workspaceId, start);
        // What the turn reads before its first Slack status, answered from
        // the same `begin` round trip where it could be.
        presentation.seedLatestThreadSessionGeneration(job.runId, start.latestThreadSessionGeneration);
        const publicUrl = await resolveSlackPublicUrl(
          env,
          prefetchedSettings(getSettingsStore(env), start.settings),
        ).then((value) => value ?? null, () => undefined);
        const handoff = this.takeHandoff(job.id);
        // The turn's first reads, in one round beside its fold claim.
        const reads = await import('./turn-plan-reads.ts').then(
          ({ prefetchTurnReads }) => prefetchTurnReads(env, job, job.runId ? runBindingId(local, job.runId) : undefined),
          () => undefined,
        );
        return withTurnReads(reads, () => executeTurnJob(job, ports, {
          latency: { lane: 'cloudflare', executor: 'runner', ...handoff.latency },
          ...(handoff.agentWake ? { agentWake: handoff.agentWake } : {}),
          observationRoute: { executor: 'runner', runnerKey: threadKey },
          control,
          onRetry,
          ...(publicUrl === undefined ? {} : { publicUrl }),
          runReviewSettings: prefetchedSettings(getSettingsStore(env), start.settings),
          // A stopped turn's note reports its coding workers' confirmation.
          codingStopReport: () => this.stops().codingReport(job.id),
          // R22: a stop this runner took, else one its notice has not brought yet.
          stopRecorded: () => runnerStopRecorded(jobs, rows, job.id),
        }));
      },
      repairInteraction: async (job) => {
        const progress = job.progress.slackInteraction;
        if (!progress) return;
        const installation = await resolveInstallation(effectiveTurnSlackInstallationId(job.turn));
        await verifySlackInstallationTurnAccess(installation, job.turn);
        await repairSlackInteractionProgress(
          job.turn,
          job.assignment,
          progress,
          installation.client,
          (patch) => rows.recordSlackInteractionProgress(job.id, patch),
        );
      },
      // The active-work key is the thread key this runner is addressed by.
      clearActiveWork: (threadKey, jobId) => rows.setActiveWork(threadKey, jobId, false),
      failures: this.failures,
      supersede: this.supersede,
      stops: this.stops(),
      ...(versionId ? { versionId } : {}),
      afterJob: async (job) => {
        this.targets.clear();
        // As the state store's window: a person's turn, not an Agent's ask or a setup wake.
        if (!job.turn.agentAsk && !job.turn.setupWake) this.conversationHold.holdFrom(Date.now());
        await presentation.publish(job.runId);
      },
      repair: () => drainSlackPresentationRepairs({
        presentations: local.listAutoRepairableV3(MAX_TURN_DRAIN_BATCH),
        state: presentation.state,
        resolveClient: async (workspaceId) => (await resolveInstallation(workspaceId)).client,
        onFailure: (_presentation, error) => {
          console.warn('[chickpea] Slack presentation repair failed:', sanitizeError(error));
        },
      }).finally(() => {
        local.maintain(100);
      }),
      // Keep a wake `at` or sooner in the future; a wake already due is
      // pushed forward, since this run is the one it would start.
      armBackstop: async (at) => {
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing <= Date.now() || existing > at) {
          await this.ctx.storage.setAlarm(at);
        }
      },
      carried: this.carried,
      onWake: (wake) => {
        this.wakeDrain = wake;
        return () => {
          if (this.wakeDrain === wake) this.wakeDrain = undefined;
        };
      },
    });
    return result;
  }
}

function runBindingId(store: SlackRunPresentationStoreLogic, runId: string): string | undefined {
  try {
    return store.get(runId)?.bindingId;
  } catch {
    return undefined;
  }
}

/** Run one presentation store call as an RPC result, typed like the state store's. */
function presentationResult<T>(fn: () => T): StateRpcResult<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    if (error instanceof SlackPresentationStateError) {
      return {
        ok: false,
        error: {
          code: 'slack_presentation',
          message: error.message,
          details: { presentationCode: error.code },
        },
      };
    }
    return {
      ok: false,
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

function prefetchedCredentials(
  store: IdentityStore,
  read: NonNullable<RunnerTurnBegin['slackCredentials']>,
): IdentityStore {
  return Object.assign(Object.create(store) as IdentityStore, {
    getSlackCredentialControl: async (installationId?: string) =>
      installationId === undefined ? read.control ?? undefined : store.getSlackCredentialControl(installationId),
    getActiveSlackCredentialRevision: async (identityId: string) =>
      identityId === read.identityId ? read.active ?? undefined : store.getActiveSlackCredentialRevision(identityId),
  });
}

/** A settings store that answers the given keys from a read already made. */
function prefetchedSettings(
  store: SettingsStore,
  values: Record<string, string | null>,
): SettingsStore {
  const has = (key: string) => Object.hasOwn(values, key);
  return {
    getSetting: async (key) => (has(key) ? values[key] ?? undefined : store.getSetting(key)),
    getSettings: async (keys) =>
      keys.every(has) ? keys.map((key) => values[key] ?? undefined) : store.getSettings(keys),
    setSetting: (key, value) => store.setSetting(key, value),
    deleteSetting: (key) => store.deleteSetting(key),
    applySettingsPatch: (patch) => store.applySettingsPatch(patch),
    mergeSettingStringSet: (key, merged) => store.mergeSettingStringSet(key, merged),
  };
}
