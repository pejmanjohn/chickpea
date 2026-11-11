/**
 * The state store's side of a practice run (U6a §3.2): admission and
 * dispatch in one call, then the settle step, which alone addresses the
 * run's instance. The alarm, the caller's polls and a cancellation pass all
 * run it; one step per run at a time, and none once the instance is erased.
 */
import { practiceMessage } from '../agents/practice-history.ts';
import { deriveRuntimePlanInstanceId, parseRuntimePlanV2, type RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { CHICKPEA_SUBMISSION_DURABILITY } from '../agents/submission-durability.ts';
import { installationScopeOfObjectName, requireInstallationScope } from '../config/installation-scope.ts';
import type { CreditBackReason, PlatformFundingRefusal } from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type {
  PracticeKeptResult,
  PracticeRunListing,
  PracticeRunsQuery,
  PracticeStep,
  TestRunFailure,
  TestRunQuery,
  TestRunReplayQuery,
  TestRunResult,
  TestRunRow,
  TestRunSettlement,
  TestRunStartRequest,
  TestRunStartResult,
  TestRunStepQuery,
  TestRunStepResult,
  TestRunView,
} from '../management/test-run-types.ts';
import { liveTestRun as live, type TestRunStoreLogic } from '../management/test-runs.ts';
import type { ChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { TestRunUsageRecorder } from '../usage/test-run-usage.ts';
import { givenUpReason, planFunding } from '../usage/run-settlement.ts';
import type { UsageStoreLogic } from '../usage/store.ts';
import type { RecordUsageTerminalInput } from '../usage/types.ts';
import { opaqueId } from '../work/admission.ts';

/** Admitted with no submission this long: the dispatch never landed, as far as the store knows. */
export const TEST_RUN_DISPATCH_GRACE_MS = 30_000;
/** The store aborts a run still unsettled this long after admission, 5 s past Flue's own timeout, a direct message's. */
export const TEST_RUN_ABORT_AFTER_MS = CHICKPEA_SUBMISSION_DURABILITY.timeoutMs + 5_000;
/** The store fails a run still unsettled this long after admission, whatever the instance reports. */
export const TEST_RUN_DEADLINE_MS = CHICKPEA_SUBMISSION_DURABILITY.timeoutMs + 30_000;
/** The erase waits for the instance to settle no longer than this after admission. */
export const TEST_RUN_FORCED_ERASE_MS = TEST_RUN_DEADLINE_MS + 7.5 * 60_000;
/**
 * A run that never had a submission while it was live never ran, so it has
 * no timeout to outlast: its erase waits only this long after admission, for
 * a dispatch that lands late.
 */
export const TEST_RUN_UNBOUND_ERASE_MS = 10 * 60_000;
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
  | {
      kind: 'answered';
      reply: string;
      replyTruncated?: true;
      read: string[];
      steps: PracticeStep[];
      moreSteps?: number;
      skills?: string[];
      /** More of each cut result than its excerpt, kept beside the run. */
      results?: PracticeKeptResult[];
      metadata?: ChickpeaResponseMetadata;
    }
  | {
      kind: 'failed';
      failure: Extract<TestRunFailure, 'deadline' | 'out_of_usage' | 'daily_limit' | 'failed'>;
      funding?: PlatformFundingRefusal;
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
  stores: () => {
    testRuns: TestRunStoreLogic;
    usage: Pick<UsageStoreLogic, 'getOperation' | 'recordTerminal'>;
  };
  /** Loaded at its first use: it carries the test agent's dispatch path. */
  port: () => Promise<TestRunInstancePort>;
  /** Arms the store's alarm no later than `at`. */
  armAlarm: (at: number) => Promise<void>;
  now?: () => number;
  /** The store's env: a run's instance must be one of its installation's. */
  platformEnv?: PlatformEnv;
}

/** How a run ended, as its usage terminal records it. */
type TestRunOutcome =
  | { status: 'answered'; metadata?: ChickpeaResponseMetadata }
  | { status: 'failed'; failure: TestRunFailure };

export class TestRunLifecycle {
  /** The step going for each run; another caller joins it. */
  private readonly steps = new Map<string, Promise<TestRunRow | undefined>>();
  /**
   * Runs whose abort the instance answered, with the submission the run had
   * then. An abort sent before a submission landed does not stop it. A
   * restart forgets them, and the next step asks again.
   */
  private readonly aborted = new Map<string, string | null>();
  /** Runs whose dispatch call has not returned: what it lands can follow any abort or erase sent now. */
  private readonly dispatching = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: TestRunLifecycleDependencies) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Admission, then the dispatch, in one call. The row's plan is the
   * creation data's, and it must name this run, its caller, its Agent and an
   * instance of this installation, so its instance is the run's own and
   * never another's. The message is the store's: a follow-up quotes the
   * conversation's earlier turns from its own rows, and the creation data
   * says so for the framing. A dispatch that throws leaves the run
   * `admitted` for the 30-second rule; one that landed binds its submission
   * at its first model request anyway.
   */
  async start(request: TestRunStartRequest): Promise<TestRunStartResult> {
    const { testRuns } = this.deps.stores();
    const { run } = request;
    const plan = parseRuntimePlanV2(request.initialData.runtimePlan);
    const { conversation } = plan;
    const instanceId = deriveRuntimePlanInstanceId(plan);
    if (conversation.surface !== 'test' ||
        conversation.continuityKey !== opaqueId('agent', `test:${run.testRunId}`) ||
        conversation.channelId !== `test_${run.coordinateToken}` ||
        plan.actorMembershipId !== run.actorMembershipId ||
        plan.agentId !== run.agentId ||
        installationScopeOfObjectName(instanceId)?.installationId !== requireInstallationScope(this.deps.platformEnv)?.installationId) {
      throw new Error('A test run must run its own test run plan.');
    }
    const at = this.now();
    const admission = testRuns.admit({ ...run, instanceId, planJson: JSON.stringify(request.initialData.runtimePlan) }, at);
    switch (admission.kind) {
      case 'in_progress':
      case 'ended':
        return admission;
      case 'replayed':
      case 'running':
        return { kind: admission.kind, run: this.view(await this.settled(admission.row)) };
      case 'repeat':
        return { kind: 'repeat', run: { ...this.view(admission.row), repeat: true } };
    }
    const { row } = admission;
    const { message, quoted } = practiceMessage(run.question, admission.earlier);
    // Before any wait, so the run is still admitted: the result says how many turns its Agent never saw.
    const dropped = admission.expired + admission.earlier.length - quoted;
    if (dropped > 0) testRuns.recordDroppedTurns(row.testRunId, dropped);
    const { quotesEarlierTurns: _sent, ...data } = request.initialData;
    const initialData = quoted > 0 ? { ...data, quotesEarlierTurns: true as const } : data;
    await this.deps.armAlarm(testRuns.nextDueAt(at) ?? at);
    try {
      await bounded(this.dispatch(row, { message, initialData }));
    } catch (error) {
      log('test_run_dispatch_failed', row, error);
    }
    // A cancellation that settled the run while its dispatch was out left the instance alone: stop and erase it now.
    const dispatched = testRuns.get(row.testRunId) ?? row;
    if (!live(dispatched) && !this.dispatching.has(row.testRunId)) await this.step(row.testRunId);
    return { kind: 'admitted', run: this.view(testRuns.get(row.testRunId) ?? row) };
  }

  /**
   * The dispatch, tracked until its call returns, however long after its
   * bound that is. A receipt that lands after the run's instance was erased
   * makes the run unerased again, and the alarm erases it.
   */
  private dispatch(row: TestRunRow, sent: Omit<TestRunDispatch, 'idempotencyKey'>): Promise<void> {
    this.dispatching.add(row.testRunId);
    return (async () => {
      try {
        const receipt = await (await this.deps.port()).dispatch(row.instanceId, { ...sent, idempotencyKey: row.testRunId });
        if (this.deps.stores().testRuns.recordSubmission(row.testRunId, receipt.submissionId)) {
          await this.deps.armAlarm(this.now());
        }
      } finally {
        this.dispatching.delete(row.testRunId);
        // A cancellation may have deleted the alarm while this call was out; a
        // run it left unerased needs the alarm back to be aborted and erased.
        const due = this.nextDueAt();
        if (due !== undefined) await this.deps.armAlarm(due).catch(() => undefined);
      }
    })();
  }

  async replay(query: TestRunReplayQuery): Promise<TestRunView | undefined> {
    const row = this.deps.stores().testRuns.replay(query, this.now());
    return row ? this.view(await this.settled(row)) : undefined;
  }

  async observe(query: TestRunQuery): Promise<TestRunView | undefined> {
    const row = this.deps.stores().testRuns.read(query, this.now());
    return row ? this.view(await this.settled(row)) : undefined;
  }

  /** What the caller learns of a run, with the earlier answer to the same question, of another version, beside it. */
  private view(row: TestRunRow): TestRunView {
    const before = this.deps.stores().testRuns.before(row, this.now());
    return { ...testRunView(row), ...before ? { before } : {} };
  }

  /** A read of the rows as they stand: no run is stepped for it. */
  async list(query: PracticeRunsQuery): Promise<PracticeRunListing[]> {
    return this.deps.stores().testRuns.list(query, this.now());
  }

  /** A read of one step's kept result as it stands: no run is stepped for it. */
  async stepResult(query: TestRunStepQuery): Promise<TestRunStepResult | undefined> {
    return this.deps.stores().testRuns.stepResult(query, this.now());
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
    this.writeOwedTerminal(row, now);
    // Until its dispatch call returns, an abort or an erase could come before what it lands.
    if (this.dispatching.has(testRunId) && !eraseForced(row, now)) return row;
    if (await this.eraseReady(row, probe, now)) await this.erase(row);
    return testRuns.get(testRunId);
  }

  /**
   * The instance has settled or is gone, or the forced bound has passed. An
   * instance still running is aborted first. A run with no submission has
   * nothing to read, so its erase waits for its own bound, unless a
   * submission that lands later binds it and settles.
   */
  private async eraseReady(row: TestRunRow, probe: TestRunInstanceSettlement | undefined, now: number): Promise<boolean> {
    if (eraseForced(row, now)) {
      await this.abortOnce(row);
      log('test_run_forced_erase', row);
      return true;
    }
    if (row.submissionId === null) {
      await this.abortOnce(row);
      return false;
    }
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
      this.aborted.delete(row.testRunId);
      if (this.terminalOwed(row)) log('test_run_terminal_lost', row);
    } catch (error) {
      log('test_run_erase_failed', row, error);
    }
  }

  /** True once the instance answered an abort sent after the run's current submission was known. */
  private async abortOnce(row: TestRunRow): Promise<boolean> {
    if (this.aborted.get(row.testRunId) === row.submissionId) return true;
    try {
      await bounded((await this.deps.port()).abort(row.instanceId));
      this.aborted.set(row.testRunId, row.submissionId);
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
    if (settled.kind === 'answered') {
      const { kind: _kind, metadata, results, ...result } = settled;
      await this.write(row, {
        status: 'answered',
        result,
        ...(results ? { results } : {}),
        terminal: this.terminal(row, { status: 'answered', ...(metadata ? { metadata } : {}) }, now),
      }, null);
      return;
    }
    let failure: TestRunFailure;
    let creditBack: CreditBackReason | null = null;
    let result: TestRunResult | undefined;
    if (settled.kind === 'not_found') {
      failure = now - row.createdAt >= TEST_RUN_DEADLINE_MS ? 'deadline' : 'failed';
      // The run is lost: credited as a direct message's lost run is, whatever the time.
      creditBack = givenUpReason(undefined, planFunding(planOf(row) as Pick<RuntimePlanV2, 'modelCredential'> | undefined));
    } else if (mode === 'cancel' && settled.failure === 'deadline') {
      // Stopped by this cancellation's own abort, not by a deadline.
      failure = 'cancelled';
    } else {
      failure = settled.failure;
      creditBack = settled.creditBack;
      result = settled.funding ? { funding: settled.funding } : {};
    }
    await this.write(row, {
      status: 'failed',
      failure,
      ...(result ? { result } : {}),
      terminal: this.terminal(row, { status: 'failed', failure }, now),
    }, creditBack);
  }

  /**
   * The store's own terminal, whatever the instance reports: the lock frees
   * and the plan goes, so no new or resumed attempt gets model access. An
   * attempt already running stops at Flue's abort or timeout.
   */
  private async force(row: TestRunRow, failure: 'not_dispatched' | 'deadline' | 'cancelled', now: number): Promise<void> {
    await this.write(row, {
      status: 'failed',
      failure,
      terminal: this.terminal(row, { status: 'failed', failure }, now),
    }, failure === 'deadline' ? 'timeout' : null);
  }

  /**
   * Settles the row with its usage terminal. A terminal Usage refuses never
   * keeps the run live: the row settles without it, and each later step
   * until the erase writes one with its usage unreported. A failure that is
   * Chickpea's, a deadline included, is credited back every time, exactly
   * as a direct message's is.
   */
  private async write(row: TestRunRow, settlement: TestRunSettlement, creditBack: CreditBackReason | null): Promise<void> {
    const { testRuns } = this.deps.stores();
    if (row.submissionId !== null && creditBack !== null) {
      settlement = { ...settlement, result: { ...settlement.result, creditedBack: true as const } };
    }
    let settled: boolean;
    try {
      settled = testRuns.settle(row.testRunId, settlement);
    } catch (error) {
      log('test_run_terminal_refused', row, error);
      settled = testRuns.settleWithoutTerminal(row.testRunId, settlement);
    }
    if (!settled || !creditBack || row.submissionId === null) return;
    try {
      await bounded((await this.deps.port()).creditBack(row.submissionId, creditBack));
    } catch (error) {
      log('test_run_credit_back_failed', row, error);
    }
  }

  /** A settled run's terminal that Usage refused at settlement, tried again with its usage unreported. */
  private writeOwedTerminal(row: TestRunRow, now: number): void {
    if (!this.terminalOwed(row)) return;
    const outcome: TestRunOutcome = row.status === 'answered'
      ? { status: 'answered' }
      : { status: 'failed', failure: row.failure ?? 'failed' };
    try {
      this.deps.stores().usage.recordTerminal(this.terminal(row, outcome, now));
    } catch (error) {
      log('test_run_terminal_refused', row, error);
    }
  }

  private terminalOwed(row: TestRunRow): boolean {
    return this.deps.stores().usage.getOperation(row.usageOperationId)?.operation.status === 'admitted';
  }

  /** Deadlines and cancellations are interrupted; any other failure failed. */
  private terminal(row: TestRunRow, outcome: TestRunOutcome, now: number): RecordUsageTerminalInput {
    const operation = this.deps.stores().usage.getOperation(row.usageOperationId)?.operation;
    const usage = new TestRunUsageRecorder(operation ?? {
      operationId: row.usageOperationId,
      requestedProvider: null,
      requestedModel: null,
      credentialRefId: null,
      credentialVersion: null,
    }, this.deps.platformEnv ? { platformEnv: this.deps.platformEnv } : {});
    if (outcome.status === 'answered') return usage.completed(outcome.metadata, now, row.submissionId);
    return outcome.failure === 'deadline' || outcome.failure === 'cancelled'
      ? usage.interrupted(now, row.submissionId)
      : usage.failed(now, row.submissionId);
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
    settledAt: row.settledAt,
    practiceId: row.practiceId,
    turn: row.turn,
    question: row.question,
  };
}

/**
 * The erase stops waiting for the instance: at the forced bound, or sooner
 * for a run that never ran. A submission that binds after the store failed
 * the run as not dispatched gets no model access, so that run never ran either.
 */
function eraseForced(row: TestRunRow, now: number): boolean {
  const neverRan = row.submissionId === null || row.failure === 'not_dispatched';
  return now - row.createdAt >= (neverRan ? TEST_RUN_UNBOUND_ERASE_MS : TEST_RUN_FORCED_ERASE_MS);
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
