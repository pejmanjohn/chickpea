/**
 * The state store's practice runs as the card's try_agent_once and
 * get_test_run see them, for card tests and the card harness: a run per
 * caller and key, replayed by that key for the same ask before anything
 * else, for the hour the store keeps it by `now`. An ask is the store's:
 * the same Agent and question, and the same conversation, a first question
 * matching only a first turn. A follow-up continues the caller's own
 * conversation with that Agent inside its hour and its turns, as the store
 * holds it, or reads as ended. Every run reads as `outcome` says, and a
 * start answers `refuse` instead of admitting one while it is set.
 */
import type {
  PracticeAsk,
  PracticeRunListing,
  PracticeRunsQuery,
  TestRunReplayQuery,
  TestRunStartRequest,
  TestRunStartResult,
  TestRunStore,
  TestRunView,
} from '../../src/management/test-run-types.ts';
import { PRACTICE_TURNS, TEST_RUN_VISIBLE_MS } from '../../src/management/test-runs.ts';

export type TestRunOutcome = Pick<TestRunView, 'status' | 'failure' | 'result'>;

export class StubTestRuns implements TestRunStore {
  readonly starts: TestRunStartRequest[] = [];
  readonly runs: Array<{ request: TestRunStartRequest; view: TestRunView }> = [];
  refuse: Extract<TestRunStartResult, { kind: 'in_progress' }> | undefined;
  now: () => number = () => 0;

  constructor(public outcome: TestRunOutcome) {}

  async start(request: TestRunStartRequest): Promise<TestRunStartResult> {
    const prior = this.find(request.run);
    if (prior) return { kind: 'replayed', run: prior };
    if (this.refuse) return this.refuse;
    const { practiceId } = request.run;
    let turn = 1;
    if (practiceId !== null) {
      const turns = this.runs.filter(({ request: { run }, view }) =>
        view.practiceId === practiceId && run.actorMembershipId === request.run.actorMembershipId);
      const first = turns[0]?.view;
      if (!first || first.agentId !== request.run.agentId || this.now() >= first.createdAt + TEST_RUN_VISIBLE_MS ||
          turns.length >= PRACTICE_TURNS) {
        return { kind: 'ended' };
      }
      turn = turns.length + 1;
    }
    this.starts.push(request);
    const view: TestRunView = {
      runToken: `tr_stub_${this.runs.length + 1}`, agentId: request.run.agentId, createdAt: this.now(), settledAt: null,
      practiceId: practiceId ?? request.run.newPracticeId, turn, question: request.run.question, ...this.outcome,
    };
    this.runs.push({ request, view });
    return { kind: 'admitted', run: this.read(view) };
  }

  async replay(query: TestRunReplayQuery) {
    return this.find(query);
  }

  async observe(query: { actorMembershipId: string; runToken: string }) {
    const run = this.runs.find(({ request, view }) => view.runToken === query.runToken && request.run.actorMembershipId === query.actorMembershipId);
    return run && this.visible(run.view) ? this.read(run.view) : undefined;
  }

  async list(query: PracticeRunsQuery): Promise<PracticeRunListing[]> {
    return this.runs
      .filter(({ request: { run }, view }) => run.organizationId === query.organizationId &&
        run.actorMembershipId === query.actorMembershipId && view.agentId === query.agentId && this.visible(view))
      .reverse()
      .map(({ view }) => ({
        runToken: view.runToken, practiceId: view.practiceId!, turn: view.turn!, status: this.outcome.status,
        question: view.question!, createdAt: view.createdAt,
      }));
  }

  private find(ask: Pick<TestRunReplayQuery, 'actorMembershipId' | 'idempotencyKey'> & PracticeAsk) {
    const run = this.runs.find(({ request, view }) => request.run.actorMembershipId === ask.actorMembershipId &&
      request.run.idempotencyKey === ask.idempotencyKey && view.agentId === ask.agentId &&
      request.run.questionDigest === ask.questionDigest &&
      (ask.practiceId === null ? view.turn === 1 : view.practiceId === ask.practiceId && (view.turn ?? 0) > 1));
    return run && this.visible(run.view) ? this.read(run.view) : undefined;
  }

  private visible(view: TestRunView): boolean {
    return this.now() < view.createdAt + TEST_RUN_VISIBLE_MS;
  }

  private read(view: TestRunView): TestRunView {
    return { ...view, ...this.outcome, settledAt: this.outcome.status === 'answered' || this.outcome.status === 'failed' ? view.createdAt : null };
  }
}
