/**
 * The state store's practice runs as the cards see them, for card tests and
 * the card harness. As the store does: a run per caller and key, replayed by
 * that key for the same ask before anything else; the same first question
 * going is that run, and one answered on the same plan in the last two
 * minutes is that run again (`repeat`); a settled run reads for the hour
 * from its settlement, with what admission stored beside its outcome, and an
 * answered one names the latest earlier answer to the same question from
 * another version of the Agent (`before`). A run reads as `outcome` says
 * until it first reads as settled, and keeps that outcome; a start answers
 * `refuse` instead of admitting one while it is set.
 */
import type { TestRunReplayQuery, TestRunStartRequest, TestRunStartResult, TestRunStore, TestRunView } from '../../src/management/test-run-types.ts';
import { PRACTICE_REPEAT_MS, TEST_RUN_VISIBLE_MS } from '../../src/management/test-runs.ts';

export type TestRunOutcome = Pick<TestRunView, 'status' | 'failure' | 'result'>;

interface StubRun {
  request: TestRunStartRequest;
  view: TestRunView;
  /** The outcome it settled with, and when. */
  settled?: TestRunOutcome & { settledAt: number };
}

export class StubTestRuns implements TestRunStore {
  readonly starts: TestRunStartRequest[] = [];
  readonly runs: StubRun[] = [];
  refuse: Extract<TestRunStartResult, { kind: 'in_progress' }> | undefined;
  now: () => number = () => 0;

  constructor(public outcome: TestRunOutcome) {}

  async start(request: TestRunStartRequest): Promise<TestRunStartResult> {
    const prior = this.find(request.run);
    if (prior) return { kind: 'replayed', run: prior };
    if (this.refuse) return this.refuse;
    const same = this.runs.filter((run) => sameAsk(run.request, request) && this.visible(run)).reverse();
    const going = same.find((run) => !this.settle(run));
    if (going) return { kind: 'running', run: this.read(going) };
    const repeat = same.find((run) => run.settled?.status === 'answered' && run.settled.settledAt >= this.now() - PRACTICE_REPEAT_MS &&
      run.request.run.planDigest === request.run.planDigest);
    if (repeat) return { kind: 'repeat', run: { ...this.read(repeat), repeat: true } };
    this.starts.push(request);
    const run: StubRun = {
      request,
      view: {
        runToken: `tr_stub_${this.runs.length + 1}`, agentId: request.run.agentId, createdAt: this.now(), settledAt: null,
        practiceId: request.run.newPracticeId, turn: request.run.turn, question: request.run.question, ...this.outcome,
      },
    };
    this.runs.push(run);
    return { kind: 'admitted', run: this.read(run) };
  }

  async replay(query: TestRunReplayQuery) {
    return this.find(query);
  }

  async observe(query: { actorMembershipId: string; runToken: string }) {
    const run = this.runs.find(({ request, view }) => view.runToken === query.runToken && request.run.actorMembershipId === query.actorMembershipId);
    return run && this.visible(run) ? this.read(run) : undefined;
  }

  private find(ask: Pick<TestRunReplayQuery, 'actorMembershipId' | 'idempotencyKey' | 'agentId' | 'questionDigest'>) {
    const run = this.runs.find(({ request }) => request.run.actorMembershipId === ask.actorMembershipId &&
      request.run.idempotencyKey === ask.idempotencyKey && request.run.agentId === ask.agentId &&
      request.run.questionDigest === ask.questionDigest);
    return run && this.visible(run) ? this.read(run) : undefined;
  }

  /** The outcome a run settled with: the first settled `outcome` it reads, kept from then on. */
  private settle(run: StubRun): StubRun['settled'] {
    if (!run.settled && (this.outcome.status === 'answered' || this.outcome.status === 'failed')) {
      run.settled = { ...this.outcome, settledAt: this.now() };
    }
    return run.settled;
  }

  /** As the store: a run going reads, a settled one for an hour from its settlement. */
  private visible(run: StubRun): boolean {
    const settled = this.settle(run);
    return !settled || this.now() < settled.settledAt + TEST_RUN_VISIBLE_MS;
  }

  private read(run: StubRun): TestRunView {
    const settled = this.settle(run);
    const { admitted } = run.request.run;
    const outcome = settled ?? this.outcome;
    const result = settled ? { ...admitted, ...settled.result } : Object.keys(admitted).length > 0 ? admitted : outcome.result;
    const view: TestRunView = { ...run.view, status: outcome.status, failure: outcome.failure, result, settledAt: settled?.settledAt ?? null };
    const before = settled?.status === 'answered' ? this.before(run, view) : undefined;
    return before ? { ...view, before } : view;
  }

  /** The latest earlier answered run of the same first question, still readable, of another version of the Agent. */
  private before(run: StubRun, view: TestRunView): TestRunView['before'] {
    const version = view.result?.ran?.agentVersion;
    if (version === undefined || run.request.run.turn !== 1) return undefined;
    const earlier = this.runs.slice(0, this.runs.indexOf(run)).reverse().find((other) => sameAsk(other.request, run.request) &&
      other.settled?.status === 'answered' && this.visible(other) && other.request.run.admitted.ran?.agentVersion !== undefined &&
      other.request.run.admitted.ran.agentVersion !== version);
    return earlier ? { runToken: earlier.view.runToken, agentVersion: earlier.request.run.admitted.ran!.agentVersion } : undefined;
  }
}

/** The store's same ask, for a first question: the same caller, Agent and question. */
function sameAsk(a: TestRunStartRequest, b: TestRunStartRequest): boolean {
  return a.run.actorMembershipId === b.run.actorMembershipId && a.run.agentId === b.run.agentId &&
    a.run.questionDigest === b.run.questionDigest && a.run.turn === 1 && b.run.turn === 1;
}
