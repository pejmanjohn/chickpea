/**
 * The state store's practice runs as the cards see them, for card tests and
 * the card harness. As the store does: a run per caller and key, replayed by
 * that key for the same ask before anything else. An ask is the store's: the
 * same Agent and question, and the same conversation, a first question
 * matching only a first turn. The same ask going is that run, and one
 * answered on the same plan in the last two minutes is that run again
 * (`repeat`). A follow-up continues the caller's own conversation with that
 * Agent within an hour of its latest answer and inside its turns, as the
 * store holds it, or reads as ended. A settled run reads for the hour from its settlement, with what
 * admission stored beside its outcome, and an answered first question names
 * the latest earlier answer to it from another version of the Agent
 * (`before`). A run reads as `outcome` says until it first reads as settled,
 * and keeps that outcome; a start answers `refuse` instead of admitting one
 * while it is set. It keeps no step's result beyond its excerpt.
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
import { PRACTICE_REPEAT_MS, PRACTICE_TURNS, TEST_RUN_VISIBLE_MS } from '../../src/management/test-runs.ts';

export type TestRunOutcome = Pick<TestRunView, 'status' | 'failure' | 'result'>;

interface StubRun {
  request: TestRunStartRequest;
  view: TestRunView;
  /** The outcome it settled with, and when. */
  settled?: TestRunOutcome & { settledAt: number };
}

type Ask = Pick<TestRunReplayQuery, 'actorMembershipId'> & PracticeAsk;

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
    const same = this.runs.filter((run) => sameAsk(run, request.run) && this.visible(run)).reverse();
    const going = same.find((run) => !this.settle(run));
    if (going) return { kind: 'running', run: this.read(going) };
    const repeat = same.find((run) => run.settled?.status === 'answered' && run.settled.settledAt >= this.now() - PRACTICE_REPEAT_MS &&
      run.request.run.planDigest === request.run.planDigest);
    if (repeat) return { kind: 'repeat', run: { ...this.read(repeat), repeat: true } };
    const { practiceId } = request.run;
    let turn = 1;
    if (practiceId !== null) {
      const turns = this.runs.filter(({ request: { run }, view }) =>
        view.practiceId === practiceId && run.actorMembershipId === request.run.actorMembershipId);
      const latest = turns.findLast((run) => this.settle(run)?.status === 'answered') ?? turns[0];
      if (!latest || turns.some(({ view }) => view.agentId !== request.run.agentId) || !this.visible(latest) ||
          turns.length >= PRACTICE_TURNS) {
        return { kind: 'ended' };
      }
      turn = turns.length + 1;
    }
    this.starts.push(request);
    const run: StubRun = {
      request,
      view: {
        runToken: `tr_stub_${this.runs.length + 1}`, agentId: request.run.agentId, createdAt: this.now(), settledAt: null,
        practiceId: practiceId ?? request.run.newPracticeId, turn, question: request.run.question, ...this.outcome,
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

  async list(query: PracticeRunsQuery): Promise<PracticeRunListing[]> {
    return this.runs
      .filter((run) => run.request.run.organizationId === query.organizationId &&
        run.request.run.actorMembershipId === query.actorMembershipId && run.view.agentId === query.agentId && this.visible(run))
      .reverse()
      .map((run) => ({
        runToken: run.view.runToken, practiceId: run.view.practiceId!, turn: run.view.turn!, status: this.read(run).status,
        question: run.view.question!, createdAt: run.view.createdAt,
      }));
  }

  async stepResult(): Promise<undefined> {
    return undefined;
  }

  private find(ask: Ask & Pick<TestRunReplayQuery, 'idempotencyKey'>) {
    const run = this.runs.find((run) => run.request.run.idempotencyKey === ask.idempotencyKey && sameAsk(run, ask));
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
    if (version === undefined || run.view.turn !== 1) return undefined;
    const earlier = this.runs.slice(0, this.runs.indexOf(run)).reverse().find((other) => sameAsk(other, run.request.run) &&
      other.settled?.status === 'answered' && this.visible(other) && other.request.run.admitted.ran?.agentVersion !== undefined &&
      other.request.run.admitted.ran.agentVersion !== version);
    return earlier ? { runToken: earlier.view.runToken, agentVersion: earlier.request.run.admitted.ran!.agentVersion } : undefined;
  }
}

/** The store's same ask: the same caller, Agent and question, a first question matching only a first turn. */
function sameAsk(run: StubRun, ask: Ask): boolean {
  const { view } = run;
  if (run.request.run.actorMembershipId !== ask.actorMembershipId || view.agentId !== ask.agentId ||
      run.request.run.questionDigest !== ask.questionDigest) return false;
  return ask.practiceId === null ? view.turn === 1 : view.practiceId === ask.practiceId && (view.turn ?? 0) > 1;
}
