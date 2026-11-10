/**
 * Test runs: one read-only run of a new Agent on its stored first ask, as
 * the caller, posting nowhere (U6a). The row is the run's whole record, from
 * admission to the erase of its instance. Only the installation's state
 * store writes it; the lifecycle (state/test-run-lifecycle.ts) owns every
 * step that addresses the instance.
 */
import type { StateDb } from '../state/state-db.ts';
import type { UsageStoreLogic } from '../usage/store.ts';
import type {
  TestRunAdmission,
  TestRunAdmissionRequest,
  TestRunFailure,
  TestRunResult,
  TestRunRow,
  TestRunSettlement,
  TestRunStatus,
} from './test-run-types.ts';

/** At most this many runs admitted per installation per UTC day. */
export const TEST_RUN_DAILY_RUNS = 10;
/** List price of today's test runs' model requests, past which no run is admitted. */
export const TEST_RUN_DAILY_LIMIT_USD_MICROS = 2_000_000;
/** A run reads as not found this long after its admission. */
export const TEST_RUN_VISIBLE_MS = 60 * 60_000;
/** How often the state store's alarm looks at a run whose instance is not erased yet. */
export const TEST_RUN_WAKE_MS = 10_000;

const DAY_MS = 24 * 60 * 60_000;

/** The table, created with the management store's schema. */
export function installTestRunSchema(db: StateDb): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS management_test_runs (
      test_run_id TEXT PRIMARY KEY,
      run_token TEXT NOT NULL UNIQUE,
      coordinate_token TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      actor_membership_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'answered', 'failed')),
      failure TEXT,
      idempotency_key TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      submission_id TEXT,
      plan_json TEXT,
      result_json TEXT,
      usage_operation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      settled_at INTEGER,
      erased_at INTEGER,
      expires_at INTEGER NOT NULL
    )`,
  );
  // One run at a time per installation: the lock frees at settlement, before the erase.
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS management_test_runs_live_idx
     ON management_test_runs (organization_id) WHERE status IN ('admitted', 'running')`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS management_test_runs_idempotency_idx
     ON management_test_runs (actor_membership_id, idempotency_key)`,
  );
  db.exec('CREATE INDEX IF NOT EXISTS management_test_runs_instance_idx ON management_test_runs (instance_id)');
  db.exec('CREATE INDEX IF NOT EXISTS management_test_runs_day_idx ON management_test_runs (organization_id, created_at)');
}

/**
 * The retention sweep's part: a settled row loses its reply once it can no
 * longer be read, and goes once that hour and its UTC day have both passed
 * and its instance is erased. The daily cap counts it until then.
 */
export function cleanupTestRunRetention(db: StateDb, at: number, limit: number): number {
  db.run(
    `UPDATE management_test_runs SET result_json = NULL
     WHERE result_json IS NOT NULL AND created_at <= ?`,
    at - TEST_RUN_VISIBLE_MS,
  );
  return db.run(
    `DELETE FROM management_test_runs WHERE test_run_id IN (
       SELECT test_run_id FROM management_test_runs
       WHERE erased_at IS NOT NULL AND created_at <= ? AND created_at < ?
       ORDER BY created_at LIMIT ?
     )`,
    at - TEST_RUN_VISIBLE_MS,
    utcDayStart(at),
    limit,
  ).changes;
}

export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

export class TestRunStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly usage: Pick<UsageStoreLogic, 'admitOperation' | 'recordTerminal'>,
  ) {}

  /** The caller's run under an idempotency key, for a replay before any check. */
  findByIdempotencyKey(actorMembershipId: string, idempotencyKey: string): TestRunRow | undefined {
    return this.row('actor_membership_id = ? AND idempotency_key = ?', actorMembershipId, idempotencyKey);
  }

  /**
   * One transaction: the replay, the lock, both daily limits, the row and the
   * run's usage operation. The caller arms the alarm before it dispatches.
   */
  admit(request: TestRunAdmissionRequest, at: number): TestRunAdmission {
    return this.db.transaction((): TestRunAdmission => {
      const prior = this.findByIdempotencyKey(request.actorMembershipId, request.idempotencyKey);
      if (prior) {
        return prior.organizationId === request.organizationId && prior.agentId === request.agentId
          ? { kind: 'replayed', row: prior }
          : { kind: 'key_reused' };
      }
      if (this.row("organization_id = ? AND status IN ('admitted', 'running')", request.organizationId)) {
        return { kind: 'in_progress' };
      }
      const dayStart = utcDayStart(at);
      const runs = Number(this.db.get(
        'SELECT COUNT(*) AS runs FROM management_test_runs WHERE organization_id = ? AND created_at >= ?',
        request.organizationId,
        dayStart,
      )?.runs ?? 0);
      if (runs >= TEST_RUN_DAILY_RUNS || this.listPriceToday(request.organizationId, dayStart) >= TEST_RUN_DAILY_LIMIT_USD_MICROS) {
        return { kind: 'daily_limit', resumesAt: dayStart + DAY_MS };
      }
      this.db.run(
        `INSERT INTO management_test_runs (test_run_id, run_token, coordinate_token, organization_id,
           actor_membership_id, agent_id, status, idempotency_key, instance_id, plan_json, usage_operation_id,
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?, ?)`,
        request.testRunId,
        request.runToken,
        request.coordinateToken,
        request.organizationId,
        request.actorMembershipId,
        request.agentId,
        request.idempotencyKey,
        request.instanceId,
        request.planJson,
        request.usage.operationId,
        at,
        at + TEST_RUN_VISIBLE_MS,
      );
      // The run starts at admission, on the clock its terminal is written by.
      this.usage.admitOperation({ ...request.usage, startedAt: at });
      return { kind: 'admitted', row: this.require(request.testRunId) };
    });
  }

  /**
   * Every model request's list price under today's test runs' submissions.
   * Failed and stopped requests are priced too; an unpriced one counts as zero.
   */
  private listPriceToday(organizationId: string, dayStart: number): number {
    return Number(this.db.get(
      `SELECT COALESCE(SUM(r.list_price_usd_micros), 0) AS micros FROM usage_model_requests r
       WHERE r.run_id IN (
         SELECT submission_id FROM management_test_runs
         WHERE organization_id = ? AND created_at >= ? AND submission_id IS NOT NULL
       )`,
      organizationId,
      dayStart,
    )?.micros ?? 0);
  }

  /**
   * The model-access lookup's binding: the first submission to ask is the
   * run's, whether access is granted or not, and any other is refused.
   * Access is granted only while the run is live with its plan.
   */
  bindModelAccess(instanceId: string, submissionId: string): { runtimePlan: unknown } | undefined {
    return this.db.transaction(() => {
      const row = this.row('instance_id = ?', instanceId);
      if (!row) return undefined;
      if (row.submissionId === null) this.recordSubmission(row.testRunId, submissionId);
      else if (row.submissionId !== submissionId) return undefined;
      const bound = this.require(row.testRunId);
      return (bound.status === 'admitted' || bound.status === 'running') && bound.planJson !== null
        ? { runtimePlan: JSON.parse(bound.planJson) as unknown }
        : undefined;
    });
  }

  /**
   * The dispatch receipt's submission, compare-and-set: one the lookup bound
   * first stands. A live run is `running` once its submission is known.
   */
  recordSubmission(testRunId: string, submissionId: string): TestRunRow {
    this.db.run(
      `UPDATE management_test_runs
       SET submission_id = ?, status = CASE WHEN status = 'admitted' THEN 'running' ELSE status END
       WHERE test_run_id = ? AND submission_id IS NULL`,
      submissionId,
      testRunId,
    );
    return this.require(testRunId);
  }

  /**
   * Compare-and-set from live: the result, the usage terminal, the plan
   * nulled and the lock freed, in one transaction. A run already settled
   * keeps its first settlement; false then.
   */
  settle(testRunId: string, settlement: TestRunSettlement, at: number): boolean {
    return this.db.transaction(() => {
      const changed = this.db.run(
        `UPDATE management_test_runs
         SET status = ?, failure = ?, result_json = ?, plan_json = NULL, settled_at = ?
         WHERE test_run_id = ? AND status IN ('admitted', 'running')`,
        settlement.status,
        settlement.status === 'failed' ? settlement.failure : null,
        settlement.result ? JSON.stringify(settlement.result) : null,
        at,
        testRunId,
      ).changes;
      if (changed === 0) return false;
      this.usage.recordTerminal(settlement.terminal);
      return true;
    });
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

  /** The caller's own run by its token, within the hour it can be read; another's reads as none. */
  read(query: { organizationId: string; actorMembershipId: string; runToken: string }, at: number): TestRunRow | undefined {
    const row = this.row('run_token = ?', query.runToken);
    return row && row.organizationId === query.organizationId && row.actorMembershipId === query.actorMembershipId &&
      at < row.createdAt + TEST_RUN_VISIBLE_MS
      ? row
      : undefined;
  }

  /** Runs whose instance is not erased yet, oldest first. */
  unerased(): TestRunRow[] {
    return (this.db.all('SELECT * FROM management_test_runs WHERE erased_at IS NULL ORDER BY created_at')
      .map((row) => testRunFromRow(row)));
  }

  hasUnerased(): boolean {
    return this.db.get('SELECT 1 AS present FROM management_test_runs WHERE erased_at IS NULL LIMIT 1') !== undefined;
  }

  /** When the alarm looks again, while any run's instance is not erased. */
  nextDueAt(now: number): number | undefined {
    return this.hasUnerased() ? now + TEST_RUN_WAKE_MS : undefined;
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

function testRunFromRow(row: Record<string, unknown>): TestRunRow {
  const nullableNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);
  const nullableString = (value: unknown) => value === null || value === undefined ? null : String(value);
  return {
    testRunId: String(row.test_run_id),
    runToken: String(row.run_token),
    coordinateToken: String(row.coordinate_token),
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
    settledAt: nullableNumber(row.settled_at),
    erasedAt: nullableNumber(row.erased_at),
    expiresAt: Number(row.expires_at),
  };
}
