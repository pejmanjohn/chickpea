import type { z } from 'zod';

import { channelNames } from '../../management/channel-names.ts';
import type * as schemas from '../../management/mcp-v5/schemas.ts';
import { describeTextChange } from '../../management/text-change-wording.ts';
import {
  call,
  errorCode,
  errorOf,
  GENERIC,
  httpsUrl,
  isRecord,
  NOTHING,
  outdated,
  pollDelay,
  POLL_CEILING_MS,
  presentSafely,
  sequenced,
  show,
  stay,
  type Block,
  type Button,
  type Call,
  type CardEvent,
  type CardState,
  type Effect,
  type Next,
  type Presentation,
  type ToolResult,
  UNREACHABLE,
} from '../card-model.ts';

/**
 * The Agent card as a state machine. Every host message, button press and
 * tool reply is an event; `step` returns the next state and the effects to
 * run. `present` decides everything the card shows.
 */

type Proposal = z.infer<typeof schemas.proposeAgentOutput>;
type ChangePreview = z.infer<typeof schemas.proposeAgentChangeOutput>;
type ChangeResult = z.infer<typeof schemas.changeResultOutput>;
type CreationStatus = z.infer<typeof schemas.getCreationStatusOutput>;
type Confirmation = NonNullable<ChangeResult['confirmation']>;
type CreateArguments = Proposal['create']['arguments'];
type AgentLabel = { name: string; handle?: string | undefined };
type Need = { name: string };

export type View =
  | { kind: 'waiting' }
  | { kind: 'proposal'; proposal: Proposal }
  | { kind: 'similar'; summary: string; create: CreateArguments; name: string }
  | {
      kind: 'creating';
      agentId: string;
      agent: AgentLabel;
      workspaceName?: string | undefined;
      answersIn: string[];
      needs: Need[];
      adminUrl?: string | undefined;
      status?: CreationStatus;
      startedAt: number;
      slow?: true;
      /** Polls in a row that failed; each waits longer before the next. */
      failures?: number;
    }
  | {
      kind: 'ready';
      agentId: string;
      agent: AgentLabel;
      answersIn: string[];
      needs: Need[];
      adminUrl?: string | undefined;
      status: CreationStatus;
    }
  | { kind: 'change'; preview: ChangePreview; stale?: true }
  | {
      kind: 'done';
      summary: string;
      agent?: AgentLabel & { agentId: string };
      slackUrl?: string | undefined;
      undoToken?: string | undefined;
      version?: string | undefined;
      /** A saved edit: the card suggests trying it. */
      saved?: true;
    }
  | { kind: 'confirm'; confirmation: Confirmation; agent?: AgentLabel }
  | { kind: 'notice'; title: string; body?: string | undefined };

export type State = CardState<View>;

export type Action =
  | 'create' | 'create_anyway' | 'change_something'
  | 'open_slack' | 'open_admin' | 'next_step' | 'check_again'
  | 'save' | 'cancel'
  | 'confirm' | 'keep'
  | 'undo';

/** Calls that only read. A reply that comes after the card moved on is stale and dropped. */
const READS: ReadonlySet<string> = new Set(['get_creation_status', 'get_agent']);

export type Event = CardEvent<Action>;

export const INITIAL: State = { view: { kind: 'waiting' }, busy: false, seq: 0 };

export const step = sequenced(transition);

function transition(state: State, event: Event): Next<View> {
  switch (event.type) {
    case 'result':
      return fromResult(event.result, event.now);
    case 'press':
      return state.busy ? stay(state) : press(state, event.action, event.now);
    case 'reply':
      return outdated(state, event.call) ? stay(state) : reply(state, event.call, event.result, event.now);
    case 'unreachable':
      if (outdated(state, event.call)) return stay(state);
      if (!READS.has(event.call.tool)) return stay({ ...state, busy: false, error: UNREACHABLE });
      // A failed read is not a failed write: it leaves `busy` alone, and a poll tries again later.
      if (state.view.kind !== 'creating') return stay(state);
      return keepPolling({ ...state.view, failures: (state.view.failures ?? 0) + 1 }, event.now);
    case 'refused':
      return stay({ ...state, error: GENERIC });
    case 'no_result':
      return state.view.kind === 'waiting' ? show(NOTHING) : stay(state);
    case 'tick':
      return state.busy ? stay(state) : tick(state, event.now);
    case 'reread':
      return state.busy ? stay(state) : reread(state, event.now);
  }
}

// What a tool result becomes.

function fromResult(result: ToolResult, now: number): Next<View> {
  const failure = errorOf(result);
  if (failure) return show({ kind: 'notice', title: failure });
  const content = result.structuredContent;
  if (isProposal(content)) return show({ kind: 'proposal', proposal: content });
  if (isChangePreview(content)) return show({ kind: 'change', preview: content });
  if (isChangeResult(content)) {
    if (result._meta?.['chickpea/tool'] === 'create_agent' && content.status === 'done' && content.agent) {
      return creating(content, { answersIn: [], needs: [] }, now);
    }
    return changeView(content, now);
  }
  return show(NOTHING);
}

function changeView(result: ChangeResult, now: number, options: { saved?: boolean } = {}): Next<View> {
  switch (result.status) {
    case 'needs_confirmation':
      if (!result.confirmation) return show({ kind: 'notice', title: result.summary });
      if (expired(result.confirmation, now)) return show(EXPIRED);
      return show(
        { kind: 'confirm', confirmation: result.confirmation, ...result.agent ? { agent: result.agent } : {} },
        [expiryTimer(result.confirmation, now)],
      );
    case 'done':
      return show({
        kind: 'done',
        summary: result.summary,
        ...result.agent ? { agent: result.agent, slackUrl: httpsUrl(result.agent.links?.slack) } : {},
        undoToken: result.undoToken,
        version: result.version,
        ...options.saved ? { saved: true as const } : {},
      });
    default:
      return show({ kind: 'notice', title: result.summary });
  }
}

function creating(
  result: ChangeResult,
  from: { answersIn: string[]; needs: Need[]; workspaceName?: string | undefined },
  now: number,
): Next<View> {
  const agent = result.agent!;
  return show({
    kind: 'creating',
    agentId: agent.agentId,
    agent: { name: agent.name, handle: agent.handle },
    workspaceName: from.workspaceName,
    answersIn: from.answersIn,
    needs: from.needs,
    adminUrl: httpsUrl(agent.links?.admin),
    startedAt: now,
  }, [call('get_creation_status', { agentId: agent.agentId })]);
}

// Button presses. Only a press ever sends a write, and pressing the same
// button on the same card again sends the same call, so a retry replays.

function press(state: State, action: Action, now: number): Next<View> {
  const { view } = state;
  const busy = (effect: Effect): Next<View> => stay({ view, busy: true }, [effect]);
  switch (action) {
    case 'create':
      return view.kind === 'proposal' ? busy(call('create_agent', view.proposal.create.arguments)) : stay(state);
    case 'create_anyway':
      return view.kind === 'similar'
        ? busy(call('create_agent', { ...view.create, createEvenIfSimilar: true, idempotencyKey: `${view.create.idempotencyKey}:anyway` }))
        : stay(state);
    case 'change_something': {
      const name = view.kind === 'proposal' ? view.proposal.proposal.name : view.kind === 'similar' ? view.name : undefined;
      return name
        ? stay(state, [{ type: 'message', draft: `Change ${name}: `, sent: `I want to change something about ${name} before you create it.` }])
        : stay(state);
    }
    case 'save':
      return view.kind === 'change' && !view.stale ? busy(call('update_agent', view.preview.save.arguments)) : stay(state);
    case 'cancel':
      return view.kind === 'change' ? show({ kind: 'notice', title: 'Not saved', body: 'Nothing changed.' }) : stay(state);
    case 'confirm':
      if (view.kind !== 'confirm') return stay(state);
      if (expired(view.confirmation, now)) return show(EXPIRED);
      return busy(call('confirm_change', { confirmToken: view.confirmation.confirmToken }));
    case 'keep':
      return view.kind === 'confirm'
        ? show({ kind: 'notice', title: 'Kept as it is', body: 'Nothing changed.' })
        : stay(state);
    case 'undo':
      return view.kind === 'done' && view.undoToken
        ? busy(call('undo_change', { undoToken: view.undoToken, idempotencyKey: `undo:${view.undoToken}` }))
        : stay(state);
    case 'open_slack': {
      const url = slackUrlOf(view);
      return url ? stay(state, [{ type: 'open', url }]) : stay(state);
    }
    case 'open_admin':
      return (view.kind === 'ready' || view.kind === 'creating') && view.adminUrl
        ? stay(state, [{ type: 'open', url: view.adminUrl }])
        : stay(state);
    case 'next_step': {
      const need = view.kind === 'ready' ? view.needs[0] : undefined;
      return need && view.kind === 'ready'
        ? stay(state, [{ type: 'message', sent: `Connect ${need.name} to ${view.agent.name}.` }])
        : stay(state);
    }
    case 'check_again':
      return reread(state, now);
  }
}

// Replies to the card's own tool calls.

function reply(state: State, made: Call, result: ToolResult, now: number): Next<View> {
  const { view } = state;
  const failure = errorOf(result);
  const code = errorCode(result);
  const content = result.structuredContent;
  switch (made.tool) {
    case 'create_agent': {
      if (failure || !isChangeResult(content)) return stay({ view, busy: false, error: failure ?? GENERIC });
      const from = view.kind === 'proposal' ? view.proposal.proposal : undefined;
      if (content.status === 'done' && content.agent) {
        return creating(content, {
          answersIn: channelNames(from?.answersIn ?? []),
          needs: from?.needs ?? [],
          workspaceName: from?.workspaceName,
        }, now);
      }
      if (content.status === 'similar_agent_exists') {
        const create = view.kind === 'proposal' ? view.proposal.create.arguments : view.kind === 'similar' ? view.create : undefined;
        if (create) return show({ kind: 'similar', summary: content.summary, create, name: create.name });
      }
      return changeView(content, now);
    }
    case 'get_creation_status':
      return creationStatus(state, failure ? undefined : content as CreationStatus, now);
    case 'update_agent':
      if (failure || !isChangeResult(content)) {
        return view.kind === 'change' && code === 'changed_since_read'
          ? stay({ view: { ...view, stale: true }, busy: false, error: failure })
          : stay({ view, busy: false, error: failure ?? GENERIC });
      }
      return changeView(content, now, { saved: true });
    case 'confirm_change':
      if (code === 'confirmation_expired') return show(EXPIRED);
      if (failure || !isChangeResult(content)) {
        return code === 'temporarily_unavailable' || !failure
          ? stay({ view, busy: false, error: failure ?? GENERIC })
          : show({ kind: 'notice', title: 'Nothing changed', body: failure });
      }
      return changeView(content, now);
    case 'undo_change':
      if (failure || !isChangeResult(content)) {
        const gone = code === 'nothing_to_undo' || code === 'changed_since_read';
        return stay({
          view: gone && view.kind === 'done' ? { ...view, undoToken: undefined } : view,
          busy: false,
          error: failure ?? GENERIC,
        });
      }
      return changeView(content, now);
    case 'get_agent': {
      if (state.busy) return stay(state); // a write is in flight; its reply decides the view
      const version = failure ? undefined : (content as { version?: unknown } | undefined)?.version;
      if (typeof version !== 'string') return stay(state);
      if (view.kind === 'change' && version !== view.preview.save.arguments.version) return stay({ ...state, view: { ...view, stale: true } });
      if (view.kind === 'done' && view.undoToken && version !== view.version) return stay({ ...state, view: { ...view, undoToken: undefined } });
      return stay(state);
    }
    default:
      return stay({ ...state, busy: false });
  }
}

type Creating = Extract<View, { kind: 'creating' }>;

function creationStatus(state: State, status: CreationStatus | undefined, now: number): Next<View> {
  const { view } = state;
  if (view.kind !== 'creating' && view.kind !== 'ready') return stay(state);
  if (!status || typeof status.stage !== 'string') {
    return view.kind === 'creating' ? keepPolling({ ...view, failures: (view.failures ?? 0) + 1 }, now) : stay(state);
  }
  const settled = status.stage === 'needs_attention' || (status.stage !== 'joining' && status.channels !== 'joining');
  if (!settled) {
    const { failures: _failures, ...polling }: Creating = view.kind === 'creating' ? view : { ...view, kind: 'creating', startedAt: now };
    return keepPolling({ ...polling, status }, now);
  }
  return show({
    kind: 'ready',
    agentId: view.agentId,
    agent: view.agent,
    answersIn: view.answersIn,
    needs: view.needs,
    adminUrl: view.adminUrl,
    status,
  });
}

function keepPolling(view: Creating, now: number): Next<View> {
  if (now - view.startedAt >= POLL_CEILING_MS) return show({ ...view, slow: true });
  return show(view, [{ type: 'timer', inMs: pollDelay(view.failures) }]);
}

function tick(state: State, now: number): Next<View> {
  const { view } = state;
  if (view.kind === 'creating' && !view.slow) return stay(state, [call('get_creation_status', { agentId: view.agentId })]);
  if (view.kind === 'confirm' && expired(view.confirmation, now)) return show(EXPIRED);
  return stay(state);
}

/**
 * On mount with a kept state, and whenever the card comes back into view:
 * what the card shows may have changed elsewhere since.
 */
function reread(state: State, now: number): Next<View> {
  const { view } = state;
  switch (view.kind) {
    case 'creating': {
      const { slow: _slow, failures: _failures, ...polling } = view;
      return stay({ ...state, view: { ...polling, startedAt: now } }, [call('get_creation_status', { agentId: view.agentId })]);
    }
    case 'ready':
      return stay(state, [call('get_creation_status', { agentId: view.agentId })]);
    case 'change':
      return stay(state, [call('get_agent', { agentId: view.preview.save.arguments.agentId })]);
    case 'done':
      return view.undoToken && view.agent ? stay(state, [call('get_agent', { agentId: view.agent.agentId })]) : stay(state);
    case 'confirm': {
      if (expired(view.confirmation, now)) return show(EXPIRED);
      return stay(state, [expiryTimer(view.confirmation, now)]);
    }
    default:
      return stay(state);
  }
}

const EXPIRED: View = {
  kind: 'notice',
  title: 'This confirmation expired',
  body: 'Nothing changed. Ask again for a fresh one.',
};

/** A tick when the token expires, so an open card says so without a press. */
function expiryTimer(confirmation: Confirmation, now: number): Effect {
  return { type: 'timer', inMs: Math.max(0, Date.parse(confirmation.expiresAt) - now) };
}

function expired(confirmation: Confirmation, now: number): boolean {
  const at = Date.parse(confirmation.expiresAt);
  return Number.isFinite(at) && now >= at;
}

function slackUrlOf(view: View): string | undefined {
  if (view.kind === 'ready') return httpsUrl(view.status.slackUrl);
  if (view.kind === 'creating') return httpsUrl(view.status?.slackUrl);
  if (view.kind === 'done') return view.slackUrl;
  return undefined;
}

// The shapes a result may take. Fields the card shows are only ever drawn as text.

function isProposal(value: unknown): value is Proposal {
  return isRecord(value) && isRecord(value.proposal) && isRecord(value.create) && isRecord(value.create.arguments);
}

function isChangePreview(value: unknown): value is ChangePreview {
  return isRecord(value) && Array.isArray(value.changes) && isRecord(value.save) && isRecord(value.save.arguments);
}

function isChangeResult(value: unknown): value is ChangeResult {
  return isRecord(value) && typeof value.status === 'string' && typeof value.summary === 'string';
}

// What the card shows.

const FIELD_LABELS: Record<ChangePreview['changes'][number]['field'], string> = {
  name: 'Name',
  description: 'Description',
  handle: 'Slack handle',
  instructions: 'Instructions',
  on: 'On or off',
  model: 'Model',
  effort: 'Effort',
  imageModel: 'Image model',
  whoCanEdit: 'Who can edit',
};

const WHO_CAN_EDIT: Record<string, string> = {
  creator_and_admins: 'Its creator and workspace admins',
  all_workspace_members: 'Anyone in the workspace',
};

export const present = presentSafely(presentView);

function presentView(state: State): Presentation<Action> {
  const base = { busy: state.busy, error: state.error };
  const { view } = state;
  switch (view.kind) {
    case 'waiting':
      return { ...base, avatar: 'none', title: 'Loading…', blocks: [], buttons: [] };
    case 'proposal':
      return { ...base, ...presentProposal(view.proposal) };
    case 'similar':
      return {
        ...base,
        avatar: 'agent',
        title: 'An Agent like this already exists',
        blocks: [{ kind: 'text', text: view.summary }],
        buttons: [
          { label: 'Create it anyway', action: 'create_anyway', tone: 'primary' },
          { label: 'Change something', action: 'change_something', tone: 'secondary' },
        ],
      };
    case 'creating':
      return { ...base, ...presentCreating(view) };
    case 'ready':
      return { ...base, ...presentReady(view) };
    case 'change':
      return { ...base, ...presentChange(view.preview, view.stale === true) };
    case 'done':
      return {
        ...base,
        avatar: 'agent',
        title: view.summary.replace(/\.$/, ''),
        done: true,
        ...view.saved && view.agent?.handle
          ? { subtitle: [{ text: `Try it: mention @${view.agent.handle} in Slack.` }] }
          : {},
        blocks: [],
        buttons: [
          ...view.undoToken ? [{ label: 'Undo', action: 'undo' as const, tone: 'secondary' as const }] : [],
          ...view.slackUrl ? [{ label: 'Open in Slack', action: 'open_slack' as const, tone: 'secondary' as const }] : [],
        ],
      };
    case 'confirm':
      return {
        ...base,
        avatar: view.agent ? 'alert' : 'none',
        title: view.confirmation.ask.question,
        blocks: [{ kind: 'text', text: view.confirmation.ask.consequence }],
        buttons: [
          { label: view.confirmation.ask.confirm, action: 'confirm', tone: 'danger' },
          { label: view.confirmation.ask.keep, action: 'keep', tone: 'secondary' },
        ],
      };
    case 'notice':
      return {
        ...base,
        avatar: 'none',
        title: view.title,
        blocks: view.body ? [{ kind: 'text', text: view.body }] : [],
        buttons: [],
      };
  }
}

function presentProposal({ proposal, issues }: Proposal): Omit<Presentation<Action>, 'busy' | 'error'> {
  const answersIn = ['Your DMs', ...channelNames(proposal.answersIn)];
  return {
    avatar: 'agent',
    title: proposal.name,
    subtitle: [
      { text: `@${proposal.handle} · ` },
      proposal.handleAvailable ? { text: 'handle is free', tone: 'ok' } : { text: 'handle is taken', tone: 'warn' },
    ],
    blocks: [
      { kind: 'text', text: proposal.job },
      { kind: 'section', label: 'Example in Slack' },
      { kind: 'exchange', ask: proposal.sampleExchange.ask, answer: proposal.sampleExchange.answer, agent: proposal.name },
      {
        kind: 'facts',
        rows: [
          { label: 'Answers in', value: answersIn.join(' · ') },
          ...proposal.needs.length
            ? [{ label: 'Needs', value: '', chips: proposal.needs.map(({ name }) => name), note: 'you sign in after it\'s created' }]
            : [],
        ],
      },
      ...issues.map((text): Block<Action> => ({ kind: 'note', text, tone: 'warn' })),
    ],
    foot: proposal.workspaceName
      ? `Everyone in ${proposal.workspaceName}'s Slack can message it.`
      : 'Everyone in your Slack workspace can message it.',
    buttons: [
      { label: 'Create in Slack', action: 'create', tone: 'primary' },
      { label: 'Change something', action: 'change_something', tone: 'secondary' },
    ],
  };
}

/**
 * The steps follow get_creation_status: Slack first, then the hello, while
 * the Channels join beside them. A Channel waits its turn behind Slack.
 */
function presentCreating(view: Creating): Omit<Presentation<Action>, 'busy' | 'error'> {
  const stage = view.status?.stage ?? 'joining';
  const channels = view.status?.channels ?? 'none';
  const inSlack = stage !== 'joining';
  return {
    avatar: 'agent',
    title: view.agent.name,
    subtitle: [{ text: view.workspaceName ? `Setting up in ${view.workspaceName}'s Slack…` : 'Setting up in Slack…' }],
    blocks: [
      {
        kind: 'steps',
        steps: [
          { label: 'Created in Chickpea', state: 'done' },
          { label: view.agent.handle ? `Joining Slack as @${view.agent.handle}` : 'Joining Slack', state: inSlack ? 'done' : 'now' },
          // Ready without a hello: Slack has it, and no hello is coming.
          ...stage === 'ready' ? [] : [{ label: 'Saying hello to you', state: inSlack ? 'done' as const : 'todo' as const }],
          ...channels === 'none' ? [] : [{
            label: view.answersIn.length ? `Joining ${view.answersIn.join(', ')}` : 'Joining its Channels',
            state: channels === 'joined' ? 'done' as const
              : channels === 'needs_attention' ? 'failed' as const
                : inSlack ? 'now' as const : 'todo' as const,
          }],
        ],
      },
      ...view.slow
        ? [{ kind: 'note' as const, text: 'This is taking longer than usual. It keeps going, and the card checks again when you come back.' }]
        : [],
    ],
    buttons: view.slow ? [{ label: 'Check again', action: 'check_again', tone: 'secondary' }] : [],
  };
}

function presentReady(view: Extract<View, { kind: 'ready' }>): Omit<Presentation<Action>, 'busy' | 'error'> {
  const { status, agent } = view;
  const mention = agent.handle ? `@${agent.handle}` : agent.name;
  if (status.stage === 'needs_attention') {
    return {
      avatar: 'alert',
      title: `${agent.name} needs attention in Slack`,
      blocks: [{ kind: 'text', text: status.problem ?? 'Slack has not finished setting it up.' }],
      buttons: [
        ...view.adminUrl ? [{ label: 'Open in Admin', action: 'open_admin' as const, tone: 'primary' as const }] : [],
        ...httpsUrl(status.slackUrl) ? [{ label: 'Open in Slack', action: 'open_slack' as const, tone: 'secondary' as const }] : [],
      ],
    };
  }
  const reach = view.answersIn.length ? `your DMs and ${joinNames(view.answersIn)}` : 'your DMs';
  return {
    avatar: 'agent',
    title: status.stage === 'said_hello' ? `${mention} said hello to you in Slack` : `${agent.name} is ready in Slack`,
    subtitle: [{ text: `${agent.name} is ready · answers in ${reach}` }],
    blocks: [
      ...status.hello ? [{ kind: 'quote' as const, text: status.hello }] : [],
      ...status.channels === 'needs_attention'
        ? [{ kind: 'note' as const, text: 'It could not join one of its Channels yet.', tone: 'warn' as const }]
        : [],
    ],
    buttons: [
      ...httpsUrl(status.slackUrl) ? [{ label: 'Open in Slack', action: 'open_slack' as const, tone: 'primary' as const }] : [],
      ...readyNextStep(view),
    ],
  };
}

/**
 * The ready card's second button: the next thing the Agent needs. Once
 * nothing is missing it becomes "See its first answer", when that test turn
 * exists (U6a).
 */
function readyNextStep(view: Extract<View, { kind: 'ready' }>): Array<Button<Action>> {
  const need = view.needs[0];
  return need ? [{ label: `Connect ${need.name}`, action: 'next_step', tone: 'secondary' }] : [];
}

function presentChange(preview: ChangePreview, stale: boolean): Omit<Presentation<Action>, 'busy' | 'error'> {
  const count = preview.changes.length;
  return {
    avatar: 'agent',
    title: `Change ${preview.agent.name}`,
    subtitle: [{ text: `${count} ${count === 1 ? 'change' : 'changes'} · nothing is saved until you press Save` }],
    blocks: [
      ...preview.changes.flatMap((change): Array<Block<Action>> => [{ kind: 'section', label: FIELD_LABELS[change.field] }, ...changeBlocks(change)]),
      ...stale ? [{ kind: 'note' as const, text: 'It changed since this preview. Ask again for a fresh one.', tone: 'warn' as const }] : [],
    ],
    buttons: [
      ...stale ? [] : [{ label: 'Save', action: 'save' as const, tone: 'primary' as const }],
      { label: 'Cancel', action: 'cancel', tone: 'secondary' },
    ],
  };
}

function changeBlocks(change: ChangePreview['changes'][number]): Array<Block<Action>> {
  if (change.field === 'instructions') {
    return change.quotes.length
      ? change.quotes.map((quote) => ({ kind: 'quote', text: describeTextChange(quote, (text) => `“${text}”`) }))
      : [{ kind: 'text', text: 'Only spacing or line breaks change.' }];
  }
  if (change.field === 'on') return [{ kind: 'text', text: change.after ? 'Turns it back on.' : 'Turns it off.' }];
  const shown = (value: string | boolean | null | undefined) => {
    if (value === null || value === undefined || value === '') return FIELD_DEFAULTS[change.field] ?? 'Not set';
    if (change.field === 'handle') return `@${value}`;
    if (change.field === 'whoCanEdit') return WHO_CAN_EDIT[String(value)] ?? String(value);
    return String(value);
  };
  return [
    { kind: 'text', text: shown(change.after) },
    ...change.before === undefined ? [] : [{ kind: 'note' as const, text: `Was: ${shown(change.before)}` }],
  ];
}

const FIELD_DEFAULTS: Partial<Record<ChangePreview['changes'][number]['field'], string>> = {
  model: 'The workspace default',
  imageModel: 'The workspace default',
  effort: 'The model\'s standard effort',
};

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
