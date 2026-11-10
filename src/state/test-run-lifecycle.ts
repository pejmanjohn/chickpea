/**
 * The state store's side of a test run (U6a §3.2): admission and dispatch
 * in one call, then the settle step, which alone addresses the run's
 * instance. The alarm, the caller's polls and a cancellation pass all run
 * it; one step per run at a time, and none once the instance is erased.
 */
import { deriveRuntimePlanInstanceId, parseRuntimePlanV2 } from '../agents/runtime-plan.ts';
import type { CreditBackReason } from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type {
  TestRunFailure,
  TestRunQuery,
  TestRunReplayQuery,
  TestRunRow,
  TestRunSettlement,
  TestRunStartRequest,
  TestRunStartResult,
  TestRunView,
} from '../management/test-run-types.ts';
import type { TestRunStoreLogic } from '../management/test-runs.ts';
import type { ChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { TestRunUsageRecorder } from '../usage/test-run-usage.ts';
import type { UsageStoreLogic } from '../usage/store.ts';
import { opaqueId } from '../work/admission.ts';

/** Admitted with no submission this long: the dispatch never landed, as far as the store knows. */
export const TEST_RUN_DISPATCH_GRACE_MS = 30_000;
/** The store aborts a run still unsettled this long after admission, past Flue's own 120 s. */
export const TEST_RUN_ABORT_AFTER_MS = 125_000;
/** The store fails a run still unsettled this long after admission, whatever the instance reports. */
export const TEST_RUN_DEADLINE_MS = 150_000;
/** The erase waits for the instance to settle no longer than this after admission. */
export const TEST_RUN_FORCED_ERASE_MS = 10 * 60_000;
/** Each dispatch, abort, settlement read and erase is one request to the instance. */
export const TEST_RUN_INSTANCE_CALL_MS = 10_000;

export interface TestRunDispatch {
  message: string;
  initialData: unknown;
  /** The run's ID: a replayed dispatch returns the original receipt. */
  idempotencyKey: string;
}

/** What the run's instance says of its submission. */
export type TestRunInstanceSettlement =
  | { kind: 'unsettled' }
  /** No instance, or no stream: counted as settled, with nothing to read. */
  | { kind: 'not_found' }
  | { kind: 'answered'; reply: string; read: string[]; metadata?: ChickpeaResponseMetadata }
  | {
      kind: 'failed';
      failure: Extract<TestRunFailure, 'deadline' | 'out_of_usage' | 'daily_limit' | 'failed'>;
      resumesAt?: number;
      creditBack: CreditBackReason | null;
    };

/** The run's instance, as only the state store addresses it. */
export interface TestRunInstancePort {
  dispatch(instanceId: string, dispatch: TestRunDispatch): Promise<{ submissionId: string }>;
  /** Aborts the instance's running and queued submissions. Not found counts as done. */
  abort(instanceId: string): Promise<void>;
  /** `plan`: the run's plan while the row still holds it, to name the services a reply read. */
  settlement(instanceId: string, submissionId: string, plan: unknown): Promise<TestRunInstanceSettlement>;
  erase(instanceId: string): Promise<void>;
  /** Credits a failure that is Chickpea's back to the plan, as a direct message's is. */
  creditBack(submissionId: string, reason: CreditBackReason): Promise<void>;
}

export type TestRunStepMode = 'due' | 'cancel';

export interface TestRunPassResult {
  /** Runs whose instance this pass erased. */
  erased: number;
  /** Runs still not erased after the pass, settled or not. */
  unerased: number;
}

export interface TestRunLifecycleDependencies {
  stores: () => { testRuns: TestRunStoreLogic; usage: Pick<UsageStoreLogic, 'getOperation'> };
  /** Loaded at its first use: it carries the test agent's dispatch path. */
  port: () => Promise<TestRunInstancePort>;
  /** Arms the store's alarm no later than `at`. */
  armAlarm: (at: number) => Promise<void>;
  now?: () => number;
  platformEnv?: PlatformEnv;
}

export class TestRunLifecycle {
  /** The step going for each run; another caller joins it. */
  private readonly steps = new Map<string, Promise<TestRunRow | undefined>>();
  /** Runs this instance asked Flue to abort. A restart forgets them, and the next step asks again. */
  private readonly aborted = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: TestRunLifecycleDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Admission, then the dispatch, in one call: no other run can start
   * between them. The row's plan is the creation data's, and it must name
   * this run, so its instance is the run's own and never another's. A
   * dispatch that throws leaves the run `admitted` for the 30-second rule;
   * one that landed binds its submission at its first model request anyway.
   */
  async start(request: TestRunStartRequest): Promise<TestRunStartResult> {
    const { testRuns } = this.deps.stores();
    const plan = parseRuntimePlanV2(request.initialData.runtimePlan);
    const { conversation } = plan;
    if (conversation.surface !== 'test' ||
        conversation.continuityKey !== opaqueId('agent', `test:${request.run.testRunId}`) ||
        conversation.channelId !== `test_${request.run.coordinateToken}`) {
      throw new Error('A test run must run its own test run plan.');
    }
    // A run that has finished but that no one has read yet must not hold the lock.
    for (const row of testRuns.unerased()) {
      if (row.organizationId === request.run.organizationId && live(row)) await this.step(row.testRunId);
    }
    const at = this.now();
    const admission = testRuns.admit({
      ...request.run,
      instanceId: deriveRuntimePlanInstanceId(plan),
      planJson: JSON.stringify(request.initialData.runtimePlan),
    }, at);
    if (admission.kind === 'replayed') return { kind: 'replayed', run: testRunView(await this.settled(admission.row)) };
    if (admission.kind !== 'admitted') return admission;
    await this.deps.armAlarm(this.deps.stores().testRuns.nextDueAt(at) ?? at);
    const { row } = admission;
    try {
      const receipt = await bounded((await this.deps.port()).dispatch(row.instanceId, {
        message: request.message,
        initialData: request.initialData,
        idempotencyKey: row.testRunId,
      }));
      testRuns.recordSubmission(row.testRunId, receipt.submissionId);
    } catch (error) {
      log('test_run_dispatch_failed', row, error);
    }
    return { kind: 'admitted', run: testRunView(testRuns.get(row.testRunId) ?? row) };
  }

  async replay(query: TestRunReplayQuery): Promise<TestRunView | undefined> {
    const row = this.deps.stores().testRuns.findByIdempotencyKey(query.actorMembershipId, query.idempotencyKey);
    if (!row || row.organizationId !== query.organizationId) return undefined;
    const read = this.deps.stores().testRuns.read({ ...query, runToken: row.runToken }, this.now());
    return read ? testRunView(await this.settled(read)) : undefined;
  }

  async observe(query: TestRunQuery): Promise<TestRunView | undefined> {
    const row = this.deps.stores().testRuns.read(query, this.now());
    return row ? testRunView(await this.settled(row)) : undefined;
  }

  /** A caller's read runs the run's step and re-arms the alarm, which a cancellation deletes. */
  private async settled(row: TestRunRow): Promise<TestRunRow> {
    const stepped = row.erasedAt === null ? await this.step(row.testRunId) ?? row : row;
    const due = this.nextDueAt();
    if (due !== undefined) await this.deps.armAlarm(due);
    return stepped;
  }

  /** One settle step for one run; a call while one is going joins it, and a cancellation runs its own after. */
  step(testRunId: string, mode: TestRunStepMode = 'due'): Promise<TestRunRow | undefined> {
    const going = this.steps.get(testRunId);
    if (going && mode === 'due') return going;
    const step = (going ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(() => this.runStep(testRunId, mode))
      .finally(() => {
        if (this.steps.get(testRunId) === step) this.steps.delete(testRunId);
      });
    this.steps.set(testRunId, step);
    return step;
  }

  /** A step for every run not yet erased, oldest first. */
  async pass(mode: TestRunStepMode = 'due'): Promise<TestRunPassResult> {
    let erased = 0;
    let unerased = 0;
    for (const { testRunId } of this.deps.stores().testRuns.unerased()) {
      let row: TestRunRow | undefined;
      try {
        row = await this.step(testRunId, mode);
      } catch (error) {
        log('test_run_step_failed', { testRunId }, error);
        row = this.deps.stores().testRuns.get(testRunId);
      }
      if (row && row.erasedAt === null) unerased += 1;
      else erased += 1;
    }
    return { erased, unerased };
  }

  /** The alarm's next look while any run is not erased. */
  nextDueAt(): number | undefined {
    return this.deps.stores().testRuns.nextDueAt(this.now());
  }

  private async runStep(testRunId: string, mode: TestRunStepMode): Promise<TestRunRow | undefined> {
    const { testRuns } = this.deps.stores();
    let row = testRuns.get(testRunId);
    if (!row || row.erasedAt !== null) return row;
    const now = this.now();
    const age = now - row.createdAt;
    let probe: TestRunInstanceSettlement | undefined;
    if (live(row)) {
      if (row.submissionId === null) {
        if (mode === 'cancel') await this.force(row, 'cancelled', now);
        else if (age >= TEST_RUN_DISPATCH_GRACE_MS) await this.force(row, 'not_dispatched', now);
      } else {
        if (mode === 'cancel' || age >= TEST_RUN_ABORT_AFTER_MS) await this.abortOnce(row);
        probe = await this.probe(row);
        if (probe.kind !== 'unsettled') await this.settleFromInstance(row, probe, now, mode);
        else if (mode === 'cancel') await this.force(row, 'cancelled', now);
        else if (age >= TEST_RUN_DEADLINE_MS) await this.force(row, 'deadline', now);
      }
      row = testRuns.get(testRunId);
      if (!row || live(row)) return row;
    }
    if (await this.eraseReady(row, probe, now)) await this.erase(row);
    return testRuns.get(testRunId);
  }

  /**
   * The instance has settled or is gone, or the forced bound has passed. A
   * run whose instance never reported settled is aborted first; with no
   * submission to read, an answered abort settles everything it held.
   */
  private async eraseReady(row: TestRunRow, probe: TestRunInstanceSettlement | undefined, now: number): Promise<boolean> {
    if (now - row.createdAt >= TEST_RUN_FORCED_ERASE_MS) {
      log('test_run_forced_erase', row);
      return true;
    }
    if (row.submissionId === null) return this.abortOnce(row);
    let settled = probe ?? await this.probe(row);
    if (settled.kind !== 'unsettled') return true;
    if (!await this.abortOnce(row)) return false;
    settled = await this.probe(row);
    return settled.kind !== 'unsettled';
  }

  private async erase(row: TestRunRow): Promise<void> {
    try {
      await bounded((await this.deps.port()).erase(row.instanceId));
      this.deps.stores().testRuns.markErased(row.testRunId, this.now());
    } catch (error) {
      log('test_run_erase_failed', row, error);
    }
  }

  /** True once this instance's abort was answered, now or earlier. */
  private async abortOnce(row: TestRunRow): Promise<boolean> {
    if (this.aborted.has(row.testRunId)) return true;
    try {
      await bounded((await this.deps.port()).abort(row.instanceId));
      this.aborted.add(row.testRunId);
      return true;
    } catch (error) {
      log('test_run_abort_failed', row, error);
      return false;
    }
  }

  private async probe(row: TestRunRow): Promise<TestRunInstanceSettlement> {
    if (row.submissionId === null) return { kind: 'unsettled' };
    try {
      return await bounded((await this.deps.port()).settlement(row.instanceId, row.submissionId, planOf(row)));
    } catch (error) {
      log('test_run_settlement_unread', row, error);
      return { kind: 'unsettled' };
    }
  }

  private async settleFromInstance(
    row: TestRunRow,
    settled: Exclude<TestRunInstanceSettlement, { kind: 'unsettled' }>,
    now: number,
    mode: TestRunStepMode,
  ): Promise<void> {
    const usage = this.recorder(row);
    const billing = row.submissionId;
    let settlement: TestRunSettlement;
    let creditBack: CreditBackReason | null = null;
    if (settled.kind === 'answered') {
      settlement = {
        status: 'answered',
        result: { reply: settled.reply, read: settled.read },
        terminal: usage.completed(settled.metadata, now, billing),
      };
    } else if (settled.kind === 'not_found') {
      const failure = now - row.createdAt >= TEST_RUN_DEADLINE_MS ? 'deadline' : 'failed';
      settlement = {
        status: 'failed',
        failure,
        terminal: failure === 'deadline' ? usage.interrupted(now, billing) : usage.failed(now, billing),
      };
    } else if (mode === 'cancel' && settled.failure === 'deadline') {
      // Stopped by this cancellation's own abort, not by a deadline.
      settlement = { status: 'failed', failure: 'cancelled', terminal: usage.interrupted(now, billing) };
    } else {
      settlement = {
        status: 'failed',
        failure: settled.failure,
        ...(settled.resumesAt === undefined ? {} : { result: { resumesAt: settled.resumesAt } }),
        terminal: settled.failure === 'deadline' ? usage.interrupted(now, billing) : usage.failed(now, billing),
      };
      creditBack = settled.creditBack;
    }
    await this.write(row, settlement, now, creditBack);
  }

  /**
   * The store's own terminal, whatever the instance reports: the lock frees,
   * the plan goes and model access ends with it.
   */
  private async force(row: TestRunRow, failure: 'not_dispatched' | 'deadline' | 'cancelled', now: number): Promise<void> {
    const usage = this.recorder(row);
    const billing = row.submissionId;
    await this.write(row, {
      status: 'failed',
      failure,
      terminal: failure === 'not_dispatched' ? usage.failed(now, billing) : usage.interrupted(now, billing),
    }, now, failure === 'deadline' ? 'timeout' : failure === 'not_dispatched' ? 'chickpea' : null);
  }

  private async write(
    row: TestRunRow,
    settlement: TestRunSettlement,
    now: number,
    creditBack: CreditBackReason | null,
  ): Promise<void> {
    if (!this.deps.stores().testRuns.settle(row.testRunId, settlement, now)) return;
    if (!creditBack || row.submissionId === null) return;
    try {
      await bounded((await this.deps.port()).creditBack(row.submissionId, creditBack));
    } catch (error) {
      log('test_run_credit_back_failed', row, error);
    }
  }

  private recorder(row: TestRunRow): TestRunUsageRecorder {
    const operation = this.deps.stores().usage.getOperation(row.usageOperationId)?.operation;
    return new TestRunUsageRecorder(operation ?? {
      operationId: row.usageOperationId,
      requestedProvider: null,
      requestedModel: null,
      credentialRefId: null,
      credentialVersion: null,
    }, this.deps.platformEnv ? { platformEnv: this.deps.platformEnv } : {});
  }
}

function testRunView(row: TestRunRow): TestRunView {
  return {
    runToken: row.runToken,
    agentId: row.agentId,
    status: row.status,
    failure: row.failure,
    result: row.result,
    createdAt: row.createdAt,
  };
}

function live(row: TestRunRow): boolean {
  return row.status === 'admitted' || row.status === 'running';
}

function planOf(row: TestRunRow): unknown {
  return row.planJson === null ? undefined : JSON.parse(row.planJson) as unknown;
}

function bounded<T>(work: Promise<T>, timeoutMs = TEST_RUN_INSTANCE_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The test run instance did not answer in time.')), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function log(event: string, row: Pick<TestRunRow, 'testRunId'>, error?: unknown): void {
  const fields = {
    component: 'test_run',
    event,
    testRunId: row.testRunId,
    ...(error === undefined ? {} : { errorName: error instanceof Error ? error.name : typeof error }),
  };
  if (error === undefined) console.info(fields);
  else console.warn(fields);
}
