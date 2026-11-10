import type { z } from 'zod';

import type * as schemas from '../../management/mcp-v5/schemas.ts';
import {
  agentNamed,
  call,
  errorOf,
  GENERIC,
  httpsUrl,
  isFix,
  isRecord,
  NOTHING,
  opensSetupLink,
  outdated,
  presentSafely,
  sequenced,
  show,
  stay,
  tell,
  UNREACHABLE,
  type CardEvent,
  type CardState,
  type Effect,
  type Next,
  type Presentation,
  type Row,
  type ToolResult,
} from '../card-model.ts';
import { plainWords } from '../check-words.ts';

/**
 * The health card: one Agent's check_agent result. Each part that needs
 * attention is a row with its fix; the healthy parts fold into one row.
 * Nothing changes without the person: a fix runs only on its press, and
 * coming back into view reads the Agent's connections with get_agent, which
 * sends nothing outside Chickpea. Check again reruns check_agent, which
 * tests custom connections, so it too waits for a press.
 */

type Checked = z.infer<typeof schemas.checkAgentOutput>;
type Check = Checked['checks'][number];
type ConnectionStatus = z.infer<typeof schemas.getAgentOutput>['connections'][number]['status'];

export type View =
  | { kind: 'waiting' }
  | { kind: 'notice'; title: string }
  | {
      kind: 'health';
      checked: Checked;
      /** The healthy parts are shown. */
      open?: true;
      /** Each connection's status when the card first read the Agent. */
      before?: Record<string, ConnectionStatus>;
      /** Connections that became ready since then. */
      fixed?: string[];
      /** Rows whose setup link the person opened from the card, the latest last. */
      opened?: number[];
      /** The row whose fix is running. */
      fixing?: number;
    };

export type State = CardState<View>;
export type Action = 'show' | 'hide' | 'check_again' | `fix:${number}`;
export type Event = CardEvent<Action>;

export const INITIAL: State = { view: { kind: 'waiting' }, busy: false, seq: 0 };

export const step = sequenced(transition);

type Health = Extract<View, { kind: 'health' }>;

function transition(state: State, event: Event): Next<View> {
  switch (event.type) {
    case 'result':
      return fromResult(event.result);
    case 'press':
      return state.busy || state.view.kind !== 'health' ? stay(state) : press(state, state.view, event.action);
    case 'reply':
      return outdated(state, event.call) ? stay(state) : reply(state, event.call.tool, event.result);
    case 'unreachable':
      if (outdated(state, event.call)) return stay(state);
      // A failed read leaves the buttons alone; a pressed call gives them back with the reason,
      // and its answer, should it still come, opens nothing: no fix is running any more.
      if (event.call.tool === 'get_agent' || state.view.kind !== 'health') return stay(state);
      return stay({ view: settled(state.view), busy: false, error: UNREACHABLE });
    case 'refused':
      return stay({ ...state, error: GENERIC });
    case 'no_result':
      return state.view.kind === 'waiting' ? show<View>(NOTHING) : stay(state);
    case 'tick':
      return stay(state);
    case 'reread':
      return !state.busy && state.view.kind === 'health'
        ? stay(state, [call('get_agent', { agentId: state.view.checked.agent.agentId })])
        : stay(state);
  }
}

function fromResult(result: ToolResult): Next<View> {
  const failure = errorOf(result);
  if (failure) return show({ kind: 'notice', title: failure });
  return isChecked(result.structuredContent) ? show({ kind: 'health', checked: result.structuredContent }) : show<View>(NOTHING);
}

function press(state: State, view: Health, action: Action): Next<View> {
  switch (action) {
    case 'show':
      return show({ ...view, open: true });
    case 'hide': {
      const { open: _open, ...folded } = view;
      return show(folded);
    }
    case 'check_again':
      return view.checked.person.you ? { state: { view, busy: true }, effects: [checkAgain(view.checked)] } : stay(state);
    default: {
      const index = Number(action.slice('fix:'.length));
      const check = view.checked.checks[index];
      const fix = check?.fix;
      if (!check || !fix) return stay(state);
      if ('url' in fix) {
        const url = httpsUrl(fix.url);
        return url ? stay(state, [{ type: 'open', url }]) : stay(state);
      }
      if (opensSetupLink(fix)) return { state: { view: { ...view, fixing: index }, busy: true }, effects: [call(fix.tool, fix.arguments)] };
      return stay(state, [askChat(view, index)]);
    }
  }
}

/** A fix the card does not run itself: the model proposes it in the chat first. */
function askChat(view: Health, index: number): Effect {
  const check = view.checked.checks[index]!;
  return { type: 'message', sent: `Fix ${check.name} for ${view.checked.agent.name}: ${check.fix!.label}.` };
}

function checkAgain(checked: Checked): Effect {
  return call('check_agent', {
    agentId: checked.agent.agentId,
    ...checked.place.kind === 'channel' && checked.place.channelId ? { place: checked.place.channelId } : {},
  });
}

function reply(state: State, tool: string, result: ToolResult): Next<View> {
  const { view } = state;
  if (view.kind !== 'health') return stay(state);
  const failure = errorOf(result);
  const content = result.structuredContent;
  if (tool === 'get_agent') {
    // A pressed call is in flight; its reply decides the view.
    if (state.busy || failure) return stay(state);
    return connections(state, view, content);
  }
  if (tool === 'check_agent') {
    if (failure || !isChecked(content)) return stay({ view, busy: false, error: failure ?? GENERIC });
    const problems = content.checks.filter(({ status }) => status === 'failing' || status === 'warning').length;
    return tell(
      show({ kind: 'health', checked: content, ...view.open ? { open: true as const } : {} }),
      `The person checked ${agentNamed(content.agent.name)} again from the card: ${problems === 0 ? 'no problems found' : `${problems} ${problems === 1 ? 'thing needs' : 'things need'} attention`}.`,
    );
  }
  // The fix's setup link: the press that asked for it opens it, when it is Chickpea's page for that one connection.
  const setup = !failure && isRecord(content) && isRecord(content.setup) ? content.setup : undefined;
  const url = httpsUrl(setup?.url);
  if (!url || view.fixing === undefined) {
    const summary = isRecord(content) && typeof content.summary === 'string' ? content.summary : undefined;
    return stay({ view: settled(view), busy: false, error: failure ?? summary ?? GENERIC });
  }
  if (typeof setup?.setupToken !== 'string') return show(settled(view), [askChat(view, view.fixing)]);
  const opened = [...(view.opened ?? []).filter((index) => index !== view.fixing), view.fixing];
  const fix = view.checked.checks[view.fixing]?.fix;
  return tell(
    show({ ...settled(view), opened }, [{ type: 'open', url }]),
    `The person opened Chickpea's page to ${fix?.label ?? 'fix it'} for ${agentNamed(view.checked.agent.name)} from the card. It changes when they finish there.`,
  );
}

/** The Agent's connections now: one that became ready since the card first looked reads as healthy. */
function connections(state: State, view: Health, content: unknown): Next<View> {
  const rows = isRecord(content) && Array.isArray(content.connections) ? content.connections as Array<{ connectionId: string; status: ConnectionStatus }> : undefined;
  if (!rows) return stay(state);
  const now = Object.fromEntries(rows.map(({ connectionId, status }) => [connectionId, status]));
  if (!view.before) return show({ ...view, before: now });
  const fixed = view.checked.checks
    .filter(({ part, status, connectionId }) => part === 'connection' && status !== 'ok' && connectionId !== undefined &&
      view.before![connectionId] !== 'ready' && now[connectionId] === 'ready')
    .map(({ connectionId }) => connectionId!);
  const added = fixed.filter((id) => !view.fixed?.includes(id));
  return added.length ? show({ ...view, fixed: [...view.fixed ?? [], ...added] }) : stay(state);
}

function settled({ fixing: _fixing, ...view }: Health): Health {
  return view;
}

/** A check of a shape the card does not know would read as healthy, so every row is checked. */
function isChecked(value: unknown): value is Checked {
  return isRecord(value) && isRecord(value.agent) && typeof value.agent.name === 'string' &&
    isRecord(value.person) && isRecord(value.place) && Array.isArray(value.checks) &&
    value.checks.every((check) => isRecord(check) && typeof check.name === 'string' && typeof check.detail === 'string' &&
      typeof check.part === 'string' && Object.hasOwn(PART_WORDS, check.part) &&
      typeof check.status === 'string' && Object.hasOwn(ORDER, check.status) && isFix(check.fix));
}

// What the card shows.

const PART_WORDS: Record<Check['part'], string> = {
  connection: 'connections',
  model: 'model',
  slack: 'Slack',
  channel: 'Channels',
  schedule: 'schedules',
  repository: 'repositories',
  website_login: 'website logins',
  admission: 'who can reach it',
};

const ORDER: Record<Check['status'], number> = { failing: 0, warning: 1, unknown: 2, ok: 3 };

export const present = presentSafely(presentView);

function presentView(state: State): Presentation<Action> {
  const base = { busy: state.busy, error: state.error };
  const { view } = state;
  switch (view.kind) {
    case 'waiting':
      return { ...base, avatar: 'none', title: 'Loading…', blocks: [], buttons: [] };
    case 'notice':
      return { ...base, avatar: 'none', title: view.title, blocks: [], buttons: [] };
    case 'health':
      return { ...base, ...presentHealth(view) };
  }
}

function presentHealth(view: Health): Omit<Presentation<Action>, 'busy' | 'error'> {
  const { checked } = view;
  const parts = checked.checks.map((check, index): Part => ({ check, index, status: statusOf(view, check) }));
  const problems = parts.filter(({ status }) => status === 'failing' || status === 'warning');
  const unknown = parts.filter(({ status }) => status === 'unknown');
  const healthy = parts.filter(({ status }) => status === 'ok');
  const flagged = [...problems, ...unknown].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.index - b.index);
  const mention = checked.agent.handle ? `@${checked.agent.handle}` : checked.agent.name;
  const words = [...new Set(checked.checks.map(({ part }) => PART_WORDS[part]))];
  const others = flagged.length > 0;
  const rows: Array<Row<Action>> = [
    ...flagged.map((part) => partRow(view, part)),
    ...healthy.length ? [{
      icon: 'done' as const,
      title: `${healthy.length} ${others ? 'other ' : ''}${healthy.length === 1 ? 'part looks' : 'parts look'} healthy`,
      control: view.open
        ? { label: 'Hide', action: 'hide' as const, style: 'toggle' as const }
        : { label: 'Show', action: 'show' as const, style: 'toggle' as const },
    }] : [],
    ...view.open ? healthy.map((part) => partRow(view, part)) : [],
  ];
  const title = problems.length > 0
    ? `${problems.length} ${problems.length === 1 ? 'thing needs' : 'things need'} attention`
    : unknown.length > 0 ? 'No problems found' : 'Everything looks healthy';
  const opened = view.opened?.at(-1);
  const lastOpened = opened === undefined ? undefined : parts[opened];
  return {
    avatar: parts.some(({ status }) => status === 'failing') ? 'alert' : 'agent',
    avatarUrl: httpsUrl(checked.agent.avatarUrl),
    title,
    // The title may stay the same after a fix; the row it changed is what a screen reader needs.
    ...lastOpened ? { announce: `${title}. ${titleOf(lastOpened.check)}: ${partRow(view, lastOpened).detail}` } : {},
    subtitle: [{ text: `${mention} · checked its ${joinWords(words)}` }],
    blocks: rows.length ? [{ kind: 'rows', rows }] : [],
    buttons: checked.person.you ? [{ label: 'Check again', action: 'check_again', tone: 'secondary' }] : [],
  };
}

function statusOf(view: Health, check: Check): Check['status'] {
  return check.connectionId !== undefined && view.fixed?.includes(check.connectionId) ? 'ok' : check.status;
}

type Part = { check: Check; index: number; status: Check['status'] };

function partRow(view: Health, { check, index, status }: Part): Row<Action> & { detail: string } {
  if (status === 'ok') {
    return { icon: 'done', title: titleOf(check), detail: view.fixed?.includes(check.connectionId ?? '') ? 'Connected.' : plainWords(check) };
  }
  const opened = view.opened?.includes(index);
  return {
    icon: opened ? 'now' : status === 'failing' ? 'failed' : status === 'warning' ? 'warning' : 'unknown',
    title: titleOf(check),
    detail: opened ? 'Finish on the Chickpea page that opened, then come back.' : plainWords(check),
    ...check.fix ? { control: { label: check.fix.label, action: `fix:${index}` as const, style: 'link' as const } } : {},
  };
}

/**
 * Who a message comes from reads as a sentence: "You, in a DM". A Channel
 * Chickpea has no name for is named by its Slack ID in the result; the card
 * says "a private Channel", as the Agent card does, never the ID.
 */
function titleOf(check: Check): string {
  const { channelId } = check;
  if (check.part === 'channel' && channelId && check.name === channelId) return 'A private Channel';
  const name = check.part === 'admission' && channelId && check.name.endsWith(`, in ${channelId}`)
    ? `${check.name.slice(0, -channelId.length)}a private Channel`
    : check.name;
  return check.part === 'admission' ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
}

function joinWords(words: readonly string[]): string {
  return words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}
