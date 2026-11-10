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
  show,
  stay,
  summaryLine,
  tell,
  UNREACHABLE,
  type Block,
  type Button,
  type CardEvent,
  type CardState,
  type Effect,
  type Fix,
  type Next,
  type Presentation,
  type ToolResult,
} from './card-model.ts';

/**
 * "See its first answer": one read-only test run of an Agent, as a view a
 * card shows in place of its own. Only a press starts one. The press sends
 * try_agent_once with the view's key, and every call this view sends again
 * for that press, after the host gave up on one or while another run held
 * the workspace, carries the same key, so it gets the run the first call
 * started. get_test_run then follows the run until it answers, fails, or
 * three minutes pass. A key past the hour Chickpea keeps a run for starts
 * nothing, so a press after that sends a new one.
 *
 * `busy` holds while this page has a call out or a retry due. A card that
 * mounts again has neither: its re-read follows a run it knows of with
 * get_test_run, and asks for a press for one it does not.
 */

export type FirstAnswerAction = 'try_once' | 'try_fix' | 'open_slack' | 'change_something';

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

type Stage =
  /** try_agent_once is out, or with `retry`, due again on the next tick. */
  | { kind: 'asking'; failures?: number; heldSince?: number; retry?: true }
  /** get_test_run is out, or with `retry`, due again on the next tick. */
  | { kind: 'running'; runToken: string; ask: string; failures?: number; retry?: true }
  | { kind: 'answered'; ask: string; reply: string; read: string[] }
  /**
   * It did not start or did not finish: Chickpea's own sentence, and what the
   * person can do next. Once they act on its fix, on the Chickpea page it
   * opened or in the chat, it offers Try again.
   */
  | { kind: 'stopped'; problem: string; then: 'fix' | 'again' | 'slack'; fix?: Fix; fixing?: true; acted?: Acted }
  /** Three minutes and no answer. */
  | { kind: 'slow'; runToken?: string }
  /** The card mounted again while its first call was out: that answer went to the card that closed. */
  | { kind: 'lost' };

export interface FirstAnswer {
  kind: 'first_answer';
  tested: Tested;
  /** Every try_agent_once this view sends carries it. */
  key: string;
  /** When the key was made: past KEY_FOR_MS it starts nothing. */
  keyedAt: number;
  /** The press, or when a run held up by another began; the card gives up three minutes after it. */
  startedAt: number;
  stage: Stage;
}

type State = CardState<FirstAnswer>;

export const GIVE_UP_MS = 3 * 60_000;
export const HELD_RETRY_MS = 5_000;
export const HELD_FOR_MS = 60_000;
/** Chickpea keeps a test run, and replays its key, for an hour. */
export const KEY_FOR_MS = 60 * 60_000;

/** The press on "See its first answer". */
export function tryOnce(tested: Tested, now: number): Next<FirstAnswer> {
  return ask({ kind: 'first_answer', tested, key: `try:${tested.agentId}:${now}`, keyedAt: now, startedAt: now, stage: { kind: 'asking' } });
}

function ask(view: FirstAnswer): Next<FirstAnswer> {
  return {
    state: { view, busy: true },
    effects: [call('try_agent_once', { agentId: view.tested.agentId, idempotencyKey: view.key })],
  };
}

function poll(runToken: string): Effect {
  return call('get_test_run', { runToken });
}

export function stepFirstAnswer<A extends string>(state: State, event: CardEvent<A>): Next<FirstAnswer> {
  switch (event.type) {
    case 'press':
      return state.busy ? stay(state) : press(state, event.action as string, event.now);
    case 'reply':
      return outdated(state, event.call) ? stay(state) : reply(state, event.call.tool, event.result, event.now);
    case 'unreachable':
      return outdated(state, event.call) ? stay(state) : unreachable(state, event.call.tool, event.now);
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
      const again = stage.kind === 'lost' ||
        (stage.kind === 'stopped' && (stage.then === 'again' || (stage.then === 'fix' && stage.acted !== undefined)));
      if (!again) return stay(state);
      // The same key while it and its retries last: a run the first press started is the one this press gets.
      return now - view.keyedAt < KEY_FOR_MS - GIVE_UP_MS - 60_000
        ? ask({ ...view, startedAt: now, stage: { kind: 'asking' } })
        : tryOnce(tested, now);
    }
    case 'try_fix': {
      const fix = stage.kind === 'stopped' ? stage.fix : undefined;
      if (stage.kind !== 'stopped' || !fix) return stay(state);
      if ('url' in fix) return show({ ...view, stage: { ...stage, acted: { kind: 'page', url: fix.url } } }, [{ type: 'open', url: fix.url }]);
      if (opensSetupLink(fix)) return { state: { view: { ...view, stage: { ...stage, fixing: true } }, busy: true }, effects: [call(fix.tool, fix.arguments)] };
      return show({ ...view, stage: { ...stage, acted: { kind: 'chat' } } }, [askChat(view, fix)]);
    }
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
  if (stage.kind === 'stopped' && stage.acted &&
    (stage.acted.kind === 'page' ? effect.type === 'open' && effect.url === stage.acted.url : effect.type === 'message')) {
    const { acted: _acted, ...rest } = stage;
    return stay({ view: { ...view, stage: rest }, busy: false, error: GENERIC });
  }
  const offered = effect.type === 'open'
    ? effect.url === tested.slackUrl && (stage.kind === 'answered' || stage.kind === 'stopped' || stage.kind === 'slow')
    : stage.kind === 'answered';
  return offered ? stay({ ...state, error: GENERIC }) : stay(state);
}

function reply(state: State, tool: string, result: ToolResult, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  if (tool === 'try_agent_once' && stage.kind === 'asking') return fromAsk(view, stage, result, now);
  if (tool === 'get_test_run' && (stage.kind === 'running' || stage.kind === 'slow')) return polled(state, result, now);
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

/** Another run holds the workspace: the same call again in 5 s, for a minute. */
function held(view: FirstAnswer, heldSince: number): Next<FirstAnswer> {
  return { state: { view: { ...view, stage: { kind: 'asking', heldSince, retry: true } }, busy: true }, effects: [{ type: 'timer', inMs: HELD_RETRY_MS }] };
}

/** The host gave up on try_agent_once: the same call again, waiting longer each time, for three minutes from the press. */
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
  const run = result.isError ? undefined : testRun(result.structuredContent);
  if (stage.kind === 'slow') return run && run.status !== 'running' ? settled(view, run, now) : stay({ ...state, busy: false });
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

type Run = { status: 'running' | 'answered' | 'failed'; runToken: string; ask: string; reply?: string; read?: string[]; problem?: string };

/** Where a run stands, from try_agent_once or get_test_run. */
function settled(view: FirstAnswer, run: Run, now: number): Next<FirstAnswer> {
  switch (run.status) {
    case 'answered':
      return finished(view, { kind: 'answered', ask: run.ask, reply: run.reply ?? '', read: run.read ?? [] },
        ran(view, 'and it answered its first question there'));
    case 'failed':
      return finished(view, { kind: 'stopped', problem: run.problem ?? didNotFinish(view), then: 'slack' },
        ran(view, 'but it did not finish answering'));
    case 'running': {
      if (now - view.startedAt >= GIVE_UP_MS) return slow(view, run.runToken);
      const stage: Stage = { kind: 'running', runToken: run.runToken, ask: run.ask };
      const same = view.stage.kind === 'running' && view.stage.runToken === run.runToken && !view.stage.retry && !view.stage.failures;
      // get_test_run waits up to 20 s for the run, so the card asks again at once.
      return {
        state: { view: same ? view : { ...view, stage }, busy: true },
        effects: [poll(run.runToken)],
      };
    }
  }
}

function slow(view: FirstAnswer, runToken: string | undefined): Next<FirstAnswer> {
  return finished(view, { kind: 'slow', ...runToken ? { runToken } : {} }, ran(view, 'but its answer did not come back in time'));
}

function finished(view: FirstAnswer, stage: Stage, told: string): Next<FirstAnswer> {
  return tell(show({ ...view, stage }), told);
}

function ran(view: FirstAnswer, outcome: string): string {
  return `The person ran ${agentNamed(view.tested.name, view.tested.handle)} once from the card, ${outcome}.`;
}

/** Refusals whose words are written for the person; any other reads as a run that did not start. */
const REFUSALS: ReadonlySet<string> = new Set([
  'needs_setup', 'not_testable', 'model_unavailable', 'not_allowed', 'usage_limit', 'not_found', 'temporarily_unavailable',
  'test_run_unavailable',
]);

function refusal(view: FirstAnswer, code: string, result: ToolResult): Next<FirstAnswer> {
  if (!REFUSALS.has(code)) return refused(view, didNotStart(view), 'slack');
  const error = isRecord(result.structuredContent) ? result.structuredContent.error : undefined;
  const fix = isRecord(error) ? fixOf(error.fix) : undefined;
  const then = fix ? 'fix' : isRecord(error) && error.retryable === true ? 'again' : 'slack';
  return refused(view, errorOf(result) ?? GENERIC, then, fix);
}

/** A fix the card can offer: a tool, or a link only when it is a web link, as every card opens. */
function fixOf(fix: unknown): Fix | undefined {
  if (!isFix(fix) || fix === undefined) return undefined;
  return 'url' in fix && httpsUrl(fix.url) === undefined ? undefined : fix;
}

function refused(view: FirstAnswer, problem: string, then: 'fix' | 'again' | 'slack', fix?: Fix): Next<FirstAnswer> {
  return tell(
    show({ ...view, stage: { kind: 'stopped', problem, then, ...fix ? { fix } : {} } }),
    `The person pressed "See its first answer" for ${agentNamed(view.tested.name, view.tested.handle)} on the card, but the test run did not start.`,
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
    `The person opened Chickpea's page to ${summaryLine(stage.fix.label)} for ${agentNamed(view.tested.name, view.tested.handle)} from the card. They can try it again once they finish there.`,
  );
}

function unreachable(state: State, tool: string, now: number): Next<FirstAnswer> {
  const { view } = state;
  const { stage } = view;
  if (tool === 'try_agent_once' && stage.kind === 'asking') return askAgain(view, stage, now);
  if (tool === 'get_test_run' && stage.kind === 'running') return pollAgain(view, stage, now);
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
      return stage.runToken ? { state: { view, busy: true }, effects: [poll(stage.runToken)] } : stay(state);
    default:
      return stay(state);
  }
}

function testRun(value: unknown): Run | undefined {
  if (!isRecord(value) || typeof value.runToken !== 'string' || typeof value.ask !== 'string') return undefined;
  if (value.status !== 'running' && value.status !== 'answered' && value.status !== 'failed') return undefined;
  return {
    status: value.status,
    runToken: value.runToken,
    ask: value.ask,
    ...typeof value.reply === 'string' ? { reply: value.reply } : {},
    ...Array.isArray(value.read) ? { read: value.read.filter((name): name is string => typeof name === 'string') } : {},
    ...typeof value.problem === 'string' ? { problem: value.problem } : {},
  };
}

function didNotStart(view: FirstAnswer): string {
  return `The test run didn't start. Ask ${view.tested.name} in Slack instead.`;
}

function didNotFinish(view: FirstAnswer): string {
  return `The test run didn't finish. Ask ${view.tested.name} in Slack instead.`;
}

// What the card shows.

const RUNNING_LINE = 'A test run: it makes only read requests and sends nothing to Slack.';
const ANSWERED_LINE = 'A test run: it made only read requests and sent nothing to Slack.';

export function presentFirstAnswer(view: FirstAnswer): Omit<Presentation<FirstAnswerAction>, 'busy' | 'error'> {
  const { tested, stage } = view;
  const title = `${tested.name}'s first answer`;
  const head = { avatar: 'agent' as const, avatarUrl: tested.avatarUrl, title };
  const slack: Array<Button<FirstAnswerAction>> = tested.slackUrl ? [{ label: 'Open in Slack', action: 'open_slack', tone: 'primary' }] : [];
  switch (stage.kind) {
    case 'asking': {
      const step = stage.heldSince === undefined
        ? `Asking ${tested.name} its first question`
        : 'Waiting for another test run in this workspace to finish';
      return { ...head, announce: `${title}. ${step}.`, subtitle: [{ text: RUNNING_LINE }], blocks: [{ kind: 'steps', steps: [{ label: step, state: 'now' }] }], buttons: [] };
    }
    case 'running':
      return {
        ...head,
        announce: `${title}. ${tested.name} is answering.`,
        subtitle: [{ text: RUNNING_LINE }],
        blocks: [askedLine(stage.ask), { kind: 'steps', steps: [{ label: `${tested.name} is answering`, state: 'now' }] }],
        buttons: [],
      };
    case 'answered': {
      const promised = promisedFor(tested, stage.ask);
      const answer = plainText(stage.reply).trim() || 'It gave no answer.';
      return {
        ...head,
        announce: `${title}. It answered.`,
        subtitle: [{ text: ANSWERED_LINE }],
        blocks: [
          askedLine(stage.ask),
          {
            kind: 'panes',
            panes: [
              ...promised ? [{ label: 'What we promised', text: promised }] : [],
              { label: 'What it answered', text: answer },
            ],
          },
          ...stage.read.length ? [{ kind: 'note' as const, text: `It read ${joinNames(stage.read)}.` }] : [],
        ],
        buttons: [
          ...slack,
          { label: 'Change something', action: 'change_something', tone: 'secondary' },
        ],
      };
    }
    case 'stopped':
      return {
        ...head,
        announce: `${title}. ${stage.problem}`,
        blocks: [
          { kind: 'text', text: stage.problem },
          ...stage.acted ? [{ kind: 'note' as const, text: ACTED[stage.acted.kind] }] : [],
        ],
        buttons: stoppedButtons(stage, slack),
      };
    case 'slow': {
      const line = `Its answer is taking longer than it should. Ask ${tested.name} in Slack instead.`;
      return { ...head, announce: `${title}. ${line}`, blocks: [{ kind: 'text', text: line }], buttons: slack };
    }
    case 'lost': {
      const line = 'This card closed before the test run answered.';
      return {
        ...head,
        announce: `${title}. ${line}`,
        subtitle: [{ text: RUNNING_LINE }],
        blocks: [{ kind: 'text', text: line }],
        buttons: [{ label: 'See its first answer', action: 'try_once', tone: 'primary' }],
      };
    }
  }
}

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
