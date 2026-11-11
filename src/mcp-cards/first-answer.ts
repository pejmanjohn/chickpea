import { isAgentId } from '../config/agent-id.ts';
import {
  agentNamed,
  call,
  errorCode,
  errorOf,
  GENERIC,
  httpsUrl,
  isFix,
  isRecord,
  opensSetupLink,
  outdated,
  pollDelay,
  quoted,
  refusalOf,
  show,
  stay,
  tell,
  UNREACHABLE,
  type Block,
  type Button,
  type Call,
  type CardEvent,
  type CardState,
  type Effect,
  type Fix,
  type Next,
  type Presentation,
  type ToolResult,
} from './card-model.ts';

/**
 * "See its first answer": one practice run of an Agent on its saved first
 * question, as a view a card shows in place of its own. "Try it again" on a
 * Saved card is the same run after a change, drawn as Before and After. Only
 * a press starts one. The press sends practice_agent with the view's key and
 * no question, and every call this view sends again for that press, after
 * the host gave up on one or while another practice run was going, carries
 * the same key, so it gets the run the first call started. get_practice_run
 * then follows the run until it answers, fails, or three minutes pass. A key
 * past the hour Chickpea keeps a run for starts nothing, so a press after
 * that sends a new one.
 *
 * `busy` holds while this page has a call out or a retry due. A card that
 * mounts again has neither: its re-read follows a run it knows of with
 * get_practice_run, and asks for a press for one it does not. The host keeps
 * a run's token only while that run is still going when the card stops
 * waiting (`stillAnswering`), where its model never reads it.
 */

export type FirstAnswerAction = 'try_once' | 'try_fix' | 'open_slack' | 'change_something' | 'check_again';

/** The Agent a card tests, as that card knows it. */
export interface Tested {
  agentId: string;
  name: string;
  handle?: string | undefined;
  avatarUrl?: string | undefined;
  slackUrl?: string | undefined;
  /** The question and answer the proposal this card created the Agent from promised. */
  promised?: { ask: string; answer: string } | undefined;
}

type Acted = { kind: 'page'; url: string } | { kind: 'chat' };

/** A connection a run left out, for nothing in it is marked as only reading, with its fix when the result names one. */
type LeftOut = { service: string; fix?: Fix };

type Stage =
  /** practice_agent is out, or with `retry`, due again on the next tick. */
  | { kind: 'asking'; failures?: number; heldSince?: number; retry?: true }
  /** get_practice_run is out, or with `retry`, due again on the next tick. */
  | { kind: 'running'; runToken: string; ask: string; failures?: number; retry?: true }
  /**
   * `version`: the Agent's version the run ran. `before`: on Try it again,
   * the answer to the same question from another version, once read;
   * `reading` holds the run's token while that read is out. A fix for a
   * connection the run left out acts as a stopped run's does.
   */
  | {
      kind: 'answered'; ask: string; reply: string; read: string[]; version?: string;
      before?: string; reading?: string; leftOut: LeftOut[]; acted?: Acted;
    }
  /**
   * It did not start (`refused`) or did not finish: Chickpea's own sentence,
   * and what the person can do next. Once they act on its fix, on the
   * Chickpea page it opened or in the chat, it offers Try again.
   */
  | { kind: 'stopped'; problem: string; then: 'fix' | 'again' | 'slack'; refused?: true; fix?: Fix; fixing?: true; acted?: Acted }
  /**
   * Three minutes and no answer. With the run's token, it is still going:
   * Check again reads that run, never starts one. `again`: Check again
   * found it still answering.
   */
  | { kind: 'slow'; runToken?: string; again?: true }
  /** The card mounted again while its first call was out: that answer went to the card that closed. */
  | { kind: 'lost' };

/** "Try it again", pressed on a Saved card. */
export interface Again {
  /** The Saved card's title, which a card that mounts again comes back to. */
  summary: string;
  /** The Saved card's Undo, which the Agent card offers beside the answer. Never kept by the host. */
  undoToken?: string | undefined;
}

export interface FirstAnswer {
  kind: 'first_answer';
  tested: Tested;
  again?: Again | undefined;
  /** The answer this card showed before the press, kept above a run that did not come to one. */
  earlier?: Shown | undefined;
  /** Every practice_agent this view sends carries it. */
  key: string;
  /** When the key was made: past KEY_FOR_MS it starts nothing. */
  keyedAt: number;
  /** The press, or when a run held up by another began; the card gives up three minutes after it. */
  startedAt: number;
  stage: Stage;
}

/** An answer the card showed, which a later press that did not come to one leaves in place. */
type Shown = Pick<Extract<Stage, { kind: 'answered' }>, 'ask' | 'reply' | 'before'>;

type State = CardState<FirstAnswer>;

export const GIVE_UP_MS = 3 * 60_000;
export const HELD_RETRY_MS = 5_000;
export const HELD_FOR_MS = 60_000;
/** Chickpea keeps a practice run, and replays its key, for an hour. */
export const KEY_FOR_MS = 60 * 60_000;

/** The press on "See its first answer". */
export function tryOnce(tested: Tested, now: number): Next<FirstAnswer> {
  return start(tested, undefined, now);
}

/** The press on "Try it again": the same question, its answer drawn beside one from before the change, when Chickpea has one. */
export function tryAgain(tested: Tested, again: Again, now: number): Next<FirstAnswer> {
  return start(tested, again, now);
}

function start(tested: Tested, again: Again | undefined, now: number, earlier?: Shown): Next<FirstAnswer> {
  return ask({
    kind: 'first_answer', tested, ...again ? { again } : {}, ...earlier ? { earlier } : {},
    key: `try:${tested.agentId}:${now}`, keyedAt: now, startedAt: now, stage: { kind: 'asking' },
  });
}

/** The answer a new press leaves in place: the one shown now, or the one an earlier press left. */
function shownNow(view: FirstAnswer): Shown | undefined {
  const { stage } = view;
  if (stage.kind !== 'answered' || stage.reading) return view.earlier;
  return { ask: stage.ask, reply: stage.reply, ...stage.before === undefined ? {} : { before: stage.before } };
}

/** With no question, the run asks the first question saved when the Agent was created. */
function ask(view: FirstAnswer): Next<FirstAnswer> {
  return {
    state: { view, busy: true },
    effects: [call('practice_agent', { agentId: view.tested.agentId, idempotencyKey: view.key })],
  };
}

function poll(runToken: string): Effect {
  return call('get_practice_run', { runToken });
}

export function stepFirstAnswer<A extends string>(state: State, event: CardEvent<A>): Next<FirstAnswer> {
  switch (event.type) {
    case 'press':
      return state.busy ? stay(state) : press(state, event.action as string, event.now);
    case 'reply':
      return outdated(state, event.call) ? stay(state) : reply(state, event.call, event.result, event.now);
    case 'unreachable':
      return outdated(state, event.call) ? stay(state) : unreachable(state, event.call, event.now);
    case 'refused':
      return refusedEffect(state, event.effect);
    case 'tick':
      return tick(state, event.now);
    case 'reread':
      return state.busy ? stay(state) : reread(state);
    default:
      return stay(state);
  }
}

function press(state: State, action: string, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage, tested } = view;
  switch (action) {
    case 'try_once': {
      // A new run, under a new key: Try it again, or Try again once the person acted on a left-out connection's fix.
      if (stage.kind === 'answered' && !stage.reading && (view.again || stage.acted)) return start(tested, view.again, now, shownNow(view));
      const again = stage.kind === 'lost' ||
        (stage.kind === 'stopped' && (stage.then === 'again' || (stage.then === 'fix' && stage.acted !== undefined)));
      return again ? askAgainByPress(view, now) : stay(state);
    }
    case 'try_fix': {
      if (stage.kind === 'answered') {
        // A link opens; any other fix goes to the chat, where the model proposes it first.
        const fix = leftOutFix(stage);
        if (!fix) return stay(state);
        if ('url' in fix) return show({ ...view, stage: { ...stage, acted: { kind: 'page', url: fix.url } } }, [{ type: 'open', url: fix.url }]);
        return show({ ...view, stage: { ...stage, acted: { kind: 'chat' } } }, [askChat(view, fix)]);
      }
      const fix = stage.kind === 'stopped' ? stage.fix : undefined;
      if (stage.kind !== 'stopped' || !fix) return stay(state);
      if ('url' in fix) return show({ ...view, stage: { ...stage, acted: { kind: 'page', url: fix.url } } }, [{ type: 'open', url: fix.url }]);
      if (opensSetupLink(fix)) return { state: { view: { ...view, stage: { ...stage, fixing: true } }, busy: true }, effects: [call(fix.tool, fix.arguments)] };
      return show({ ...view, stage: { ...stage, acted: { kind: 'chat' } } }, [askChat(view, fix)]);
    }
    case 'check_again':
      if (stage.kind !== 'slow') return stay(state);
      // One read of the run it knows of; with none, the first press's call again.
      return stage.runToken ? { state: { view, busy: true }, effects: [poll(stage.runToken)] } : askAgainByPress(view, now);
    case 'open_slack':
      return tested.slackUrl ? stay(state, [{ type: 'open', url: tested.slackUrl }]) : stay(state);
    case 'change_something':
      return stage.kind === 'answered'
        ? stay(state, [{ type: 'message', draft: `Change ${tested.name}: `, sent: `Change ${tested.name}: ` }])
        : stay(state);
    default:
      return stay(state);
  }
}

/**
 * The same key while it and its retries last: a run the first press started
 * is the one this press gets. Past that, a new key.
 */
function askAgainByPress(view: FirstAnswer, now: number): Next<FirstAnswer> {
  return now - view.keyedAt < KEY_FOR_MS - GIVE_UP_MS - 60_000
    ? ask({ ...view, startedAt: now, stage: { kind: 'asking' } })
    : start(view.tested, view.again, now, view.earlier);
}

/** A fix the card does not run itself: the model proposes it in the chat first. */
function askChat(view: FirstAnswer, fix: Fix): Effect {
  return { type: 'message', sent: `${fix.label} for ${view.tested.name}.` };
}

/**
 * The host did not open a link or take a message. Only one this view offers
 * counts. A fix it did not take was not acted on, so the fix is offered again.
 */
function refusedEffect(state: State, effect: Extract<CardEvent<string>, { type: 'refused' }>['effect']): Next<FirstAnswer> {
  const { view } = state;
  const { stage, tested } = view;
  if ((stage.kind === 'stopped' || stage.kind === 'answered') && stage.acted &&
    (stage.acted.kind === 'page' ? effect.type === 'open' && effect.url === stage.acted.url : effect.type === 'message')) {
    const { acted: _acted, ...rest } = stage;
    return stay({ view: { ...view, stage: rest }, busy: false, error: GENERIC });
  }
  const offered = effect.type === 'open'
    ? effect.url === tested.slackUrl && (stage.kind === 'answered' || stage.kind === 'stopped' || stage.kind === 'slow')
    : stage.kind === 'answered';
  return offered ? stay({ ...state, error: GENERIC }) : stay(state);
}

function reply(state: State, made: Call, result: ToolResult, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  const { tool } = made;
  if (tool === 'get_practice_run' && stage.kind === 'answered' && stage.reading === made.args.runToken) return beforeRead(view, stage, result);
  if (tool === 'practice_agent' && stage.kind === 'asking') return fromAsk(view, stage, result, now);
  if (tool === 'get_practice_run' && (stage.kind === 'running' || stage.kind === 'slow')) return polled(state, result, now);
  if (stage.kind === 'stopped' && stage.fixing) return fixed(view, stage, result);
  return stay({ ...state, busy: false });
}

function fromAsk(view: FirstAnswer, stage: Extract<Stage, { kind: 'asking' }>, result: ToolResult, now: number): Next<FirstAnswer> {
  const code = errorCode(result);
  // An error with no Chickpea code is the host's: it ended the call early. The same key gets the same run.
  if (result.isError && code === undefined) return askAgain(view, stage, now);
  if (code === 'in_progress') {
    const heldSince = stage.heldSince ?? now;
    if (now - heldSince >= HELD_FOR_MS) return refused(view, errorOf(result) ?? GENERIC, 'again');
    return held(view, heldSince);
  }
  if (code !== undefined) return refusal(view, code, result);
  const run = testRun(result.structuredContent);
  if (!run) return refused(view, didNotStart(view), 'slack');
  // A run another one held up began only now: its three minutes start here.
  return settled(stage.heldSince === undefined ? view : { ...view, startedAt: now }, run, now);
}

/** Chickpea said another practice run is still going: the same call again in 5 s, for a minute. */
function held(view: FirstAnswer, heldSince: number): Next<FirstAnswer> {
  return { state: { view: { ...view, stage: { kind: 'asking', heldSince, retry: true } }, busy: true }, effects: [{ type: 'timer', inMs: HELD_RETRY_MS }] };
}

/** The host gave up on practice_agent: the same call again, waiting longer each time, for three minutes from the press. */
function askAgain(view: FirstAnswer, stage: Extract<Stage, { kind: 'asking' }>, now: number): Next<FirstAnswer> {
  if (now - view.startedAt >= GIVE_UP_MS) return slow(view, undefined);
  const failures = (stage.failures ?? 0) + 1;
  return {
    state: { view: { ...view, stage: { ...stage, failures, retry: true } }, busy: true },
    effects: [{ type: 'timer', inMs: pollDelay(failures - 1) }],
  };
}

function polled(state: State, result: ToolResult, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  const code = errorCode(result);
  if (code === 'not_found') return finished(view, { kind: 'stopped', problem: errorOf(result)!, then: 'slack' }, ran(view, 'but its answer is no longer there'));
  const run = errorOf(result) ? undefined : testRun(result.structuredContent);
  if (stage.kind === 'slow') {
    if (run && run.status !== 'running') return settled(view, run, now);
    return run ? show({ ...view, stage: { ...stage, again: true } }) : stay({ ...state, busy: false });
  }
  if (stage.kind !== 'running') return stay({ ...state, busy: false });
  if (!run) return pollAgain(view, stage, now);
  return settled(view, run, now);
}

/** A failed read of a run: read again, waiting longer each time, until the three minutes are up. */
function pollAgain(view: FirstAnswer, stage: Extract<Stage, { kind: 'running' }>, now: number): Next<FirstAnswer> {
  if (now - view.startedAt >= GIVE_UP_MS) return slow(view, stage.runToken);
  const failures = (stage.failures ?? 0) + 1;
  return {
    state: { view: { ...view, stage: { ...stage, failures, retry: true } }, busy: true },
    effects: [{ type: 'timer', inMs: pollDelay(failures - 1) }],
  };
}

type Run = {
  status: 'running' | 'answered' | 'failed';
  runToken: string;
  ask: string;
  reply?: string;
  read?: string[];
  problem?: string;
  version?: string;
  before?: { runToken: string; agentVersion: string };
  leftOut: LeftOut[];
};

/** Where a run stands, from practice_agent or get_practice_run. */
function settled(view: FirstAnswer, run: Run, now: number): Next<FirstAnswer> {
  switch (run.status) {
    case 'answered': {
      // Before is an answer from another version of the Agent, never a second answer from this one.
      const reading = view.again && run.version !== undefined && run.before && run.before.agentVersion !== run.version
        ? run.before.runToken
        : undefined;
      const stage: Stage = {
        kind: 'answered', ask: run.ask, reply: run.reply ?? '', read: run.read ?? [], leftOut: run.leftOut,
        ...run.version === undefined ? {} : { version: run.version },
        ...reading ? { reading } : {},
      };
      const told = view.again ? `${pressed(view)}. ${PRACTICE_SHOWN}` : ran(view, 'and it answered its first question there');
      // The new answer takes the earlier one's place.
      const { earlier: _earlier, ...answering } = view;
      return reading ? tell({ state: { view: { ...answering, stage }, busy: true }, effects: [poll(reading)] }, told) : finished(answering, stage, told);
    }
    case 'failed':
      return finished(view, { kind: 'stopped', problem: run.problem ?? didNotFinish(view), then: 'slack' },
        ran(view, 'but it did not finish answering'));
    case 'running': {
      if (now - view.startedAt >= GIVE_UP_MS) return slow(view, run.runToken);
      const stage: Stage = { kind: 'running', runToken: run.runToken, ask: run.ask };
      const same = view.stage.kind === 'running' && view.stage.runToken === run.runToken && !view.stage.retry && !view.stage.failures;
      // get_practice_run waits up to 20 s for the run, so the card asks again at once.
      return {
        state: { view: same ? view : { ...view, stage }, busy: true },
        effects: [poll(run.runToken)],
      };
    }
  }
}

/** The earlier run's answer, as Before, only when it answered on another version of the Agent; any other reply draws the answer alone. */
function beforeRead(view: FirstAnswer, stage: Extract<Stage, { kind: 'answered' }>, result: ToolResult): Next<FirstAnswer> {
  const { reading: _reading, ...answered } = stage;
  const earlier = errorOf(result) ? undefined : testRun(result.structuredContent);
  const differs = earlier?.status === 'answered' && earlier.version !== undefined && stage.version !== undefined && earlier.version !== stage.version;
  return show({ ...view, stage: { ...answered, ...differs ? { before: shownAnswer(earlier.reply ?? '') } : {} } });
}

function slow(view: FirstAnswer, runToken: string | undefined): Next<FirstAnswer> {
  return finished(view, { kind: 'slow', ...runToken ? { runToken } : {} }, ran(view, 'but its answer did not come back in time'));
}

function finished(view: FirstAnswer, stage: Stage, told: string): Next<FirstAnswer> {
  return tell(show({ ...view, stage }), told);
}

/**
 * A run still going when the card stopped waiting, as the card keeps it in
 * the host's `privateContent`, never its `modelContent`: a chat that reopens
 * reads that run once, and Check again reads it, for the hours a run can go.
 */
export interface StillAnswering {
  kind: 'checking';
  runToken: string;
  agentId: string;
  name: string;
  handle?: string;
  /** Try it again's: the Saved card's title. */
  summary?: string;
}

export function stillAnswering(view: FirstAnswer): StillAnswering | undefined {
  const { stage, tested, again } = view;
  if (stage.kind !== 'slow' || stage.runToken === undefined) return undefined;
  return {
    kind: 'checking', runToken: stage.runToken, agentId: tested.agentId, name: tested.name,
    ...tested.handle ? { handle: tested.handle } : {}, ...again ? { summary: again.summary } : {},
  };
}

/** What the host kept, read as untrusted: only its shape is checked. */
export function stillAnsweringOf(kept: unknown): StillAnswering | undefined {
  if (!isRecord(kept) || kept.kind !== 'checking') return undefined;
  const { runToken, agentId, name, handle, summary } = kept;
  if (typeof runToken !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(runToken)) return undefined;
  if (typeof agentId !== 'string' || !isAgentId(agentId) || typeof name !== 'string') return undefined;
  return {
    kind: 'checking', runToken, agentId, name,
    ...typeof handle === 'string' ? { handle } : {}, ...typeof summary === 'string' ? { summary } : {},
  };
}

/**
 * The view a reopened card comes back to: still answering, its re-read the
 * one read of the run. Its key is never sent: past KEY_FOR_MS, a press that
 * asks again makes a new one.
 */
export function checkingView(kept: StillAnswering, from: { avatarUrl?: string | undefined; promised?: Tested['promised'] } = {}): FirstAnswer {
  return {
    kind: 'first_answer',
    tested: {
      agentId: kept.agentId, name: kept.name, ...kept.handle ? { handle: kept.handle } : {}, avatarUrl: from.avatarUrl,
      ...from.promised ? { promised: from.promised } : {},
    },
    ...kept.summary === undefined ? {} : { again: { summary: kept.summary } },
    key: `try:${kept.agentId}:0`,
    keyedAt: 0,
    startedAt: 0,
    stage: { kind: 'slow', runToken: kept.runToken },
  };
}

/** What the host's model hears of a Try it again answer: never the answer, which is the Agent's and may quote a service. */
export const PRACTICE_SHOWN = 'A practice answer is shown on the card.';

function ran(view: FirstAnswer, outcome: string): string {
  return view.again
    ? `${pressed(view)}, ${outcome}.`
    : `The person ran ${agentNamed(view.tested.name, view.tested.handle)} once from the card, ${outcome}.`;
}

function pressed(view: FirstAnswer): string {
  return `The person pressed ${quoted(pressLabel(view))} for ${agentNamed(view.tested.name, view.tested.handle)} on the card`;
}

function pressLabel(view: FirstAnswer): string {
  return view.again ? 'Try it again' : 'See its first answer';
}

/** Refusals whose words are written for the person; any other reads as a run that did not start. */
const REFUSALS: ReadonlySet<string> = new Set([
  'needs_setup', 'not_testable', 'model_unavailable', 'not_allowed', 'usage_limit', 'not_found', 'temporarily_unavailable',
  'test_run_unavailable',
]);

function refusal(view: FirstAnswer, code: string, result: ToolResult): Next<FirstAnswer> {
  const error = refusalOf(result);
  if (!REFUSALS.has(code) || !error) return refused(view, didNotStart(view), 'slack');
  const fix = fixOf(error.fix);
  return refused(view, error.message, fix ? 'fix' : error.retryable === true ? 'again' : 'slack', fix);
}

/** A fix the card can offer: a tool, or a link only when it is a web link, as every card opens. */
function fixOf(fix: unknown): Fix | undefined {
  if (!isFix(fix) || fix === undefined) return undefined;
  return 'url' in fix && httpsUrl(fix.url) === undefined ? undefined : fix;
}

/** The model hears Chickpea's sentence, so its next reply says why and offers the fix. */
function refused(view: FirstAnswer, problem: string, then: 'fix' | 'again' | 'slack', fix?: Fix): Next<FirstAnswer> {
  return tell(
    show({ ...view, stage: { kind: 'stopped', problem, then, refused: true, ...fix ? { fix } : {} } }),
    `${pressed(view)}, but the practice run did not start. Chickpea said: ${quoted(problem)}`,
  );
}

/** The fix's setup link: the press that asked for it opens it, when it is Chickpea's page for that one connection. */
function fixed(view: FirstAnswer, stage: Extract<Stage, { kind: 'stopped' }>, result: ToolResult): Next<FirstAnswer> {
  const { fixing: _fixing, ...rest } = stage;
  const failure = errorOf(result);
  const content = result.structuredContent;
  const setup = !failure && isRecord(content) && isRecord(content.setup) ? content.setup : undefined;
  const url = httpsUrl(setup?.url);
  if (!url || !stage.fix) {
    const summary = isRecord(content) && typeof content.summary === 'string' ? content.summary : undefined;
    return stay({ view: { ...view, stage: rest }, busy: false, error: failure ?? summary ?? GENERIC });
  }
  if (typeof setup?.setupToken !== 'string') return show({ ...view, stage: { ...rest, acted: { kind: 'chat' } } }, [askChat(view, stage.fix)]);
  return tell(
    show({ ...view, stage: { ...rest, acted: { kind: 'page', url } } }, [{ type: 'open', url }]),
    `The person pressed ${quoted(stage.fix.label)} for ${agentNamed(view.tested.name, view.tested.handle)} on the card, which opened Chickpea's page. They can try it again once they finish there.`,
  );
}

function unreachable(state: State, made: Call, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  const { tool } = made;
  if (tool === 'get_practice_run' && stage.kind === 'answered' && stage.reading === made.args.runToken) {
    const { reading: _reading, ...answered } = stage;
    return show({ ...view, stage: answered });
  }
  if (tool === 'practice_agent' && stage.kind === 'asking') return askAgain(view, stage, now);
  if (tool === 'get_practice_run' && stage.kind === 'running') return pollAgain(view, stage, now);
  if (stage.kind === 'stopped' && stage.fixing) {
    const { fixing: _fixing, ...rest } = stage;
    return stay({ view: { ...view, stage: rest }, busy: false, error: UNREACHABLE });
  }
  return stay({ ...state, busy: false });
}

/** Only a retry this page armed: a tick from an older timer finds none, and sends nothing. */
function tick(state: State, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  if (!state.busy || !('retry' in stage) || !stage.retry) return stay(state);
  if (stage.kind === 'asking') {
    const { retry: _retry, ...asking } = stage;
    if (stage.heldSince === undefined && now - view.startedAt >= GIVE_UP_MS) return slow(view, undefined);
    return ask({ ...view, stage: asking });
  }
  if (now - view.startedAt >= GIVE_UP_MS) return slow(view, stage.runToken);
  const { retry: _retry, ...running } = stage;
  return { state: { view: { ...view, stage: running }, busy: true }, effects: [poll(stage.runToken)] };
}

/**
 * The card mounted again with this view, or came back into view with nothing
 * out. A run it knows of is read again; one it never heard back about waits
 * for a press, which sends the same key.
 */
function reread(state: State): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  switch (stage.kind) {
    case 'asking':
      return show({ ...view, stage: { kind: 'lost' } });
    case 'running': {
      const { retry: _retry, failures: _failures, ...running } = stage;
      return { state: { view: { ...view, stage: running }, busy: true }, effects: [poll(stage.runToken)] };
    }
    case 'slow':
      // A read that leaves Check again pressable: the press that focused the card is the one it reads for.
      return stage.runToken ? stay(state, [poll(stage.runToken)]) : stay(state);
    case 'answered':
      // The earlier answer's read went to the card that closed: read it again.
      return stage.reading ? { state: { view, busy: true }, effects: [poll(stage.reading)] } : stay(state);
    default:
      return stay(state);
  }
}

/**
 * A practice run as the card draws it: its question, answer and what it read,
 * never its steps or their raw results. Chickpea escapes a `<` that could
 * open a tag for clients that render the answer; the card draws it as text,
 * so it shows the `<` the Agent wrote.
 */
function testRun(value: unknown): Run | undefined {
  if (!isRecord(value) || typeof value.runToken !== 'string' || typeof value.question !== 'string') return undefined;
  if (value.status !== 'running' && value.status !== 'answered' && value.status !== 'failed') return undefined;
  return {
    status: value.status,
    runToken: value.runToken,
    ask: value.question,
    ...typeof value.reply === 'string' ? { reply: value.reply.replaceAll('&lt;', '<') } : {},
    ...Array.isArray(value.read) ? { read: value.read.filter((name): name is string => typeof name === 'string') } : {},
    ...typeof value.problem === 'string' ? { problem: value.problem } : {},
    ...isRecord(value.ran) && typeof value.ran.agentVersion === 'string' ? { version: value.ran.agentVersion } : {},
    ...isRecord(value.before) && typeof value.before.runToken === 'string' && typeof value.before.agentVersion === 'string'
      ? { before: { runToken: value.before.runToken, agentVersion: value.before.agentVersion } }
      : {},
    leftOut: leftOutOf(value.leftOut),
  };
}

/**
 * The connections a run left out, from the result's own field, each with
 * the tool fix that marks its read tools when it has one. A link to Admin
 * is not offered here: the answer's second button stays Change something.
 */
function leftOutOf(leftOut: unknown): LeftOut[] {
  return (Array.isArray(leftOut) ? leftOut : []).flatMap((entry): LeftOut[] => {
    if (!isRecord(entry) || typeof entry.service !== 'string') return [];
    const fix = fixOf(entry.fix);
    return [{ service: entry.service, ...fix && 'tool' in fix ? { fix } : {} }];
  });
}

function leftOutFix(stage: Extract<Stage, { kind: 'answered' }>): Fix | undefined {
  return stage.leftOut.find(({ fix }) => fix)?.fix;
}

function didNotStart(view: FirstAnswer): string {
  return `The practice run didn't start. Ask ${view.tested.name} in Slack instead.`;
}

function didNotFinish(view: FirstAnswer): string {
  return `The practice run didn't finish. Ask ${view.tested.name} in Slack instead.`;
}

// What the card shows.

const RUNNING_LINE = 'A practice run: it makes only read requests and sends nothing to Slack.';
const ANSWERED_LINE = 'A practice run: it made only read requests and sent nothing to Slack.';

/**
 * The heading follows what the card shows: the first answer, the answer
 * after a save beside the one from before it, or a run that did not start.
 */
function titleOf(view: FirstAnswer): string {
  const { tested: { name }, stage } = view;
  if (stage.kind === 'stopped' && stage.refused) return `Couldn't practice with ${name}`;
  if (!view.again) return `${name}'s first answer`;
  const alone = stage.kind === 'answered' && stage.reading === undefined && stage.before === undefined;
  return alone ? `${name}'s answer` : `${name} after this change`;
}

export function presentFirstAnswer(view: FirstAnswer): Omit<Presentation<FirstAnswerAction>, 'busy' | 'error'> {
  const { tested, stage } = view;
  const title = titleOf(view);
  const head = { avatar: 'agent' as const, avatarUrl: tested.avatarUrl, title };
  const slack: Array<Button<FirstAnswerAction>> = tested.slackUrl ? [{ label: 'Open in Slack', action: 'open_slack', tone: 'primary' }] : [];
  switch (stage.kind) {
    case 'asking': {
      const step = stage.heldSince === undefined
        ? `Asking ${tested.name} its first question`
        : 'Waiting for another practice run to finish';
      return { ...head, announce: `${title}. ${step}.`, subtitle: [{ text: RUNNING_LINE }], blocks: [{ kind: 'steps', steps: [{ label: step, state: 'now' }] }], buttons: [] };
    }
    case 'running':
      return answering(view, stage.ask);
    case 'answered': {
      // While the earlier answer is read, the card still shows it answering: Before and After come together.
      if (stage.reading) return answering(view, stage.ask);
      const panes = panesOf(view, stage);
      // A left-out connection's fix takes the second place. On Try it again the save's Undo keeps it while
      // the card holds one, and the fix leaves once the person acts on it.
      const fix = leftOutFix(stage);
      const second: Button<FirstAnswerAction> = fix && !(view.again && (stage.acted || view.again.undoToken !== undefined))
        ? { label: fix.label, action: 'try_fix', tone: 'secondary' }
        : { label: 'Change something', action: 'change_something', tone: 'secondary' };
      return {
        ...head,
        announce: `${title}. It answered.`,
        subtitle: [{ text: ANSWERED_LINE }],
        blocks: [
          askedLine(stage.ask),
          panes,
          ...stage.read.length ? [{ kind: 'note' as const, text: `It read ${joinNames(stage.read)}.` }] : [],
          ...stage.leftOut.map(({ service }): Block<FirstAnswerAction> => ({ kind: 'note', text: leftOutWords(service), tone: 'warn' })),
          ...stage.acted ? [{ kind: 'note' as const, text: ACTED[stage.acted.kind] }] : [],
        ],
        buttons: view.again ? [{ label: 'Try it again', action: 'try_once', tone: 'primary' }, second]
          : stage.acted ? [{ label: 'Try again', action: 'try_once', tone: 'primary' }, second]
            : [...slack, second],
      };
    }
    case 'stopped':
      // A run that did not come to an answer goes under the answer the card showed before.
      return {
        ...head,
        announce: `${title}. ${stage.problem}`,
        blocks: [
          ...view.earlier ? [askedLine(view.earlier.ask), panesOf(view, view.earlier)] : [],
          { kind: 'text', text: stage.problem },
          ...stage.acted ? [{ kind: 'note' as const, text: ACTED[stage.acted.kind] }] : [],
        ],
        buttons: stoppedButtons(stage, slack),
      };
    case 'slow': {
      // A run Chickpea is still answering can go on for hours, as a direct message can; Check again reads it.
      const line = stage.runToken ? STILL
        : stage.again
          ? `It's still answering. Check again in a moment, or ask ${tested.name} in Slack.`
          : `Its answer is taking longer than it should. Check again in a moment, or ask ${tested.name} in Slack.`;
      return {
        ...head,
        announce: `${title}. ${line}`,
        blocks: [{ kind: 'text', text: line }],
        buttons: [
          { label: 'Check again', action: 'check_again', tone: 'primary' },
          ...slack.map((button): Button<FirstAnswerAction> => ({ ...button, tone: 'secondary' })),
        ],
      };
    }
    case 'lost': {
      const line = 'This card closed before the practice run answered.';
      return {
        ...head,
        announce: `${title}. ${line}`,
        subtitle: [{ text: RUNNING_LINE }],
        blocks: [{ kind: 'text', text: line }],
        buttons: [{ label: pressLabel(view), action: 'try_once', tone: 'primary' }],
      };
    }
  }
}

/** The answer, beside what the proposal promised, or on Try it again beside the answer from before the change. */
function panesOf(view: FirstAnswer, shown: Shown): Block<FirstAnswerAction> {
  const answer = shownAnswer(shown.reply);
  if (view.again) {
    return { kind: 'panes', panes: shown.before !== undefined
      ? [{ label: 'Before', text: shown.before }, { label: 'After', text: answer }]
      : [{ label: 'What it answered', text: answer }] };
  }
  const promised = promisedFor(view.tested, shown.ask);
  return { kind: 'panes', panes: [...promised ? [{ label: 'What we promised', text: promised }] : [], { label: 'What it answered', text: answer }] };
}

function answering(view: FirstAnswer, ask: string): Omit<Presentation<FirstAnswerAction>, 'busy' | 'error'> {
  const { tested } = view;
  const title = titleOf(view);
  return {
    avatar: 'agent',
    avatarUrl: tested.avatarUrl,
    title,
    announce: `${title}. ${tested.name} is answering.`,
    subtitle: [{ text: RUNNING_LINE }],
    blocks: [askedLine(ask), { kind: 'steps', steps: [{ label: `${tested.name} is answering`, state: 'now' }] }],
    buttons: [],
  };
}

/** A connection the run left out, under its answer. */
function leftOutWords(service: string): string {
  return `${service} wasn't used: none of its tools are marked as ones that only read.`;
}

const STILL = 'Still working on it.';

const ACTED = {
  page: 'Finish on the Chickpea page that opened, then try again.',
  chat: 'Finish it in the chat, then try again.',
} as const;

/** Its fix first, then Try again once the person acted on it; with no fix, Try again when it may pass, else Slack. */
function stoppedButtons(stage: Extract<Stage, { kind: 'stopped' }>, slack: Array<Button<FirstAnswerAction>>): Array<Button<FirstAnswerAction>> {
  const again: Button<FirstAnswerAction> = { label: 'Try again', action: 'try_once', tone: 'primary' };
  const fix = (tone: Button['tone']): Array<Button<FirstAnswerAction>> => stage.fix ? [{ label: stage.fix.label, action: 'try_fix', tone }] : [];
  const secondary = slack.map((button): Button<FirstAnswerAction> => ({ ...button, tone: 'secondary' }));
  switch (stage.then) {
    case 'again':
      return [again, ...secondary];
    case 'fix':
      return stage.acted ? [again, ...fix('secondary')] : [...fix('primary'), ...secondary];
    case 'slack':
      return slack;
  }
}

function askedLine(ask: string): Block<FirstAnswerAction> {
  return { kind: 'note', text: `First question: “${ask}”` };
}

/** The proposal's promised answer, only for the question this run asked. */
function promisedFor(tested: Tested, ask: string): string | undefined {
  const { promised } = tested;
  const same = (text: string) => text.replace(/\s+/g, ' ').trim();
  return promised && same(promised.ask) === same(ask) ? promised.answer : undefined;
}

function shownAnswer(reply: string): string {
  return plainText(reply).trim() || 'It gave no answer.';
}

/**
 * Markdown as a person reads it: no emphasis, heading, quote or rule marks, a
 * link as its words, a list item as a bullet, a table row as its cells. Code
 * stays as written, without its fences or backticks.
 */
export function plainText(markdown: string): string {
  const code: string[] = [];
  const hold = (text: string) => `\u0000${code.push(text) - 1}\u0000`;
  return markdown
    .replace(/\u0000/g, '')
    .replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$\n?/gm, (_, block: string) => hold(block))
    .replace(/^[ \t]*```.*$\n?/gm, '')
    .replace(/`([^`\n]+)`/g, (_, span: string) => hold(span))
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?$\n?/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, cells: string) => cells.split('|').map((cell) => cell.trim()).join(' · '))
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$\n?/gm, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ')
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/gm, '$1$2')
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/gm, '$1$2')
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)] ?? '');
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
