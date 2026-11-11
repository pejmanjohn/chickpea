/**
 * The state store's practice runs as the card's try_agent_once and
 * get_test_run see them, for card tests and the card harness: a run per
 * caller and key, replayed by that key for the same ask before anything
 * else, for the hour the store keeps it by `now`. Every run reads as
 * `outcome` says, and a start answers `refuse` instead of admitting one
 * while it is set.
 */
import type { TestRunReplayQuery, TestRunStartRequest, TestRunStartResult, TestRunStore, TestRunView } from '../../src/management/test-run-types.ts';
import { TEST_RUN_VISIBLE_MS } from '../../src/management/test-runs.ts';

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
    this.starts.push(request);
    const view: TestRunView = {
      runToken: `tr_stub_${this.runs.length + 1}`, agentId: request.run.agentId, createdAt: this.now(), settledAt: null,
      practiceId: request.run.newPracticeId, turn: request.run.turn, question: request.run.question, ...this.outcome,
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

  private find(ask: Pick<TestRunReplayQuery, 'actorMembershipId' | 'idempotencyKey' | 'agentId' | 'questionDigest'>) {
    const run = this.runs.find(({ request }) => request.run.actorMembershipId === ask.actorMembershipId &&
      request.run.idempotencyKey === ask.idempotencyKey && request.run.agentId === ask.agentId &&
      request.run.questionDigest === ask.questionDigest);
    return run && this.visible(run.view) ? this.read(run.view) : undefined;
  }

  private visible(view: TestRunView): boolean {
    return this.now() < view.createdAt + TEST_RUN_VISIBLE_MS;
  }

  private read(view: TestRunView): TestRunView {
    return { ...view, ...this.outcome, settledAt: this.outcome.status === 'answered' || this.outcome.status === 'failed' ? view.createdAt : null };
  }
}
