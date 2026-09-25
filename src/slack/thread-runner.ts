import { getSandbox } from '@cloudflare/sandbox';
import { DurableObject } from 'cloudflare:workers';

import { activityStatus, isSafeTypedActivityStatus, type TypedActivityStatus } from '../activity/status.ts';
import { CfSlackStateStore, CfTurnJobsForRunner } from '../config/cf-state-proxies.ts';
import { getConfigStore, getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import { tagStateStub, type StateRpcResult } from '../config/state-rpc.ts';
import { cloudflareSandboxOptionVariants } from '../sandbox/lifecycle.ts';
import { reconnectingSandboxStub } from '../sandbox/reconnect.ts';
import { DoSqlStateDb } from '../state/do-state-db.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';
import {
  cacheSlackInstallationExecutionContexts,
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
  verifySlackInstallationTurnAccess,
} from './installation-execution.ts';
import { drainSlackPresentationRepairs } from './presentation-repair.ts';
import {
  SlackPresentationStateError,
  SlackRunPresentationStoreLogic,
  type SlackPresentationTransitionInput,
  type SlackPresentationTransitionResult,
  type SlackRunPresentation,
} from './run-presentations.ts';
import { repairSlackInteractionProgress, runTurn, sanitizeError } from './run-turn.ts';
import { SlackStatusRegistry } from './status-registry.ts';
import { ThreadRunnerJobStore, type ThreadRunnerJob, type ThreadRunnerStatus } from './thread-runner-jobs.ts';
import {
  THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS,
  runnerPresentationState,
  runnerSlackPort,
  runnerTurnJobsPort,
  runThreadRunnerAlarm,
} from './thread-runner-loop.ts';
import type { SlackThreadRunnerRpc, ThreadRunnerJobPayload } from './thread-runner-rpc.ts';
import { executeTurnJob, type SandboxTurnReader, type TurnExecutionPorts } from './turn-executor.ts';
import type { FlueObservationTarget } from './turn-job-types.ts';
import { MAX_TURN_DRAIN_BATCH } from './turn-jobs.ts';

/** The coding Sandbox readers of one thread (identical for both executors). */
export function sandboxTurnReaders(env: PlatformEnv): TurnExecutionPorts['sandboxes'] {
  return (sandboxKey) => {
    const binding = env.SANDBOX ?? env.Sandbox;
    if (!binding) return [];
    // A replaced Sandbox instance leaves a dead stub; reconnect instead.
    return cloudflareSandboxOptionVariants(sandboxKey).map((options) => () =>
      reconnectingSandboxStub(() => getSandbox(
        binding as Parameters<typeof getSandbox>[0],
        sandboxKey,
        options,
      )) as ReturnType<typeof getSandbox> & SandboxTurnReader);
  };
}

/**
 * Per-thread Slack turn runner (binding `SLACK_THREAD_RUNNER`, migration v11),
 * addressed by `idFromName(threadKey)`. With `SLACK_TAG_TURN_EXECUTOR=runner`
 * the state store's alarm hands each admitted turn here and returns; this
 * object executes its thread's turns in order (see thread-runner-loop.ts), so
 * a long turn in one thread never delays another thread. It keeps the turn's
 * Slack presentation and live status itself and writes each turn's outcome
 * back to the state store, which stays the record of truth for turn rows.
 * Jobs already handed here always finish here, whatever the switch says.
 */
export class SlackThreadRunner extends DurableObject implements SlackThreadRunnerRpc {
  private jobs: ThreadRunnerJobStore | undefined;
  private presentations: SlackRunPresentationStoreLogic | undefined;
  private readonly registry = new SlackStatusRegistry();
  /** Jobs an alarm returned without at its hard cap, still running here. */
  private readonly carried = new Map<string, Promise<void>>();
  /** Wakes a running alarm's drain when a job is admitted. */
  private wake: (() => void) | undefined;
  /** Observation targets of this runner's turns, one lookup per submission. */
  private readonly targets = new Map<string, FlueObservationTarget>();
  /** Consecutive failed alarms, for the retry backoff. */
  private readonly failures = { count: 0 };

  private store(): ThreadRunnerJobStore {
    this.jobs ??= new ThreadRunnerJobStore(new DoSqlStateDb(this.ctx.storage));
    return this.jobs;
  }

  private presentationStore(): SlackRunPresentationStoreLogic {
    this.presentations ??= new SlackRunPresentationStoreLogic(new DoSqlStateDb(this.ctx.storage));
    return this.presentations;
  }

  async admit(job: ThreadRunnerJob): Promise<{ admitted: boolean; refused?: string }> {
    const payload = (job?.payload ?? {}) as ThreadRunnerJobPayload;
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
    this.wake?.();
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > Date.now()) await this.ctx.storage.setAlarm(Date.now());
    return result;
  }

  async status(): Promise<ThreadRunnerStatus> {
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
    try {
      if (!isSafeTypedActivityStatus(status)) return { ok: true, value: null };
      const key = `${instanceId}\n${submissionId}`;
      let target = this.targets.get(key);
      if (!target) {
        target = await new CfSlackStateStore(tagStateStub(this.env as PlatformEnv))
          .matchFlueObservation(instanceId, submissionId);
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

  async presentationGet(runId: string): Promise<StateRpcResult<SlackRunPresentation | null>> {
    return presentationResult(() => this.presentationStore().get(runId) ?? null);
  }

  async presentationTransition(
    input: SlackPresentationTransitionInput,
  ): Promise<StateRpcResult<SlackPresentationTransitionResult>> {
    const result = presentationResult(() => this.presentationStore().transition(input));
    if (result.ok && result.value.outcome === 'applied') {
      // Keep the state store's readers current; best-effort like any publish.
      await new CfTurnJobsForRunner(tagStateStub(this.env as PlatformEnv))
        .putPresentation(result.value.presentation)
        .catch(() => console.warn('[chickpea] thread runner presentation publish failed'));
    }
    return result;
  }

  async alarm(): Promise<void> {
    let nextAlarmAt: number | undefined;
    try {
      nextAlarmAt = await this.runAlarm();
    } catch {
      // Setup failed before the loop could run: never throw, try again soon.
      console.warn('[chickpea] thread runner alarm could not start');
      nextAlarmAt = Date.now() + THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS;
    }
    if (nextAlarmAt !== undefined) await this.ctx.storage.setAlarm(nextAlarmAt);
    else await this.ctx.storage.deleteAlarm();
  }

  private async runAlarm(): Promise<number | undefined> {
    const env = this.env as PlatformEnv;
    const stub = tagStateStub(env);
    const rows = new CfTurnJobsForRunner(stub);
    const slack = new CfSlackStateStore(stub);
    const jobs = this.store();
    const local = this.presentationStore();
    const presentation = runnerPresentationState({
      local,
      remote: slack as Required<Pick<CfSlackStateStore, 'matchFlueObservation' | 'getLatestThreadSessionGeneration'>>,
      putRemote: (value) => rows.putPresentation(value),
    });
    // Resolved at most once per identity per alarm, so credential rotation
    // is observed by the next alarm.
    const resolveInstallation = cacheSlackInstallationExecutionContexts(
      (workspaceId) => resolveSlackInstallationExecutionContext(workspaceId, env),
    );
    const config = getConfigStore(env);
    const ports: TurnExecutionPorts = {
      env,
      turnJobs: runnerTurnJobsPort(rows, jobs),
      slack: runnerSlackPort({
        setActiveWork: (key, generation, active) => slack.setActiveWork(key, generation, active),
        markCodingActiveWork: (key, generation) => rows.markCodingActiveWork(key, generation),
        release: (key) => slack.release(key),
      }, jobs),
      config,
      presentationState: presentation.state,
      statusRegistry: this.registry,
      telemetry: createPlatformProductTelemetry({ env, settings: getSettingsStore(env), config }),
      resolveInstallation,
      sandboxes: sandboxTurnReaders(env),
      runTurn,
    };
    const result = await runThreadRunnerAlarm({
      jobs,
      turns: rows,
      execute: (job, control, onRetry, threadKey) => executeTurnJob(job, ports, {
        latency: { lane: 'cloudflare', executor: 'runner' },
        observationRoute: { executor: 'runner', runnerKey: threadKey },
        control,
        onRetry,
      }),
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
      clearActiveWork: (threadKey, jobId) => slack.setActiveWork(threadKey, jobId, false),
      failures: this.failures,
      afterJob: async (job) => {
        this.targets.clear();
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
      armBackstop: async (at) => {
        const existing = await this.ctx.storage.getAlarm();
        if (existing === null || existing > at) await this.ctx.storage.setAlarm(at);
      },
      carried: this.carried,
      onWake: (wake) => {
        this.wake = wake;
        return () => {
          if (this.wake === wake) this.wake = undefined;
        };
      },
    });
    return result.nextAlarmAt;
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
