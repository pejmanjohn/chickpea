import type { z } from 'zod';

import type * as schemas from '../../management/mcp-v5/schemas.ts';
import {
  agentNamed,
  call,
  errorOf,
  GENERIC,
  httpsUrl,
  isRecord,
  NOTHING,
  outdated,
  pollDelay,
  POLL_CEILING_MS,
  POLL_INTERVAL_MS,
  presentSafely,
  quoted,
  sequenced,
  show,
  stay,
  tell,
  toolOf,
  tryIt,
  type CardEvent,
  type CardState,
  type Effect,
  type Next,
  type Presentation,
  type Row,
  type ToolResult,
} from '../card-model.ts';
import { channelNames } from '../../management/channel-names.ts';
import { plainWords } from '../check-words.ts';
import { checkingView, presentFirstAnswer, stepFirstAnswer, stillAnswering, stillAnsweringOf, tryOnce, type FirstAnswer } from '../first-answer.ts';

/**
 * The connect card: a setup link from connect_service or reconnect_service.
 * Connect opens Chickpea's page for that one connection; the card then
 * follows get_setup_status until the connection is ready. The person may
 * finish on another tab or device, or connect the service another way, so
 * the card reads again when it comes back into view, and counts the
 * connection as done when the Agent has it ready.
 */

type ChangeResult = z.infer<typeof schemas.changeResultOutput>;
type Setup = NonNullable<ChangeResult['setup']>;
type SetupStatus = z.infer<typeof schemas.getSetupStatusOutput>;
type Connection = NonNullable<SetupStatus['connection']>;
type Check = z.infer<typeof schemas.checkAgentOutput>['checks'][number];
type Refused = Extract<Event, { type: 'refused' }>['effect'];

type Flow = 'connect' | 'reconnect';
type AgentLabel = {
  agentId: string;
  name: string;
  handle?: string | undefined;
  slackUrl?: string | undefined;
  avatarUrl?: string | undefined;
  /** Its Channels' names, where a mention reaches it. */
  channels?: string[];
};

interface Link {
  flow: Flow;
  agent?: AgentLabel | undefined;
  setup: Setup;
  /**
   * A reconnect only: the connection's status when the card first read it.
   * A connection that was ready then says nothing about this sign-in.
   */
  before?: Connection['status'] | 'none';
}

export type View =
  | { kind: 'waiting' }
  | { kind: 'notice'; title: string }
  /** Connect opens the page. */
  | ({ kind: 'start' } & Link)
  /**
   * The page opened; the card polls until it is done, for two minutes from
   * Connect, then reads only when it comes back into view or on I'm done.
   */
  | ({
      kind: 'finishing';
      startedAt: number;
      slow?: true;
      failures?: number;
      /** Chickpea saw the page open, so a refusal that comes late is not about this page. */
      opened?: true;
    } & Link)
  | {
      kind: 'connected';
      flow: Flow;
      agent?: AgentLabel | undefined;
      service: string;
      connectionId?: string;
      /**
       * A custom connection gets one request from check_agent; a catalog one
       * has nothing that proves a read. The words are the check's plain ones.
       */
      check?: 'checking' | { status: Check['status']; words: string };
      /** The Agent has a first question saved, so the card offers its first answer. */
      firstAsk?: true;
    }
  /** "See its first answer", pressed on the connected card. */
  | FirstAnswer
  | ({ kind: 'ended'; why: 'expired' | 'cancelled' | 'failed' } & Link)
  /** A link that is not Chickpea's page for one connection: the card does not open it. */
  | ({ kind: 'elsewhere' } & Link);

export type State = CardState<View>;
export type Action = 'connect' | 'done' | 'open_slack' | 'new_link' | 'try_once' | 'try_fix' | 'change_something' | 'check_again';
export type Event = CardEvent<Action>;

export const INITIAL: State = { view: { kind: 'waiting' }, busy: false, seq: 0 };

/**
 * The card keeps only a first answer's run still going when it stopped
 * waiting, so a chat that reopens reads that run once; once the run settles
 * it keeps nothing, and comes back to its link.
 */
export const step = sequenced(transition, {
  remember: (view) => view.kind === 'first_answer' ? stillAnswering(view) ?? { kind: 'settled' } : undefined,
  resume: (view, kept) => {
    const still = stillAnsweringOf(kept);
    return still ? checkingView(still, { avatarUrl: 'agent' in view ? view.agent?.avatarUrl : undefined }) : undefined;
  },
});

function transition(state: State, event: Event): Next<View> {
  const { view } = state;
  if (view.kind === 'first_answer' && event.type !== 'result') return stepFirstAnswer({ ...state, view }, event);
  switch (event.type) {
    case 'result':
      return fromResult(event.result);
    case 'press':
      return state.busy ? stay(state) : press(state, event.action, event.now);
    case 'reply':
      return outdated(state, event.call) ? stay(state) : reply(state, event.call.tool, event.result, event.now);
    case 'unreachable':
      if (outdated(state, event.call)) return stay(state);
      // Every call this card makes reads: a failure leaves the buttons as they are, and a poll tries again later.
      if (state.view.kind === 'finishing') return keepPolling(state, { ...state.view, failures: (state.view.failures ?? 0) + 1 }, event.now);
      if (state.view.kind === 'connected' && state.view.check === 'checking') return show(unchecked(state.view));
      return stay(state);
    case 'refused':
      return refused(state, event.effect);
    case 'no_result':
      return state.view.kind === 'waiting' ? show<View>(NOTHING) : stay(state);
    case 'tick':
      return state.view.kind === 'finishing' && !state.view.slow ? stay(state, [readSetup(state.view)]) : stay(state);
    case 'reread':
      return reread(state);
  }
}

function fromResult(result: ToolResult): Next<View> {
  const failure = errorOf(result);
  if (failure) return show({ kind: 'notice', title: failure });
  const content = result.structuredContent;
  if (!isChangeResult(content)) return show<View>(NOTHING);
  const flow: Flow = toolOf(result) === 'reconnect_service' ? 'reconnect' : 'connect';
  const agent = content.agent && {
    agentId: content.agent.agentId,
    name: content.agent.name,
    handle: content.agent.handle,
    slackUrl: httpsUrl(content.agent.links?.slack),
    avatarUrl: httpsUrl(content.agent.avatarUrl),
    channels: channelNames(content.agent.channels ?? []),
  };
  const { setup } = content;
  if (content.status !== 'needs_setup' || !isSetup(setup)) return show({ kind: 'notice', title: content.summary.replace(/\.$/, '') });
  // Only Chickpea's page for this one connection comes with a token to follow it.
  return show({ kind: setup.setupToken && httpsUrl(setup.url) ? 'start' : 'elsewhere', flow, agent, setup });
}

function press(state: State, action: Action, now: number): Next<View> {
  const { view } = state;
  switch (action) {
    case 'connect':
      return view.kind === 'start'
        ? show({ ...linkOf(view), kind: 'finishing', startedAt: now }, [{ type: 'open', url: view.setup.url }, timer(POLL_INTERVAL_MS)])
        : stay(state);
    case 'done':
      return view.kind === 'finishing' ? reread(state) : stay(state);
    case 'open_slack':
      return view.kind === 'connected' && view.agent?.slackUrl ? stay(state, [{ type: 'open', url: view.agent.slackUrl }]) : stay(state);
    case 'new_link':
      return view.kind === 'ended' ? stay(state, [{ type: 'message', sent: newLinkAsk(view) }]) : stay(state);
    case 'try_once': {
      const agent = view.kind === 'connected' && view.firstAsk ? view.agent : undefined;
      return agent
        ? tryOnce({ agentId: agent.agentId, name: agent.name, handle: agent.handle, avatarUrl: agent.avatarUrl, slackUrl: agent.slackUrl }, now)
        : stay(state);
    }
    default:
      return stay(state);
  }
}

function reply(state: State, tool: string, result: ToolResult, now: number): Next<View> {
  const { view } = state;
  const failure = errorOf(result);
  if (tool === 'get_setup_status') {
    const status = failure ? undefined : result.structuredContent;
    if (view.kind !== 'start' && view.kind !== 'finishing' && view.kind !== 'ended') return stay(state);
    if (!isSetupStatus(status)) {
      return view.kind === 'finishing' ? keepPolling(state, { ...view, failures: (view.failures ?? 0) + 1 }, now) : stay(state);
    }
    return setupStatus(state, view, status, now);
  }
  if (tool === 'check_agent' && view.kind === 'connected' && view.check === 'checking') {
    const checks = failure ? [] : (result.structuredContent as { checks?: unknown } | undefined)?.checks;
    const check = Array.isArray(checks)
      ? (checks as unknown[]).find((item): item is Check => isRecord(item) && item.part === 'connection' &&
        item.connectionId === view.connectionId && typeof item.status === 'string' && STATUSES.has(item.status))
      : undefined;
    return show(check ? { ...view, check: { status: check.status, words: plainWords(check) } } : unchecked(view));
  }
  return stay(state);
}

type Open = Extract<View, { kind: 'start' | 'finishing' | 'ended' }>;
type Connected = Extract<View, { kind: 'connected' }>;

const STATUSES: ReadonlySet<string> = new Set<Check['status']>(['ok', 'warning', 'failing', 'unknown']);

function unchecked({ check: _check, ...view }: Connected): Connected {
  return view;
}

function setupStatus(state: State, view: Open, status: SetupStatus, now: number): Next<View> {
  const { connection } = status;
  const before = view.flow === 'reconnect' ? view.before ?? connection?.status ?? 'none' : undefined;
  // The Agent has it ready: done, even when this link still waits because it was set up another way.
  const readyNow = connection?.status === 'ready' && (view.flow === 'connect' || before !== 'ready');
  const what = quoted(view.setup.what);
  const agent = view.agent ? ` ${view.flow === 'reconnect' ? 'for' : 'to'} ${agentNamed(view.agent.name)}` : '';
  if (status.status === 'done' || readyNow) {
    const done = connected(view, connection, status.agent?.hasFirstAsk === true);
    // Ready may come another way than this card's link, so the sentence says only what is true now.
    return view.kind === 'finishing'
      ? tell(done, view.flow === 'reconnect' ? `${what} is signed in again${agent}.` : `${what} is connected${agent} now.`)
      : done;
  }
  const link = { ...linkOf(view), ...before ? { before } : {} };
  if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'expired') {
    if (view.kind === 'ended' && view.why === status.status && view.before === before) return stay(state);
    const ended = show<View>({ ...link, kind: 'ended', why: status.status });
    return view.kind === 'finishing' ? tell(ended, `${what} did not connect${agent}: the link ${ENDED_WORDS[status.status]}. Nothing changed.`) : ended;
  }
  const opened = status.status !== 'waiting' || (view.kind === 'finishing' && view.opened) ? { opened: true as const } : {};
  if (view.kind === 'finishing') {
    const { failures: _failures, ...answered } = view;
    return keepPolling(state, { ...answered, ...link, ...opened }, now);
  }
  // Opened from the link in the chat: follow it as if Connect had opened it.
  if (view.kind === 'start' && status.status !== 'waiting') return keepPolling(state, { ...link, ...opened, kind: 'finishing', startedAt: now }, now);
  return view.before === before ? stay(state) : show({ ...view, ...link });
}

const ENDED_WORDS = { failed: 'failed', cancelled: 'was cancelled', expired: 'expired' } as const;

function connected(view: Open, connection: Connection | undefined, firstAsk: boolean): Next<View> {
  const custom = connection && connection.kind !== 'service' && view.agent;
  const next: View = {
    kind: 'connected',
    flow: view.flow,
    agent: view.agent,
    service: view.setup.what,
    ...connection ? { connectionId: connection.connectionId } : {},
    ...custom ? { check: 'checking' as const } : {},
    ...firstAsk && view.agent ? { firstAsk: true as const } : {},
  };
  return show(next, custom ? [call('check_agent', { agentId: view.agent!.agentId })] : []);
}

type Finishing = Extract<View, { kind: 'finishing' }>;

/**
 * Polls again until two minutes after Connect; coming back into view never
 * moves that, so a link costs at most about 60 polls. A poll that changes
 * nothing keeps the view, so the card does not save it again.
 */
function keepPolling(state: State, polled: Finishing, now: number): Next<View> {
  const view: Finishing = now - polled.startedAt >= POLL_CEILING_MS ? { ...polled, slow: true } : polled;
  const effects = view.slow ? [] : [timer(pollDelay(view.failures))];
  return state.view.kind === 'finishing' && !state.error && sameFields(state.view, view) ? stay(state, effects) : show(view, effects);
}

function sameFields(a: Finishing, b: Finishing): boolean {
  const left: Record<string, unknown> = { ...a };
  const right: Record<string, unknown> = { ...b };
  return Object.keys({ ...left, ...right }).every((key) => left[key] === right[key]);
}

/**
 * When the card mounts with a kept state, comes back into view, or the
 * person presses I'm done: the link may have moved on elsewhere. One read;
 * the polls it answers stop where they would have.
 */
function reread(state: State): Next<View> {
  const { view } = state;
  switch (view.kind) {
    case 'finishing':
    case 'start':
    case 'ended':
      return stay(state, [readSetup(view)]);
    case 'connected':
      // A chat reopened before the check answered: its answer went to the card that closed.
      return view.check === 'checking' ? show(unchecked(view)) : stay(state);
    default:
      return stay(state);
  }
}

/**
 * The host did not open a link or take a message. Only the one this view
 * offers counts: a host that never answers refuses a minute later, by when
 * the person may be signing in on the page that did open.
 */
function refused(state: State, effect: Refused): Next<View> {
  const { view } = state;
  if (view.kind === 'finishing' && effect.type === 'open' && effect.url === view.setup.url) {
    return view.opened ? stay(state) : stay({ view: { ...linkOf(view), kind: 'start' }, busy: false, error: GENERIC });
  }
  const offered = view.kind === 'connected'
    ? effect.type === 'open' && effect.url === view.agent?.slackUrl
    : view.kind === 'ended' && effect.type === 'message';
  return offered ? stay({ ...state, error: GENERIC }) : stay(state);
}

function readSetup(view: Link): Effect {
  return call('get_setup_status', { setupToken: view.setup.setupToken });
}

function timer(inMs: number): Effect {
  return { type: 'timer', inMs };
}

function linkOf(view: Link): Link {
  return { flow: view.flow, agent: view.agent, setup: view.setup, ...view.before ? { before: view.before } : {} };
}

function newLinkAsk(view: Link): string {
  const what = view.setup.what;
  const agent = view.agent?.name;
  return view.flow === 'reconnect'
    ? `Send me a new link to sign ${what} in again${agent ? ` for ${agent}` : ''}.`
    : `Send me a new link to connect ${what}${agent ? ` to ${agent}` : ''}.`;
}

// The shapes a result may take.

function isChangeResult(value: unknown): value is ChangeResult {
  return isRecord(value) && typeof value.status === 'string' && typeof value.summary === 'string';
}

function isSetup(value: unknown): value is Setup {
  return isRecord(value) && typeof value.url === 'string' && typeof value.what === 'string';
}

function isSetupStatus(value: unknown): value is SetupStatus {
  return isRecord(value) && typeof value.status === 'string';
}

// What the card shows.

const SIGN_IN_LINE = 'You sign in on Chickpea\'s page, never in this chat.';

export const present = presentSafely(presentView);

function presentView(state: State): Presentation<Action> {
  const base = { busy: state.busy, error: state.error };
  const { view } = state;
  switch (view.kind) {
    case 'waiting':
      return { ...base, avatar: 'none', title: 'Loading…', blocks: [], buttons: [] };
    case 'notice':
      return { ...base, avatar: 'none', title: view.title, blocks: [], buttons: [] };
    case 'first_answer':
      return { ...base, ...presentFirstAnswer(view) };
    case 'connected': {
      const row = connectedRow(view);
      return {
        ...base,
        ...header(view.flow, view.service, view.agent),
        announce: spoken(row),
        blocks: [{ kind: 'rows', rows: [row] }],
        ...!view.agent?.slackUrl && view.agent?.handle ? { foot: tryIt(view.agent.handle, view.agent.channels ?? []) } : {},
        buttons: [],
      };
    }
    default: {
      const row = linkRow(view);
      return {
        ...base,
        ...header(view.flow, view.setup.what, view.agent),
        // The title stays the same in every state; the row says what changed.
        ...view.kind === 'finishing' || view.kind === 'ended' ? { announce: spoken(row) } : {},
        subtitle: [{ text: SIGN_IN_LINE }],
        blocks: [{ kind: 'rows', rows: [row] }],
        buttons: [],
      };
    }
  }
}

function spoken(row: Row<Action>): string {
  return row.detail ? `${row.title}. ${row.detail}` : row.title;
}

function header(flow: Flow, what: string, agent: AgentLabel | undefined): Pick<Presentation<Action>, 'avatar' | 'avatarUrl' | 'title'> {
  return {
    avatar: 'agent',
    avatarUrl: agent?.avatarUrl,
    title: flow === 'reconnect' ? `Sign ${what} in again` : agent ? `Connect ${what} to ${agent.name}` : `Connect ${what}`,
  };
}

function linkRow(view: Extract<View, { kind: 'start' | 'finishing' | 'ended' | 'elsewhere' }>): Row<Action> {
  const what = view.setup.what;
  switch (view.kind) {
    case 'start':
      return {
        icon: 'tile',
        tile: tileLetter(what),
        title: what,
        detail: sharedBy(view),
        control: { label: view.flow === 'reconnect' ? 'Reconnect' : 'Connect', action: 'connect', style: 'primary' },
      };
    case 'finishing':
      return {
        icon: 'now',
        title: `Waiting for ${what}`,
        detail: view.slow
          ? 'Finish on the Chickpea page that opened, then press I\'m done.'
          : 'Finish on the Chickpea page that opened, then come back.',
        control: { label: 'I\'m done', action: 'done', style: 'secondary' },
      };
    case 'ended':
      return {
        icon: 'failed',
        title: view.why === 'expired' ? 'This link expired' : view.why === 'cancelled' ? 'This link was cancelled' : `${what} did not connect`,
        detail: 'Ask for a new link to try again.',
        control: { label: 'Get a new link', action: 'new_link', style: 'secondary' },
      };
    case 'elsewhere':
      return {
        icon: 'tile',
        tile: tileLetter(what),
        title: what,
        detail: 'Chickpea can\'t connect it from this card. Use the link in the chat.',
      };
  }
}

/**
 * Only what Chickpea checked: a custom connection's one request, or nothing
 * more than that it is connected. Then its next step: "See its first answer"
 * for an Agent with a first question saved, or Slack.
 */
function connectedRow(view: Extract<View, { kind: 'connected' }>): Row<Action> {
  const { check } = view;
  return {
    icon: 'done',
    title: `${view.service} is connected`,
    ...check === 'checking' ? { detail: 'Chickpea is checking it…' }
      : check ? { detail: `Chickpea checked it. ${check.words}`, ...check.status === 'ok' || check.status === 'unknown' ? {} : { tone: 'warn' as const } }
        : {},
    ...connectedNextStep(view),
  };
}

function connectedNextStep(view: Extract<View, { kind: 'connected' }>): Pick<Row<Action>, 'control'> {
  if (view.firstAsk && view.agent) return { control: { label: 'See its first answer', action: 'try_once', style: 'secondary' } };
  return view.agent?.slackUrl ? { control: { label: 'Open in Slack', action: 'open_slack', style: 'secondary' } } : {};
}

function sharedBy(view: Link): string | undefined {
  if (view.setup.owner === 'member') return 'Your own account';
  if (view.setup.owner === 'team') return view.agent ? `For everyone who uses ${view.agent.name}` : 'For everyone who uses it';
  return undefined;
}

function tileLetter(what: string): string {
  return [...what.trim()][0]?.toUpperCase() ?? '?';
}
