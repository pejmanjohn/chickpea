import { getSandbox } from '@cloudflare/sandbox';
import { DurableObject } from 'cloudflare:workers';

import { activityStatus, isSafeTypedActivityStatus, type TypedActivityStatus } from '../activity/status.ts';
import { CfTurnJobsForRunner } from '../config/cf-state-proxies.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getIdentityStore,
  getSettingsStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { SlackPublicContextEntryInput } from '../config/types.ts';
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
  THREAD_RUNNER_BACKSTOP_MS,
  THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS,
  runnerPresentationState,
  runnerSlackPort,
  runnerTurnJobsPort,
  runThreadRunnerAlarm,
} from './thread-runner-loop.ts';
import type {
  RunnerTurnBegin,
  SlackThreadRunnerRpc,
  ThreadRunnerJobPayload,
} from './thread-runner-rpc.ts';
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
  /** The loop running now (from the alarm or an admission), single-flight. */
  private running: Promise<void> | undefined;
  /** Work arrived while the loop was finishing: run it once more. */
  private runAgain = false;

  constructor(...args: ConstructorParameters<typeof DurableObject>) {
    super(...args);
    // A job still marked running means the previous instance stopped mid-turn
    // (a code update, an eviction): resume now, not at the next backstop.
    void this.ctx.blockConcurrencyWhile(async () => {
      if (!this.store().hasRunning()) return;
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > Date.now()) await this.ctx.storage.setAlarm(Date.now());
    });
  }

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
    // Start at once in this request instead of waiting for the alarm to fire;
    // the alarm, armed a few seconds out, is the durable backstop.
    const backstop = Date.now() + THREAD_RUNNER_BACKSTOP_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > backstop) await this.ctx.storage.setAlarm(backstop);
    this.wake?.();
    void this.runSoon();
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

  async presentationGet(runId: string): Promise<StateRpcResult<SlackRunPresentation | null>> {
    return presentationResult(() => this.presentationStore().get(runId) ?? null);
  }

  async presentationTransition(
    input: SlackPresentationTransitionInput,
  ): Promise<StateRpcResult<SlackPresentationTransitionResult>> {
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
    await this.runSoon();
  }

  /**
   * Run the loop once, or join the run in progress and run once more after
   * it (work may have arrived after its last listing). Never throws.
   */
  private runSoon(): Promise<void> {
    if (this.running) {
      this.runAgain = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.runAgain = false;
        let nextAlarmAt: number | undefined;
        try {
          nextAlarmAt = await this.runAlarm();
        } catch {
          // Setup failed before the loop could run: try again soon.
          console.warn('[chickpea] thread runner alarm could not start');
          nextAlarmAt = Date.now() + THREAD_RUNNER_FAILURE_BACKOFF_MAX_MS;
        }
        try {
          if (nextAlarmAt !== undefined) await this.ctx.storage.setAlarm(nextAlarmAt);
          else await this.ctx.storage.deleteAlarm();
        } catch {
          // The instance is being replaced; its successor resumes the job.
        }
      } while (this.runAgain);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The state store, over a fresh stub per call (see CfTurnJobsForRunner). */
  private stateStore(): CfTurnJobsForRunner {
    const env = this.env as PlatformEnv;
    return new CfTurnJobsForRunner(() => tagStateStub(env));
  }

  private async runAlarm(): Promise<number | undefined> {
    const env = this.env as PlatformEnv;
    const rows = this.stateStore();
    const jobs = this.store();
    const local = this.presentationStore();
    const presentation = runnerPresentationState({
      local,
      remote: rows,
      putRemote: (value) => rows.putPresentation(value),
    });
    // Resolved at most once per identity per alarm, so credential rotation
    // is observed by the next alarm. A turn's own resolution reuses what its
    // `begin` round trip already read (the installation, gateway settings).
    const installations = new Map<string, RunnerTurnBegin>();
    const resolveInstallation = cacheSlackInstallationExecutionContexts((workspaceId) => {
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
        credentialDependencies: { state: getIdentityStore(env), env },
      });
    });
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
      turnJobs: runnerTurnJobsPort(rows, jobs),
      slack: runnerSlackPort({
        setActiveWork: (key, generation, active) => rows.setActiveWork(key, generation, active),
        markCodingActiveWork: (key, generation) => rows.markCodingActiveWork(key, generation),
        release: (key) => rows.release(key),
      }, jobs),
      config,
      presentationState: presentation.state,
      statusRegistry: this.registry,
      telemetry: createPlatformProductTelemetry({
        env,
        settings: getSettingsStore(env),
        config: getConfigStore(env),
      }),
      resolveInstallation,
      sandboxes: sandboxTurnReaders(env),
      runTurn,
    };
    const result = await runThreadRunnerAlarm({
      jobs,
      turns: rows,
      execute: (job, control, onRetry, threadKey, start) => {
        installations.set(job.turn.workspaceId, start);
        return executeTurnJob(job, ports, {
          latency: { lane: 'cloudflare', executor: 'runner' },
          observationRoute: { executor: 'runner', runnerKey: threadKey },
          control,
          onRetry,
        });
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
