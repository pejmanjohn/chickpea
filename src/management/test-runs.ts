/**
 * Practice runs (internally, test runs): one read-only run of an Agent on a
 * question, as the caller, posting nowhere (U6a, practice runs §3-§4). The
 * row is the run's whole record, from admission to the erase of its
 * instance. Only the installation's state store writes it; the lifecycle
 * (state/test-run-lifecycle.ts) owns every step that addresses the instance.
 */
import { createHash } from 'node:crypto';

import { addColumnIfMissing } from '../state/schema-links.ts';
import type { StateDb } from '../state/state-db.ts';
import type { UsageStoreLogic } from '../usage/store.ts';
import type {
  PracticeAsk,
  TestRunAdmission,
  TestRunAdmissionRequest,
  TestRunFailure,
  TestRunModelAccessBinding,
  TestRunResult,
  TestRunRow,
  TestRunSettlement,
  TestRunStatus,
} from './test-run-types.ts';

/** A run answered this recently answers the same ask on the same plan again, rather than run twice. */
export const PRACTICE_REPEAT_MS = 2 * 60_000;
/**
 * A settled run reads as not found this long after it settled, and it is
 * erased then. A run still going always reads: it can run as long as a direct
 * message, past the hour.
 */
export const TEST_RUN_VISIBLE_MS = 60 * 60_000;
/** How often the state store's alarm looks at a run whose instance is not erased yet. */
export const TEST_RUN_WAKE_MS = 10_000;

/** Rows one alarm deletes; the next alarm takes the rest. */
const ERASE_BATCH = 250;
const HAS_TEXT = '(result_json IS NOT NULL OR question IS NOT NULL OR question_digest IS NOT NULL)';
const SETTLED = "status NOT IN ('admitted', 'running')";
/** When a run's hour starts: its settlement, or for a row from before practice runs, its admission. */
const HOUR_FROM = 'COALESCE(settled_at, created_at)';

/**
 * The question's digest, so a key or a repeat can match an ask after the
 * question itself is gone. Salted with the installation's organization; it is
 * erased with the question.
 */
export function practiceQuestionDigest(organizationId: string, question: string): string {
  return createHash('sha256').update(`chickpea-practice-question:v1:${organizationId}:${question}`).digest('hex');
}

/** The table, created with the management store's schema. */
export function installTestRunSchema(db: StateDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS management_test_runs (
      test_run_id TEXT PRIMARY KEY,
      run_token TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      actor_membership_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      failure TEXT,
      idempotency_key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      submission_id TEXT,
      plan_json TEXT,
      result_json TEXT,
      usage_operation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      erased_at INTEGER
    )`,
  );
  for (const [column, definition] of [
    ['practice_id', 'TEXT'], ['turn', 'INTEGER'], ['question', 'TEXT'], ['question_digest', 'TEXT'], ['plan_digest', 'TEXT'],
    ['settled_at', 'INTEGER'],
  ] as const) {
    addColumnIfMissing(db, 'management_test_runs', column, definition);
  }
  // Practice runs share the plan's limits, as a direct message does, so no lock holds a workspace to one run.
  // contract: the per-installation lock never served production (U6a shipped to staging only), so nothing reads it.
  db.exec('DROP INDEX IF EXISTS management_test_runs_live_idx');
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS management_test_runs_idempotency_idx
     ON management_test_runs (actor_membership_id, idempotency_key)`,
  );
  db.exec('CREATE INDEX IF NOT EXISTS management_test_runs_instance_idx ON management_test_runs (instance_id)');
  // The hour's rows of the installation: the same ask going or just settled reads them.
  db.exec('CREATE INDEX IF NOT EXISTS management_test_runs_day_idx ON management_test_runs (organization_id, created_at)');
  // Every alarm asks whether any instance is left to erase.
  db.exec(
    `CREATE INDEX IF NOT EXISTS management_test_runs_unerased_idx
     ON management_test_runs (created_at) WHERE erased_at IS NULL`,
  );
  // And when the next run's text is an hour past its settlement.
  db.exec(`CREATE INDEX IF NOT EXISTS management_test_runs_text_idx ON management_test_runs (${HOUR_FROM}) WHERE ${HAS_TEXT}`);
}

/**
 * A run's text goes once it can no longer be read, whether or not its
 * instance is erased yet: the question, the reply, its steps and the
 * question's digest.
 */
function eraseTestRunText(db: StateDb, at: number): number {
  return db.run(
    `UPDATE management_test_runs SET result_json = NULL, question = NULL, question_digest = NULL
     WHERE ${HAS_TEXT} AND ${SETTLED} AND ${HOUR_FROM} <= ?`,
    at - TEST_RUN_VISIBLE_MS,
  ).changes;
}

/**
 * A run goes once it can no longer be read: its text an hour after it
 * settles, and the row with it once its instance is erased. Nothing counts a run after that.
 * The alarm runs this whenever it wakes, and wakes for it (`nextDueAt`); the
 * retention sweep runs it too. Returns the rows it deleted.
 */
export function cleanupTestRunRetention(db: StateDb, at: number, limit: number): number {
  eraseTestRunText(db, at);
  return db.run(
    `DELETE FROM management_test_runs WHERE test_run_id IN (
       SELECT test_run_id FROM management_test_runs
       WHERE erased_at IS NOT NULL AND ${SETTLED} AND ${HOUR_FROM} <= ?
       ORDER BY ${HOUR_FROM} LIMIT ?
     )`,
    at - TEST_RUN_VISIBLE_MS,
    limit,
  ).changes;
}

interface Caller {
  organizationId: string;
  actorMembershipId: string;
}

export class TestRunStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly usage: Pick<UsageStoreLogic, 'admitOperation' | 'recordTerminal'>,
  ) {}

  /** The caller's run under a key, while it can be read, only for the same ask: a key for another ask names none. */
  replay(query: Caller & PracticeAsk & { idempotencyKey: string }, at: number): TestRunRow | undefined {
    const row = this.row('actor_membership_id = ? AND idempotency_key = ?', query.actorMembershipId, query.idempotencyKey);
    return row && row.organizationId === query.organizationId && sameAsk(row, query) && readable(row, at) ? row : undefined;
  }

  /**
   * One transaction: the key, the same ask going or answered moments ago on
   * the same plan, the conversation's last turn still going, then the row and
   * the run's usage operation. A key that names another ask, or a run past
   * its hour, is treated as absent: the run starts under a key of its own.
   * The plan's funding limits the run as it limits a direct message, at its
   * first model request. The caller arms the alarm before it dispatches.
   */
  admit(request: TestRunAdmissionRequest, at: number): TestRunAdmission {
    return this.db.transaction((): TestRunAdmission => {
      let { idempotencyKey } = request;
      if (this.row('actor_membership_id = ? AND idempotency_key = ?', request.actorMembershipId, idempotencyKey)) {
        const replayed = this.replay(request, at);
        if (replayed) return { kind: 'replayed', row: replayed };
        idempotencyKey = `minted_${request.testRunId}`;
      }
      const same = this.sameAsks(request, at);
      const running = same.find((row) => row.status === 'admitted' || row.status === 'running');
      if (running) return { kind: 'running', row: running };
      // Only an answer is given again: a run that failed is asked again, as a direct message would be.
      const repeat = same.find((row) => row.status === 'answered' && row.settledAt !== null &&
        row.settledAt >= at - PRACTICE_REPEAT_MS && row.planDigest === request.planDigest);
      if (repeat) return { kind: 'repeat', row: repeat };
      // A conversation's turns run one after another: the next waits for the last to settle.
      const turn = request.practiceId === null ? undefined : this.row(
        "practice_id = ? AND actor_membership_id = ? AND status IN ('admitted', 'running')",
        request.practiceId,
        request.actorMembershipId,
      );
      if (turn) return { kind: 'in_progress', runToken: turn.runToken };
      try {
        this.db.run(
          `INSERT INTO management_test_runs (test_run_id, run_token, organization_id, actor_membership_id, agent_id,
             status, idempotency_key, instance_id, plan_json, result_json, usage_operation_id, created_at,
             practice_id, turn, question, question_digest, plan_digest)
           VALUES (?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          request.testRunId,
          request.runToken,
          request.organizationId,
          request.actorMembershipId,
          request.agentId,
          idempotencyKey,
          request.instanceId,
          request.planJson,
          Object.keys(request.admitted).length > 0 ? JSON.stringify(request.admitted satisfies TestRunResult) : null,
          request.usage.operationId,
          at,
          request.newPracticeId,
          request.turn,
          request.question,
          request.questionDigest,
          request.planDigest,
        );
      } catch (error) {
        // An older Worker version recreates its one-run-per-installation lock when it starts this store.
        if (/UNIQUE constraint failed: management_test_runs\.organization_id\b/.test(error instanceof Error ? error.message : '')) {
          return { kind: 'in_progress' };
        }
        throw error;
      }
      // The run starts at admission, on the clock its terminal is written by.
      this.usage.admitOperation({ ...request.usage, startedAt: at });
      return { kind: 'admitted', row: this.require(request.testRunId) };
    });
  }

  /**
   * The caller's runs of the same ask that are going, or settled within the
   * repeat window; newest first. The table holds only the installation's
   * runs still going or settled within the hour.
   */
  private sameAsks(ask: Caller & PracticeAsk, at: number): TestRunRow[] {
    return this.db.all(
      `SELECT * FROM management_test_runs
       WHERE organization_id = ? AND actor_membership_id = ?
         AND (status IN ('admitted', 'running') OR settled_at >= ?)
       ORDER BY created_at DESC`,
      ask.organizationId,
      ask.actorMembershipId,
      at - PRACTICE_REPEAT_MS,
    ).map((row) => testRunFromRow(row)).filter((row) => sameAsk(row, ask));
  }

  /**
   * The model-access lookup's binding: the first submission to ask is the
   * run's, whether access is granted or not, and any other is refused.
   * Access is granted only while the run is live with its plan.
   */
  bindModelAccess(instanceId: string, submissionId: string): TestRunModelAccessBinding | undefined {
    return this.db.transaction(() => {
      const row = this.row('instance_id = ?', instanceId);
      if (!row) return undefined;
      let reopened = false;
      if (row.submissionId === null) reopened = this.recordSubmission(row.testRunId, submissionId);
      else if (row.submissionId !== submissionId) return undefined;
      const bound = this.require(row.testRunId);
      return {
        ...((bound.status === 'admitted' || bound.status === 'running') && bound.planJson !== null
          ? { runtimePlan: JSON.parse(bound.planJson) as unknown }
          : {}),
        ...(reopened ? { reopened: true as const } : {}),
      };
    });
  }

  /**
   * The dispatch receipt's submission, compare-and-set: one the lookup bound
   * first stands. A live run is `running` once its submission is known. A
   * submission that lands after the run's instance was erased means the
   * instance holds the run again, so the run is unerased; true then.
   */
  recordSubmission(testRunId: string, submissionId: string): boolean {
    const erasedAt = this.get(testRunId)?.erasedAt ?? null;
    const changed = this.db.run(
      `UPDATE management_test_runs
       SET submission_id = ?, status = CASE WHEN status = 'admitted' THEN 'running' ELSE status END, erased_at = NULL
       WHERE test_run_id = ? AND submission_id IS NULL`,
      submissionId,
      testRunId,
    ).changes;
    return changed > 0 && erasedAt !== null;
  }

  /**
   * Compare-and-set from live: the result, the usage terminal, the plan
   * nulled and the lock freed, in one transaction. A run already settled
   * keeps its first settlement; false then.
   */
  settle(testRunId: string, settlement: TestRunSettlement): boolean {
    return this.db.transaction(() => {
      if (!this.settleRow(testRunId, settlement)) return false;
      this.usage.recordTerminal(settlement.terminal);
      return true;
    });
  }

  /** As `settle`, for a terminal Usage refused: the run settles all the same, and its terminal is owed. */
  settleWithoutTerminal(testRunId: string, settlement: TestRunSettlement): boolean {
    return this.settleRow(testRunId, settlement);
  }

  /** What admission stored of the run (what it could not use, what it ran) stays beside its outcome. */
  private settleRow(testRunId: string, settlement: TestRunSettlement): boolean {
    const admitted = this.get(testRunId)?.result ?? {};
    const result = { ...admitted, ...settlement.result };
    return this.db.run(
      `UPDATE management_test_runs
       SET status = ?, failure = ?, result_json = ?, plan_json = NULL, settled_at = ?
       WHERE test_run_id = ? AND status IN ('admitted', 'running')`,
      settlement.status,
      settlement.status === 'failed' ? settlement.failure : null,
      Object.keys(result).length > 0 ? JSON.stringify(result) : null,
      settlement.terminal.finishedAt,
      testRunId,
    ).changes > 0;
  }

  markErased(testRunId: string, at: number): void {
    this.db.run(
      'UPDATE management_test_runs SET erased_at = ? WHERE test_run_id = ? AND erased_at IS NULL',
      at,
      testRunId,
    );
  }

  get(testRunId: string): TestRunRow | undefined {
    return this.row('test_run_id = ?', testRunId);
  }

  /** The caller's own run by its token, while it can be read; another's reads as none. */
  read(query: { organizationId: string; actorMembershipId: string; runToken: string }, at: number): TestRunRow | undefined {
    const row = this.row('run_token = ?', query.runToken);
    return row && row.organizationId === query.organizationId && row.actorMembershipId === query.actorMembershipId &&
      readable(row, at)
      ? row
      : undefined;
  }

  /** Runs whose instance is not erased yet, oldest first. */
  unerased(): TestRunRow[] {
    return (this.db.all('SELECT * FROM management_test_runs WHERE erased_at IS NULL ORDER BY created_at')
      .map((row) => testRunFromRow(row)));
  }

  /** Runs the hour's-end erase on every alarm, so a run never waits for the five-minute retention sweep. Returns the rows it deleted. */
  eraseExpired(at: number): number {
    return cleanupTestRunRetention(this.db, at, ERASE_BATCH);
  }

  hasUnerased(): boolean {
    return this.db.get('SELECT 1 AS present FROM management_test_runs WHERE erased_at IS NULL LIMIT 1') !== undefined;
  }

  /**
   * When the alarm looks again: soon while any run's instance is not erased,
   * and an hour after the earliest settled run with text settled, which is
   * when the run goes. Text already due waits one look, so an erase that
   * keeps failing never spins the alarm.
   */
  nextDueAt(now: number): number | undefined {
    const look = this.hasUnerased() ? now + TEST_RUN_WAKE_MS : undefined;
    const oldest = this.db.get(`SELECT MIN(${HOUR_FROM}) AS at FROM management_test_runs WHERE ${HAS_TEXT} AND ${SETTLED}`)?.at;
    const erase = oldest === null || oldest === undefined
      ? undefined
      : Math.max(Number(oldest) + TEST_RUN_VISIBLE_MS, now + TEST_RUN_WAKE_MS);
    return look === undefined ? erase : erase === undefined ? look : Math.min(look, erase);
  }

  private require(testRunId: string): TestRunRow {
    const row = this.get(testRunId);
    if (!row) throw new Error('The test run was not found.');
    return row;
  }

  private row(where: string, ...params: Array<string | number>): TestRunRow | undefined {
    const row = this.db.get(`SELECT * FROM management_test_runs WHERE ${where} LIMIT 1`, ...params);
    return row ? testRunFromRow(row) : undefined;
  }
}

/**
 * Two asks are one when they name the same Agent and question, and both
 * start a conversation or both continue the same one. A new conversation's
 * ID is minted per run, so it cannot tell two first questions apart.
 */
/** A run going reads; a settled one, for an hour from its settlement. */
function readable(row: TestRunRow, at: number): boolean {
  return row.status === 'admitted' || row.status === 'running' || at < (row.settledAt ?? row.createdAt) + TEST_RUN_VISIBLE_MS;
}

function sameAsk(row: TestRunRow, ask: PracticeAsk): boolean {
  if (row.agentId !== ask.agentId || row.questionDigest === null || row.questionDigest !== ask.questionDigest) return false;
  return ask.practiceId === null ? row.turn === 1 : row.practiceId === ask.practiceId && (row.turn ?? 0) > 1;
}

function testRunFromRow(row: Record<string, unknown>): TestRunRow {
  const nullableString = (value: unknown) => value === null || value === undefined ? null : String(value);
  const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
  return {
    testRunId: String(row.test_run_id),
    runToken: String(row.run_token),
    organizationId: String(row.organization_id),
    actorMembershipId: String(row.actor_membership_id),
    agentId: String(row.agent_id),
    status: String(row.status) as TestRunStatus,
    failure: nullableString(row.failure) as TestRunFailure | null,
    idempotencyKey: String(row.idempotency_key),
    instanceId: String(row.instance_id),
    submissionId: nullableString(row.submission_id),
    planJson: nullableString(row.plan_json),
    result: row.result_json === null || row.result_json === undefined
      ? null
      : JSON.parse(String(row.result_json)) as TestRunResult,
    usageOperationId: String(row.usage_operation_id),
    createdAt: Number(row.created_at),
    erasedAt: nullableNumber(row.erased_at),
    practiceId: nullableString(row.practice_id),
    turn: nullableNumber(row.turn),
    question: nullableString(row.question),
    questionDigest: nullableString(row.question_digest),
    planDigest: nullableString(row.plan_digest),
    settledAt: nullableNumber(row.settled_at),
  };
}
