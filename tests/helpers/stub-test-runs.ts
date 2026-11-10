/**
 * The state store's test runs as try_agent_once and get_test_run see them,
 * for card tests and the card harness: a run per caller and key, replayed by
 * that key before anything else. Every run reads as `outcome` says, and a
 * start answers `refuse` instead of admitting one while it is set.
 */
import type { TestRunStartRequest, TestRunStartResult, TestRunStore, TestRunView } from '../../src/management/test-run-types.ts';

export type TestRunOutcome = Pick<TestRunView, 'status' | 'failure' | 'result'>;

export class StubTestRuns implements TestRunStore {
  readonly starts: TestRunStartRequest[] = [];
  readonly runs: Array<{ request: TestRunStartRequest; view: TestRunView }> = [];
  refuse: Extract<TestRunStartResult, { kind: 'in_progress' | 'daily_limit' }> | undefined;

  constructor(public outcome: TestRunOutcome) {}

  async start(request: TestRunStartRequest): Promise<TestRunStartResult> {
    const replayed = this.find(request.run.actorMembershipId, request.run.idempotencyKey);
    if (replayed) return { kind: 'replayed', run: replayed };
    if (this.refuse) return this.refuse;
    this.starts.push(request);
    const view = { runToken: `tr_stub_${this.runs.length + 1}`, agentId: request.run.agentId, createdAt: 0, ...this.outcome };
    this.runs.push({ request, view });
    return { kind: 'admitted', run: this.read(view) };
  }

  async replay(query: { actorMembershipId: string; idempotencyKey: string }) {
    return this.find(query.actorMembershipId, query.idempotencyKey);
  }

  async observe(query: { actorMembershipId: string; runToken: string }) {
    const run = this.runs.find(({ request, view }) => view.runToken === query.runToken && request.run.actorMembershipId === query.actorMembershipId);
    return run && this.read(run.view);
  }

  private find(actor: string, key: string) {
    const run = this.runs.find(({ request }) => request.run.actorMembershipId === actor && request.run.idempotencyKey === key);
    return run && this.read(run.view);
  }

  private read(view: TestRunView): TestRunView {
    return { ...view, ...this.outcome };
  }
}
