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
  PracticeKeptResult,
  PracticeRunListing,
  PracticeRunsQuery,
  PracticeTurn,
  TestRunAdmission,
  TestRunAdmissionRequest,
  TestRunFailure,
  TestRunModelAccessBinding,
  TestRunResult,
  TestRunRow,
  TestRunSettlement,
  TestRunStatus,
  TestRunStepQuery,
  TestRunStepResult,
} from './test-run-types.ts';

/** A run answered this recently answers the same ask on the same plan again, rather than run twice. */
export const PRACTICE_REPEAT_MS = 2 * 60_000;
/**
 * A settled run reads as not found this long after it settled, and it is
 * erased then. A run still going always reads: it can run as long as a direct
 * message, past the hour. A practice conversation takes follow-ups for as
 * long from its latest answer; it quotes only the turns still kept.
 */
export const TEST_RUN_VISIBLE_MS = 60 * 60_000;
/** What get_practice_run returns of a step's kept result at once, in characters. */
export const PRACTICE_STEP_READ_CHARS = 20_000;
/** A practice conversation's questions, at most. */
export const PRACTICE_TURNS = 10;
/** A listing's runs, newest first, at most. */
export const PRACTICE_LISTED_RUNS = 20;
/** How often the state store's alarm looks at a run whose instance is not erased yet. */
export const TEST_RUN_WAKE_MS = 10_000;

/** Rows one alarm deletes; the next alarm takes the rest. */
const ERASE_BATCH = 250;
const HAS_TEXT = '(result_json IS NOT NULL OR question IS NOT NULL OR question_digest IS NOT NULL)';
const SETTLED = "status NOT IN ('admitted', 'running')";
const LIVE = "status IN ('admitted', 'running')";
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
  // A step's cut result, kept whole within the run's total, beside its run and for its hour (practice-steps.ts).
  db.exec(
    `CREATE TABLE IF NOT EXISTS management_test_run_results (
      test_run_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (test_run_id, step)
    )`,
  );
}

/**
 * A run's text goes once it can no longer be read, whether or not its
 * instance is erased yet: the question, the reply, its steps and the
 * question's digest, and the results kept beside it. Kept results go first,
 * and whenever no run they belong to can still be read, so none outlives its
 * run's text, whatever stopped an earlier pass.
 */
function eraseTestRunText(db: StateDb, at: number): number {
  db.run(
    `DELETE FROM management_test_run_results WHERE NOT EXISTS (
       SELECT 1 FROM management_test_runs AS run
       WHERE run.test_run_id = management_test_run_results.test_run_id
         AND (run.${LIVE} OR COALESCE(run.settled_at, run.created_at) > ?)
     )`,
    at - TEST_RUN_VISIBLE_MS,
  );
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

type Conversation =
  | { kind: 'open'; practiceId: string; turn: number; earlier: PracticeTurn[]; expired: number }
  | Extract<TestRunAdmission, { kind: 'ended' | 'in_progress' }>;

/** Admitted or running: not settled yet. */
export function liveTestRun(row: Pick<TestRunRow, 'status'>): boolean {
  return row.status === 'admitted' || row.status === 'running';
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
   * the same plan, the conversation a follow-up continues, then the row and
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
      const running = same.find(liveTestRun);
      if (running) return { kind: 'running', row: running };
      // Only an answer is given again: a run that failed is asked again, as a direct message would be.
      const repeat = same.find((row) => row.status === 'answered' && row.settledAt !== null &&
        row.settledAt >= at - PRACTICE_REPEAT_MS && row.planDigest === request.planDigest);
      if (repeat) return { kind: 'repeat', row: repeat };
      let conversation: Extract<Conversation, { kind: 'open' }> = {
        kind: 'open', practiceId: request.newPracticeId, turn: 1, earlier: [], expired: 0,
      };
      if (request.practiceId !== null) {
        const continued = this.conversation(request, request.practiceId, at);
        if (continued.kind !== 'open') return continued;
        conversation = continued;
      }
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
          conversation.practiceId,
          conversation.turn,
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
      return { kind: 'admitted', row: this.require(request.testRunId), earlier: conversation.earlier, expired: conversation.expired };
    });
  }

  /**
   * The conversation a follow-up continues, from the caller's own rows: open
   * while it names this Agent, has a turn left, and its latest answer is
   * under an hour old (with none answered, the end of its first turn). A
   * turn's row goes an hour after it settles, so a conversation whose first
   * turn is gone and whose rows hold no answer has ended: whether an answer
   * that old is still a row or not, it reads the same. Its turns run one
   * after another, so the next waits for the last to settle, however long
   * that takes. Each turn keeps its text for its own hour, so a follow-up
   * quotes the answered turns still kept and counts the older ones it can't.
   * A failed turn is not quoted to the next.
   */
  private conversation(ask: Caller & PracticeAsk, practiceId: string, at: number): Conversation {
    const turns = this.db.all(
      `SELECT * FROM management_test_runs
       WHERE organization_id = ? AND actor_membership_id = ? AND practice_id = ? AND turn IS NOT NULL
       ORDER BY turn`,
      ask.organizationId,
      ask.actorMembershipId,
      practiceId,
    ).map((row) => testRunFromRow(row));
    const latest = turns.at(-1);
    const last = latest?.turn ?? 0;
    if (!latest || turns.some(({ agentId }) => agentId !== ask.agentId) || last >= PRACTICE_TURNS) return { kind: 'ended' };
    const going = turns.find(liveTestRun);
    if (going) return { kind: 'in_progress', runToken: going.runToken };
    const since = turns.findLast(({ status }) => status === 'answered') ?? turns.find(({ turn }) => turn === 1);
    if (!since || !readable(since, at)) return { kind: 'ended' };
    const kept = turns.filter((row) => row.status === 'answered' && row.question !== null && readable(row, at));
    // Turns settle in order, so the ones gone or past their hour are the oldest; a failed one is never quoted anyway.
    const expired = last - turns.length + turns.filter((row) => row.status === 'answered' && !kept.includes(row)).length;
    return {
      kind: 'open',
      practiceId,
      turn: last + 1,
      earlier: kept.map(({ turn, question, result }) => ({
        turn: turn!,
        question: question!,
        reply: result?.reply ?? '',
        steps: result?.steps ?? [],
        ...(result?.moreSteps ? { moreSteps: result.moreSteps } : {}),
      })),
      expired,
    };
  }

  /** A follow-up's earlier turns its message left out for length, kept beside its outcome; written before its dispatch. */
  recordDroppedTurns(testRunId: string, droppedTurns: number): void {
    const result = this.get(testRunId)?.result ?? {};
    this.db.run(
      `UPDATE management_test_runs SET result_json = ? WHERE test_run_id = ? AND status = 'admitted'`,
      JSON.stringify({ ...result, droppedTurns } satisfies TestRunResult),
      testRunId,
    );
  }

  /**
   * The caller's practice runs of one Agent they can still read, newest
   * first: each going, or settled within its hour, as `read` reads them.
   * Another person's never.
   */
  list(query: PracticeRunsQuery, at: number): PracticeRunListing[] {
    return this.db.all(
      `SELECT * FROM management_test_runs
       WHERE organization_id = ? AND actor_membership_id = ? AND agent_id = ? AND (${LIVE} OR ${HOUR_FROM} > ?)
         AND practice_id IS NOT NULL AND turn IS NOT NULL AND question IS NOT NULL
       ORDER BY created_at DESC, turn DESC
       LIMIT ?`,
      query.organizationId,
      query.actorMembershipId,
      query.agentId,
      at - TEST_RUN_VISIBLE_MS,
      PRACTICE_LISTED_RUNS,
    ).map((value) => {
      const row = testRunFromRow(value);
      const agentVersion = row.result?.ran?.agentVersion;
      return {
        runToken: row.runToken,
        practiceId: row.practiceId!,
        turn: row.turn!,
        status: row.status,
        question: row.question!,
        createdAt: row.createdAt,
        ...(agentVersion ? { agentVersion } : {}),
      };
    });
  }

  /**
   * For an answered first question: the caller's latest earlier answered run
   * of the same question to the same Agent, still readable, that ran another
   * version of the Agent. Never one of the same version, which says nothing
   * of a change.
   */
  before(row: TestRunRow, at: number): { runToken: string; agentVersion: string } | undefined {
    const version = row.result?.ran?.agentVersion;
    if (row.status !== 'answered' || row.turn !== 1 || row.questionDigest === null || version === undefined) return undefined;
    const earlier = this.db.all(
      `SELECT * FROM management_test_runs
       WHERE organization_id = ? AND created_at < ? AND actor_membership_id = ? AND agent_id = ?
         AND question_digest = ? AND turn = 1 AND status = 'answered' AND settled_at > ?
       ORDER BY created_at DESC`,
      row.organizationId,
      row.createdAt,
      row.actorMembershipId,
      row.agentId,
      row.questionDigest,
      at - TEST_RUN_VISIBLE_MS,
    ).map((found) => testRunFromRow(found)).find((found) => {
      const other = found.result?.ran?.agentVersion;
      return other !== undefined && other !== version;
    });
    const agentVersion = earlier?.result?.ran?.agentVersion;
    return earlier && agentVersion ? { runToken: earlier.runToken, agentVersion } : undefined;
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
    return this.db.transaction(() => this.settleRow(testRunId, settlement));
  }

  /**
   * What admission stored of the run (what it could not use, what it ran)
   * stays beside its outcome, and the results its steps cut are kept beside
   * the row. Call it inside a transaction.
   */
  private settleRow(testRunId: string, settlement: TestRunSettlement): boolean {
    const admitted = this.get(testRunId)?.result ?? {};
    const result = { ...admitted, ...settlement.result };
    const settled = this.db.run(
      `UPDATE management_test_runs
       SET status = ?, failure = ?, result_json = ?, plan_json = NULL, settled_at = ?
       WHERE test_run_id = ? AND ${LIVE}`,
      settlement.status,
      settlement.status === 'failed' ? settlement.failure : null,
      Object.keys(result).length > 0 ? JSON.stringify(result) : null,
      settlement.terminal.finishedAt,
      testRunId,
    ).changes > 0;
    if (settled && settlement.status === 'answered') this.keepResults(testRunId, settlement.results ?? []);
    return settled;
  }

  private keepResults(testRunId: string, results: readonly PracticeKeptResult[]): void {
    for (const { step, data } of results) {
      this.db.run(
        'INSERT OR REPLACE INTO management_test_run_results (test_run_id, step, data) VALUES (?, ?, ?)',
        testRunId,
        step,
        data,
      );
    }
  }

  /**
   * What the store kept of one listed step's cut result, from `offset`: the
   * caller's own answered run only, and only while they can read it.
   */
  stepResult(query: TestRunStepQuery, at: number): TestRunStepResult | undefined {
    const row = this.read(query, at);
    if (row?.status !== 'answered') return undefined;
    const kept = this.db.get(
      'SELECT data FROM management_test_run_results WHERE test_run_id = ? AND step = ?',
      row.testRunId,
      query.step,
    );
    if (!kept) return undefined;
    const data = String(kept.data);
    return { data: data.slice(query.offset, query.offset + PRACTICE_STEP_READ_CHARS), kept: data.length };
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

/** A run going reads; a settled one, for an hour from its settlement. */
function readable(row: TestRunRow, at: number): boolean {
  return row.status === 'admitted' || row.status === 'running' || at < (row.settledAt ?? row.createdAt) + TEST_RUN_VISIBLE_MS;
}

/**
 * Two asks are one when they name the same Agent and question, and both
 * start a conversation or both continue the same one. A new conversation's
 * ID is minted per run, so it cannot tell two first questions apart.
 */
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
