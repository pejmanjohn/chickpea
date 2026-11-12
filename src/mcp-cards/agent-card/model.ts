import type { z } from 'zod';

import { isAgentId } from '../../config/agent-id.ts';
import { channelNames } from '../../management/channel-names.ts';
import type * as schemas from '../../management/mcp-v5/schemas.ts';
import { describeTextChange, describeWholeTextChange } from '../../management/text-change-wording.ts';
import { textChangeWindows } from '../../management/text-changes.ts';
import {
  agentNamed,
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
  quoted,
  sequenced,
  show,
  stay,
  tell,
  toolOf,
  tryIt,
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
import {
  checkingView,
  presentFirstAnswer,
  stillAnswering,
  stillAnsweringOf,
  stepFirstAnswer,
  tryAgain,
  tryOnce,
  type FirstAnswer,
  type StillAnswering,
  type Tested,
} from '../first-answer.ts';

/**
 * The Agent card as a state machine. Every host message, button press and
 * tool reply is an event; `step` returns the next state and the effects to
 * run. `present` decides everything the card shows. After a press's write
 * answers, the card tells the host's model what the person did.
 */

type Proposal = z.infer<typeof schemas.proposeAgentOutput>;
type ChangePreview = z.infer<typeof schemas.proposeAgentChangeOutput>;
type ChangeResult = z.infer<typeof schemas.changeResultOutput>;
type CreationStatus = z.infer<typeof schemas.getCreationStatusOutput>;
type Confirmation = NonNullable<ChangeResult['confirmation']>;
type CreateArguments = Proposal['create']['arguments'];
type AgentStatus = NonNullable<NonNullable<ChangeResult['agent']>['status']>;
type AgentLabel = { name: string; handle?: string | undefined };
type Need = { name: string };
/** The question and answer this card's own proposal promised. */
type Promised = NonNullable<Tested['promised']>;

type Offer =
  | { kind: 'proposal'; proposal: Proposal }
  | {
      kind: 'similar';
      summary: string;
      create: CreateArguments;
      name: string;
      avatarUrl?: string | undefined;
      promised?: Promised | undefined;
    };

export type View =
  | { kind: 'waiting' }
  | Offer
  /** Create was pressed: the steps show while create_agent runs; a failure goes back to the offer. */
  | { kind: 'starting'; from: Offer }
  | {
      kind: 'creating';
      agentId: string;
      agent: AgentLabel;
      avatarUrl?: string | undefined;
      workspaceName?: string | undefined;
      answersIn: string[];
      needs: Need[];
      adminUrl?: string | undefined;
      status?: CreationStatus;
      startedAt: number;
      slow?: true;
      /** Polls in a row that failed; each waits longer before the next. */
      failures?: number;
      /** The person created it from this card, so its arrival is theirs to hear about. */
      byPress?: true;
      promised?: Promised | undefined;
    }
  | {
      kind: 'ready';
      agentId: string;
      agent: AgentLabel;
      avatarUrl?: string | undefined;
      answersIn: string[];
      needs: Need[];
      adminUrl?: string | undefined;
      status: CreationStatus;
      promised?: Promised | undefined;
    }
  /** "See its first answer", pressed on the ready card, or "Try it again" on a Saved card. */
  | FirstAnswer
  /**
   * `whole`: the instructions change as the card's own read of the saved
   * instructions finds it, every changed word quoted, in place of the
   * preview's quotes, which may cut the change.
   */
  | { kind: 'change'; preview: ChangePreview; stale?: true; whole?: string[] }
  | {
      kind: 'done';
      summary: string;
      agent?: AgentLabel & { agentId: string };
      avatarUrl?: string | undefined;
      status?: AgentStatus | undefined;
      /** Its Channels' names, where a mention reaches it. */
      channels?: string[];
      slackUrl?: string | undefined;
      undoToken?: string | undefined;
      version?: string | undefined;
      /** A saved edit: the card suggests trying it. */
      saved?: true;
      /** The card offers "Try it again": the Agent has a first question, and the save changed how it answers. */
      practice?: true;
    }
  /**
   * "Are you sure?". Without its token (a host that dropped `_meta`, or a
   * result from before the card held one) it asks nothing and says where
   * the person can make the change instead.
   */
  | {
      kind: 'confirm';
      confirmation: Confirmation;
      agent?: AgentLabel & { agentId: string };
      avatarUrl?: string | undefined;
      adminUrl?: string | undefined;
    }
  /**
   * A re-read found the Agent archived, or no longer there for this person:
   * deleted, or out of their reach. Nothing on the card applies to it any more.
   */
  | { kind: 'gone'; agent: AgentLabel; why: 'unavailable' | 'archived'; avatarUrl?: string | undefined }
  | { kind: 'notice'; title: string; body?: string | undefined };

export type State = CardState<View>;

export type Action =
  | 'create' | 'create_anyway' | 'change_something'
  | 'open_slack' | 'open_admin' | 'next_step' | 'check_again'
  | 'try_once' | 'try_fix'
  | 'save' | 'cancel'
  | 'confirm' | 'keep'
  | 'undo';

/** Calls that only read. A reply that comes after the card moved on is stale and dropped. */
const READS: ReadonlySet<string> = new Set(['get_creation_status', 'get_agent', 'get_confirmation']);

export type Event = CardEvent<Action>;

/** The fields a save can change that change how the Agent answers its first question. */
const ANSWER_FIELDS: ReadonlySet<string> = new Set<ChangePreview['changes'][number]['field']>(['instructions', 'model', 'effort']);

export const INITIAL: State = { view: { kind: 'waiting' }, busy: false, seq: 0 };

export const step = sequenced(transition, { remember, resume });

function transition(state: State, event: Event): Next<View> {
  const { view } = state;
  if (view.kind === 'first_answer' && event.type !== 'result' && !undoing(event)) return stepFirstAnswer({ ...state, view }, event);
  switch (event.type) {
    case 'result':
      return fromResult(event.result, event.now);
    case 'press':
      return state.busy ? stay(state) : press(state, event.action, event.now);
    case 'reply':
      return outdated(state, event.call) && !lateCreate(state, event.call) ? stay(state) : reply(state, event.call, event.result, event.now);
    case 'unreachable':
      if (outdated(state, event.call)) return stay(state);
      if (!READS.has(event.call.tool)) {
        // Create again replays the same call, so the offer comes back with its buttons.
        return stay({ view: state.view.kind === 'starting' ? state.view.from : state.view, busy: false, error: UNREACHABLE });
      }
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
    const tool = toolOf(result);
    if (tool === 'create_agent' && content.status === 'done' && content.agent) {
      return creating(content, { answersIn: [], needs: [] }, now);
    }
    // A save the model made itself reads like one from the card; an undo offers no second undo.
    return changeView(content, now, { saved: tool === 'update_agent', undone: tool === 'undo_change' });
  }
  return show(NOTHING);
}

function changeView(result: ChangeResult, now: number, options: { saved?: boolean; undone?: boolean; practice?: boolean } = {}): Next<View> {
  switch (result.status) {
    case 'needs_confirmation':
      if (!result.confirmation) return show({ kind: 'notice', title: result.summary });
      if (expired(result.confirmation, now)) return show(EXPIRED);
      return show(
        {
          kind: 'confirm',
          confirmation: result.confirmation,
          ...result.agent
            ? {
                agent: { agentId: result.agent.agentId, name: result.agent.name, handle: result.agent.handle },
                avatarUrl: httpsUrl(result.agent.avatarUrl),
                adminUrl: httpsUrl(result.agent.links?.admin),
              }
            : {},
        },
        [expiryTimer(result.confirmation, now)],
      );
    case 'done': {
      const { agent } = result;
      return show({
        kind: 'done',
        summary: result.summary,
        ...agent
          ? {
              agent: { agentId: agent.agentId, name: agent.name, handle: agent.handle },
              avatarUrl: httpsUrl(agent.avatarUrl),
              status: agent.status,
              channels: channelNames(agent.channels ?? []),
              slackUrl: httpsUrl(agent.links?.slack),
            }
          : {},
        undoToken: options.undone ? undefined : result.undoToken,
        version: result.version,
        ...options.saved ? { saved: true as const } : {},
        ...options.practice ? { practice: true as const } : {},
      });
    }
    default:
      return show({ kind: 'notice', title: result.summary });
  }
}

function creating(
  result: ChangeResult,
  from: {
    answersIn: string[];
    needs: Need[];
    workspaceName?: string | undefined;
    avatarUrl?: string | undefined;
    byPress?: true;
    promised?: Promised | undefined;
  },
  now: number,
): Next<View> {
  const agent = result.agent!;
  return show({
    kind: 'creating',
    agentId: agent.agentId,
    agent: { name: agent.name, handle: agent.handle },
    avatarUrl: httpsUrl(agent.avatarUrl) ?? from.avatarUrl,
    workspaceName: from.workspaceName,
    answersIn: from.answersIn,
    needs: from.needs,
    adminUrl: httpsUrl(agent.links?.admin),
    startedAt: now,
    ...from.byPress ? { byPress: true as const } : {},
    ...from.promised ? { promised: from.promised } : {},
  }, [call('get_creation_status', { agentId: agent.agentId })]);
}

// Button presses. Only a press ever sends a write, and pressing the same
// button on the same card again sends the same call, so a retry replays.

function press(state: State, action: Action, now: number): Next<View> {
  const { view } = state;
  const busy = (effect: Effect): Next<View> => stay({ view, busy: true }, [effect]);
  switch (action) {
    case 'create':
      return view.kind === 'proposal' ? start(view, view.proposal.create.arguments) : stay(state);
    case 'create_anyway':
      return view.kind === 'similar'
        ? start(view, { ...view.create, createEvenIfSimilar: true, idempotencyKey: `${view.create.idempotencyKey}:anyway` })
        : stay(state);
    case 'change_something': {
      const name = view.kind === 'proposal' ? view.proposal.proposal.name : view.kind === 'similar' ? view.name : undefined;
      // The same words wherever they land: ChatGPT's composer, or a host that puts the message there itself.
      return name ? stay(state, [{ type: 'message', draft: `Change ${name}: `, sent: `Change ${name}: ` }]) : stay(state);
    }
    case 'save':
      return view.kind === 'change' && !view.stale ? busy(call('update_agent', view.preview.save.arguments)) : stay(state);
    case 'cancel':
      return view.kind === 'change'
        ? tell(show({ kind: 'notice', title: 'Not saved', body: 'Nothing changed.' }),
          `The person cancelled this change to ${agentNamed(view.preview.agent.name)} on the card. Nothing was saved.`)
        : stay(state);
    case 'confirm':
      if (view.kind !== 'confirm' || !view.confirmation.confirmToken) return stay(state);
      if (expired(view.confirmation, now)) return show(EXPIRED);
      return busy(call('confirm_change', { confirmToken: view.confirmation.confirmToken }));
    case 'keep':
      // Even past its time on this device's clock: only the server's answer says the token is dead.
      if (view.kind !== 'confirm' || !view.confirmation.confirmToken) return stay(state);
      return busy(call('decline_change', { confirmToken: view.confirmation.confirmToken }));
    case 'undo': {
      const undoToken = view.kind === 'done' ? view.undoToken : view.kind === 'first_answer' && undoBeside(view) ? view.again?.undoToken : undefined;
      return undoToken ? busy(call('undo_change', { undoToken, idempotencyKey: `undo:${undoToken}` })) : stay(state);
    }
    case 'open_slack': {
      const url = slackUrlOf(view);
      return url ? stay(state, [{ type: 'open', url }]) : stay(state);
    }
    case 'open_admin': {
      const url = view.kind === 'ready' || view.kind === 'creating' ? view.adminUrl
        : view.kind === 'confirm' && confirmsInAdmin(view) ? view.adminUrl : undefined;
      return url ? stay(state, [{ type: 'open', url }]) : stay(state);
    }
    case 'next_step': {
      const need = view.kind === 'ready' ? view.needs[0] : undefined;
      return need && view.kind === 'ready'
        ? stay(state, [{ type: 'message', sent: `Connect ${need.name} to ${view.agent.name}.` }])
        : stay(state);
    }
    case 'check_again':
      return reread(state, now);
    case 'try_once':
      if (view.kind === 'ready' && offersFirstAnswer(view)) return tryOnce(tested(view), now);
      if (view.kind === 'done' && view.agent && offersTryAgain(view)) {
        const { agent } = view;
        return tryAgain(
          { agentId: agent.agentId, name: agent.name, handle: agent.handle, avatarUrl: view.avatarUrl, slackUrl: view.slackUrl },
          { summary: view.summary, undoToken: view.undoToken },
          now,
        );
      }
      return stay(state);
    case 'try_fix':
      return stay(state);
  }
}

/** The Saved card's Undo, pressed beside a Try it again answer: its press and its answer are this card's. */
function undoing(event: Event): boolean {
  if (event.type === 'press') return event.action === 'undo';
  return (event.type === 'reply' || event.type === 'unreachable') && event.call.tool === 'undo_change';
}

/**
 * Undo stands beside what Try it again came to, an answer or a run that did
 * not start or finish, while the card holds the save's token.
 */
function undoBeside(view: FirstAnswer): boolean {
  const { stage } = view;
  // An answer whose earlier one is still being read shows as answering: nothing to press yet.
  const came = stage.kind === 'answered' ? stage.reading === undefined : stage.kind === 'stopped' || stage.kind === 'slow';
  return view.again?.undoToken !== undefined && came;
}

/** Undo in place of Change something or a second Open in Slack; after a lone button, or alone. Two at most. */
function withUndo(buttons: ReadonlyArray<Button<Action>>): Array<Button<Action>> {
  const gives = ({ action, tone }: Button<Action>) => action === 'change_something' || (action === 'open_slack' && tone === 'secondary');
  if (buttons.some(gives)) return buttons.map((button) => gives(button) ? UNDO_CHANGE : button);
  return buttons.length < 2 ? [...buttons, UNDO_CHANGE] : [...buttons];
}

/** "Try it again" on a Saved card: an Agent that still answers, after a save that changed how. */
function offersTryAgain(view: Extract<View, { kind: 'done' }>): boolean {
  return view.practice !== undefined && view.agent !== undefined && view.status !== 'off' && view.status !== 'archived';
}

/** Only the card's own Save says what changed: an Agent with a first question, and a change to how it answers. */
function practiceAfter(preview: ChangePreview): boolean {
  return preview.agent.hasFirstAsk === true && preview.changes.some(({ field }) => ANSWER_FIELDS.has(field));
}

/** The ready Agent as the first answer tests it, with the promise only this card's proposal made. */
function tested(view: Extract<View, { kind: 'ready' }>): Tested {
  return {
    agentId: view.agentId,
    name: view.agent.name,
    handle: view.agent.handle,
    avatarUrl: view.avatarUrl,
    slackUrl: httpsUrl(view.status.slackUrl),
    promised: view.promised,
  };
}

/**
 * The answer to the Create this offer still shows, after the host gave up
 * on it: the Agent may exist, so it counts, as Create pressed again would.
 * The one reply taken by its idempotency key instead of its `seq`: the key
 * must be the offer's, the card must not be busy, and a second late answer
 * finds the card creating and is dropped.
 */
function lateCreate(state: State, made: Call): boolean {
  const { view } = state;
  if (state.busy || made.tool !== 'create_agent') return false;
  const key = made.args.idempotencyKey;
  return view.kind === 'proposal' ? key === view.proposal.create.arguments.idempotencyKey
    : view.kind === 'similar' && key === `${view.create.idempotencyKey}:anyway`;
}

/** The steps show at once; create_agent's answer fills them in. */
function start(from: Offer, args: Record<string, unknown>): Next<View> {
  return { state: { view: { kind: 'starting', from }, busy: true }, effects: [call('create_agent', args)] };
}

// Replies to the card's own tool calls.

function reply(state: State, made: Call, result: ToolResult, now: number): Next<View> {
  const { view } = state;
  const failure = errorOf(result);
  const code = errorCode(result);
  const content = result.structuredContent;
  switch (made.tool) {
    case 'create_agent': {
      const offer = view.kind === 'starting' ? view.from : view.kind === 'proposal' || view.kind === 'similar' ? view : undefined;
      if (failure || !isChangeResult(content)) return stay({ view: offer ?? view, busy: false, error: failure ?? GENERIC });
      const from = offer?.kind === 'proposal' ? offer.proposal.proposal : undefined;
      if (content.status === 'done' && content.agent) {
        const { name, handle } = content.agent;
        return tell(creating(content, {
          answersIn: channelNames(from?.answersIn ?? []),
          needs: from?.needs ?? [],
          workspaceName: from?.workspaceName,
          avatarUrl: offerAvatar(offer),
          byPress: true,
          promised: promiseOf(offer),
        }, now), `The person created ${agentNamed(name, handle)} from the card. It is joining Slack now.`);
      }
      if (content.status === 'similar_agent_exists' && offer) {
        const create = offer.kind === 'proposal' ? offer.proposal.create.arguments : offer.create;
        const promised = promiseOf(offer);
        return tell(
          show({ kind: 'similar', summary: content.summary, create, name: create.name, avatarUrl: offerAvatar(offer), ...promised ? { promised } : {} }),
          `The person pressed Create in Slack on the card, but nothing was created. Chickpea said: ${quoted(content.summary)}`,
        );
      }
      return changeView(content, now);
    }
    case 'get_creation_status':
      if (code === 'not_found') return goneFrom(state, 'unavailable');
      return creationStatus(state, failure ? undefined : content as CreationStatus, now);
    case 'update_agent': {
      if (failure || !isChangeResult(content)) {
        return view.kind === 'change' && code === 'changed_since_read'
          ? stay({ view: { ...view, stale: true }, busy: false, error: failure })
          : stay({ view, busy: false, error: failure ?? GENERIC });
      }
      const name = view.kind === 'change' ? view.preview.agent.name : content.agent?.name;
      const agent = name === undefined ? 'the Agent' : agentNamed(name);
      // The summary names the Agent again, whole and unquoted, so it is left out when this sentence names it.
      const practice = view.kind === 'change' && practiceAfter(view.preview);
      return tell(changeView(content, now, { saved: true, practice }), content.status === 'needs_confirmation'
        ? `The person pressed Save on the card for ${agent}. Nothing has changed yet: it waits for their confirmation on the card.`
        : name === undefined
          ? `The person saved the change from the card. Chickpea said: ${quoted(content.summary)}`
          : `The person saved the change to ${agent} from the card.`);
    }
    case 'confirm_change':
      if (code === 'confirmation_expired') return show(EXPIRED);
      if (failure || !isChangeResult(content)) {
        // Only Chickpea's refusal says nothing changed. An error with no code is the host's, and
        // the change may have been made: the buttons stay, and pressing again sends the same token.
        return failure && code !== undefined && code !== 'temporarily_unavailable'
          ? tell(show({ kind: 'notice', title: 'Nothing changed', body: failure }), `The person confirmed on the card, but nothing changed. Chickpea said: ${quoted(failure)}`)
          : stay({ view, busy: false, error: failure ?? GENERIC });
      }
      return tell(changeView(content, now), `The person confirmed on the card. Chickpea said: ${quoted(content.summary)}`);
    case 'decline_change': {
      // Kept only on an answer that proves the token dead: Chickpea retired it, or holds no
      // confirmation of this person's under it. Any other failure may leave it live.
      const retired = failure ? code === 'not_found' : isChangeResult(content);
      if (!retired) return stay({ view, busy: false, error: failure ?? GENERIC });
      const keep = view.kind === 'confirm' ? view.confirmation.ask.keep : 'Keep it';
      if (!failure && isChangeResult(content) && content.status === 'done') {
        return tell(changeView(content, now), `On the card, the person pressed ${quoted(keep)}, but the change was already made. Chickpea said: ${quoted(content.summary)}`);
      }
      return tell(show(KEPT), `On the card, the person pressed ${quoted(keep)}, so nothing changed. Make this change only if they ask for it again.`);
    }
    case 'undo_change': {
      if (failure || !isChangeResult(content)) {
        const gone = code === 'nothing_to_undo' || code === 'changed_since_read';
        return stay({ view: gone ? withoutUndo(view) : view, busy: false, error: failure ?? GENERIC });
      }
      const name = view.kind === 'done' ? view.agent?.name : view.kind === 'first_answer' ? view.tested.name : undefined;
      return tell(changeView(content, now, { undone: true }), content.status === 'needs_confirmation'
        ? 'The person pressed Undo on the card. Nothing has changed yet: it waits for their confirmation on the card.'
        : `The person undid the change${name === undefined ? '' : ` to ${agentNamed(name)}`} from the card.`);
    }
    case 'get_confirmation': {
      if (state.busy || view.kind !== 'confirm') return stay(state);
      const standing = failure ? undefined : (content as { status?: unknown } | undefined)?.status;
      if (standing === 'applied') {
        return show({ kind: 'done', summary: CONFIRMED, ...view.agent ? { agent: view.agent } : {}, avatarUrl: view.avatarUrl });
      }
      if (standing === 'cancelled') return show(RETIRED);
      // Pending, or no answer: the buttons stay, and a press gets Chickpea's answer.
      return standing === 'expired' ? show(EXPIRED) : stay(state);
    }
    case 'get_agent': {
      if (state.busy) return stay(state); // a write is in flight; its reply decides the view
      if (code === 'not_found') return goneFrom(state, 'unavailable');
      const read = failure ? undefined : content as { version?: unknown; status?: unknown; instructions?: unknown } | undefined;
      if (typeof read?.version !== 'string' || view.kind === 'confirm') return stay(state);
      if (read.status === 'archived') return goneFrom(state, 'archived');
      if (view.kind === 'change' && read.version !== view.preview.save.arguments.version) return stay({ ...state, view: { ...view, stale: true } });
      if (view.kind === 'change' && !view.whole && typeof read.instructions === 'string') {
        const whole = wholeChange(view.preview, read.instructions);
        return whole ? stay({ ...state, view: { ...view, whole } }) : stay(state);
      }
      if (view.kind === 'done' && view.undoToken && read.version !== view.version) return stay({ ...state, view: { ...view, undoToken: undefined } });
      return stay(state);
    }
    default:
      return stay({ ...state, busy: false });
  }
}

/**
 * The instructions change from the instructions the save is based on, as
 * the preview read them: every changed word, in the preview's own sentences.
 */
function wholeChange(preview: ChangePreview, saved: string): string[] | undefined {
  const after = preview.save.arguments.instructions;
  if (typeof after !== 'string' || !preview.changes.some(({ field }) => field === 'instructions')) return undefined;
  return textChangeWindows(saved, after).map(({ window, ...change }) => window
    ? describeWholeTextChange(change, window, (text) => `“${text}”`, CHANGE_QUOTE_MAX)
    : describeTextChange(change, (text) => `“${text}”`));
}

function withoutUndo(view: View): View {
  if (view.kind === 'done') return { ...view, undoToken: undefined };
  if (view.kind === 'first_answer' && view.again) return { ...view, again: { ...view.again, undoToken: undefined } };
  return view;
}

/** An Agent the card shows is no longer there to act on. */
function goneFrom(state: State, why: 'unavailable' | 'archived'): Next<View> {
  const { view } = state;
  const agent = view.kind === 'creating' || view.kind === 'ready' || view.kind === 'done' || view.kind === 'confirm' ? view.agent
    : view.kind === 'change' ? view.preview.agent
      : undefined;
  if (!agent) return stay(state);
  const avatarUrl = view.kind === 'change' ? httpsUrl(view.preview.agent.avatarUrl) : 'avatarUrl' in view ? view.avatarUrl : undefined;
  return show({ kind: 'gone', agent: { name: agent.name, handle: agent.handle }, why, avatarUrl });
}

type Creating = Extract<View, { kind: 'creating' }>;

function creationStatus(state: State, status: CreationStatus | undefined, now: number): Next<View> {
  const { view } = state;
  if (view.kind !== 'creating' && view.kind !== 'ready') return stay(state);
  if (!status || typeof status.stage !== 'string') {
    return view.kind === 'creating' ? keepPolling({ ...view, failures: (view.failures ?? 0) + 1 }, now) : stay(state);
  }
  if (status.agent?.status === 'archived') return goneFrom(state, 'archived');
  const avatarUrl = httpsUrl(status.agent?.avatarUrl) ?? view.avatarUrl;
  const settled = status.stage === 'needs_attention' || (status.stage !== 'joining' && status.channels !== 'joining');
  if (!settled) {
    const { failures: _failures, ...polling }: Creating = view.kind === 'creating' ? view : { ...view, kind: 'creating', startedAt: now };
    return keepPolling({ ...polling, avatarUrl, status }, now);
  }
  const ready = show<View>({
    kind: 'ready',
    agentId: view.agentId,
    agent: view.agent,
    avatarUrl,
    answersIn: view.answersIn,
    needs: view.needs,
    adminUrl: view.adminUrl,
    status,
    ...view.promised ? { promised: view.promised } : {},
  });
  if (view.kind !== 'creating' || !view.byPress) return ready;
  const who = agentNamed(view.agent.name, view.agent.handle);
  return tell(ready, status.stage === 'needs_attention'
    ? `The person created ${who} from the card, but it needs attention in Slack. Chickpea said: ${quoted(status.problem ?? 'Slack has not finished setting it up.')}`
    : `The person created ${who} from the card. It is ready in Slack${status.stage === 'said_hello' ? ' and said hello to them there' : ''}.`);
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
    // A card that mounts again mid-create lost its answer: Create again replays the same call.
    case 'starting':
      return show(view.from);
    case 'creating': {
      const { slow: _slow, failures: _failures, ...polling } = view;
      return stay({ ...state, view: { ...polling, startedAt: now } }, [call('get_creation_status', { agentId: view.agentId })]);
    }
    case 'ready':
      return stay(state, [call('get_creation_status', { agentId: view.agentId })]);
    case 'change':
      return stay(state, [call('get_agent', { agentId: view.preview.save.arguments.agentId })]);
    case 'done':
      return view.agent ? stay(state, [call('get_agent', { agentId: view.agent.agentId })]) : stay(state);
    case 'confirm': {
      if (expired(view.confirmation, now)) return show(EXPIRED);
      const { confirmToken } = view.confirmation;
      if (!confirmToken) return stay(state, [expiryTimer(view.confirmation, now)]);
      // Kept, confirmed or retired elsewhere since, as a host that keeps no widget state cannot say;
      // and a confirmation whose Agent is gone has nothing left to confirm.
      return stay(state, [
        expiryTimer(view.confirmation, now),
        call('get_confirmation', { confirmToken }),
        ...view.agent ? [call('get_agent', { agentId: view.agent.agentId })] : [],
      ]);
    }
    default:
      return stay(state);
  }
}

// What a reopened card comes back to. An outcome is kept in ChatGPT's
// `privateContent`, which ChatGPT hides from its model beside the
// `modelContent` the card always writes: words the card showed, and the ID
// of an Agent it created, so a reopened creation reads its arrival again.
// Never a token or instructions, so a reopened change offers no Undo. A
// Saved card that offers Try it again keeps that, never an answer: Chickpea
// finds the answer from before the change itself. A practice run still
// going when the card stopped waiting keeps its token there, so a reopened
// card reads that run once (first-answer.ts `stillAnswering`).

type Outcome =
  | { kind: 'created'; name: string; agentId?: string }
  | { kind: 'done'; summary: string; practice?: true }
  | { kind: 'notice'; title: string; body?: string }
  | StillAnswering;

function remember(view: View): Outcome | undefined {
  switch (view.kind) {
    case 'creating':
    case 'ready':
      return { kind: 'created', name: view.agent.name, agentId: view.agentId };
    case 'done':
      // Only a Saved card that offers it: one whose save also turned the Agent off comes back without it.
      return { kind: 'done', summary: view.summary, ...view.practice && offersTryAgain(view) ? { practice: true as const } : {} };
    case 'first_answer': {
      // Once the run settles, the card comes back to where its press began: the Saved card, or the Agent it created.
      const still = stillAnswering(view);
      if (still) return still;
      return view.again
        ? { kind: 'done', summary: view.again.summary, practice: true }
        : { kind: 'created', name: view.tested.name, agentId: view.tested.agentId };
    }
    case 'notice':
      return { kind: 'notice', title: view.title, ...view.body ? { body: view.body } : {} };
    default:
      return undefined;
  }
}

/** Try it again, as a reopened card offers it again. */
function practiceFrom(outcome: Extract<Outcome, { kind: 'done' }>): { practice?: true } {
  return outcome.practice ? { practice: true } : {};
}

function resume(view: View, kept: unknown): View | undefined {
  const outcome = outcomeOf(kept);
  switch (outcome?.kind) {
    case 'checking':
      // The proposal it mounts with is the one the Agent was created from: its promise goes beside the answer again.
      return view.kind === 'proposal' || view.kind === 'similar'
        ? checkingView(outcome, { avatarUrl: offerAvatar(view), promised: promiseOf(view) })
        : checkingView(outcome, { avatarUrl: 'avatarUrl' in view ? view.avatarUrl : undefined });
    case 'created':
      if (view.kind !== 'proposal') return undefined;
      return outcome.agentId ? createdFrom(view, { name: outcome.name, agentId: outcome.agentId })
        : { kind: 'done', summary: `Created ${outcome.name}.`, avatarUrl: offerAvatar(view) };
    case 'notice':
      return view.kind === 'change' || view.kind === 'confirm' ? { kind: 'notice', title: outcome.title, body: outcome.body } : undefined;
    case 'done':
      if (view.kind === 'done') {
        const { undoToken: _undo, version: _version, saved: _saved, status: _status, practice: _practice, ...rest } = view;
        return { ...rest, summary: outcome.summary, ...practiceFrom(outcome) };
      }
      if (view.kind === 'change') {
        const { agent, save } = view.preview;
        return {
          kind: 'done',
          summary: outcome.summary,
          agent: { agentId: save.arguments.agentId, name: agent.name, handle: agent.handle },
          avatarUrl: httpsUrl(agent.avatarUrl),
          ...practiceFrom(outcome),
        };
      }
      return view.kind === 'confirm'
        ? { kind: 'done', summary: outcome.summary, ...view.agent ? { agent: view.agent } : {}, avatarUrl: view.avatarUrl }
        : undefined;
    default:
      return undefined;
  }
}

/** The Agent a reopened proposal created: its re-read finds where its arrival in Slack stands now. */
function createdFrom(view: Extract<View, { kind: 'proposal' }>, created: { name: string; agentId: string }): View {
  const { proposal, create } = view.proposal;
  const promised = promiseOf(view);
  return {
    kind: 'creating',
    agentId: created.agentId,
    agent: { name: created.name, handle: create.arguments.handle ?? proposal.handle },
    avatarUrl: offerAvatar(view),
    workspaceName: proposal.workspaceName,
    answersIn: channelNames(proposal.answersIn),
    needs: proposal.needs,
    startedAt: 0,
    ...promised ? { promised } : {},
  };
}

/** An outcome as the host kept it: untrusted, so only its shape is checked. */
function outcomeOf(kept: unknown): Outcome | undefined {
  if (!isRecord(kept)) return undefined;
  if (kept.kind === 'created' && typeof kept.name === 'string') {
    return { kind: 'created', name: kept.name, ...typeof kept.agentId === 'string' && isAgentId(kept.agentId) ? { agentId: kept.agentId } : {} };
  }
  if (kept.kind === 'done' && typeof kept.summary === 'string') {
    return { kind: 'done', summary: kept.summary, ...kept.practice === true ? { practice: true as const } : {} };
  }
  if (kept.kind === 'checking') return stillAnsweringOf(kept);
  if (kept.kind === 'notice' && typeof kept.title === 'string') {
    return { kind: 'notice', title: kept.title, ...typeof kept.body === 'string' ? { body: kept.body } : {} };
  }
  return undefined;
}

const EXPIRED: View = {
  kind: 'notice',
  title: 'This confirmation expired',
  body: 'Nothing changed. Ask again for a fresh one.',
};

const KEPT: View = { kind: 'notice', title: 'Kept as it is', body: 'Nothing changed.' };

/** Kept, replaced by a newer change, or failed when confirmed: nothing stored says which. */
const RETIRED: View = {
  kind: 'notice',
  title: 'This confirmation no longer applies',
  body: 'Nothing changed. Ask again to make the change.',
};

/** The server's summary for a confirmed change, when the card has no other. */
const CONFIRMED = 'Made the change you confirmed.';

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

function offerAvatar(offer: Offer | undefined): string | undefined {
  if (offer?.kind === 'proposal') return httpsUrl(offer.proposal.proposal.avatarUrl);
  return offer?.avatarUrl;
}

/** What the proposal on this card promised it would answer. */
function promiseOf(offer: Offer | undefined): Promised | undefined {
  return offer?.kind === 'proposal' ? exampleOf(offer.proposal.proposal) : offer?.promised;
}

/**
 * The proposal's question and promised answer, when it has both. A result is
 * untrusted, so one without them shows the job instead.
 */
function exampleOf({ sampleExchange }: Proposal['proposal']): Promised | undefined {
  const { ask, answer }: Partial<Record<'ask' | 'answer', unknown>> = isRecord(sampleExchange) ? sampleExchange : {};
  return typeof ask === 'string' && ask.trim() && typeof answer === 'string' && answer.trim() ? { ask, answer } : undefined;
}

/** Admin can make this change, and the card has the Agent's page there to open. */
function confirmsInAdmin(view: Extract<View, { kind: 'confirm' }>): boolean {
  return view.confirmation.inAdmin === true && view.adminUrl !== undefined;
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
        avatarUrl: view.avatarUrl,
        title: 'An Agent like this already exists',
        blocks: [{ kind: 'text', text: view.summary }],
        buttons: [
          { label: 'Create it anyway', action: 'create_anyway', tone: 'primary' },
          { label: 'Change something', action: 'change_something', tone: 'secondary' },
        ],
      };
    case 'starting':
      return { ...base, ...presentStarting(view.from) };
    case 'creating':
      return { ...base, ...presentCreating(view) };
    case 'ready':
      return { ...base, ...presentReady(view) };
    case 'change':
      return { ...base, ...presentChange(view, state.busy) };
    case 'done':
      return { ...base, ...presentDone(view) };
    case 'confirm':
      return { ...base, ...presentConfirm(view) };
    case 'gone':
      return {
        ...base,
        avatar: 'agent',
        avatarUrl: view.avatarUrl,
        title: view.why === 'archived' ? `${view.agent.name} is archived` : `${view.agent.name} is no longer available`,
        blocks: [{
          kind: 'text',
          text: view.why === 'archived' ? 'It no longer answers in Slack.' : 'It was deleted, or you can no longer manage it.',
        }],
        buttons: [],
      };
    case 'notice':
      return {
        ...base,
        avatar: 'none',
        title: view.title,
        blocks: view.body ? [{ kind: 'text', text: view.body }] : [],
        buttons: [],
      };
    case 'first_answer': {
      const shown = presentFirstAnswer(view);
      return { ...base, ...shown, buttons: undoBeside(view) ? withUndo(shown.buttons) : shown.buttons };
    }
  }
}

const UNDO: Button<Action> = { label: 'Undo', action: 'undo', tone: 'secondary' };
/** The save's Undo beside a practice answer or refusal, which it does not undo. */
const UNDO_CHANGE: Button<Action> = { label: 'Undo the change', action: 'undo', tone: 'secondary' };

/**
 * "Are you sure?" with its two buttons; a card without the token says where
 * else the change can be made, and never offers a button that cannot work.
 */
function presentConfirm(view: Extract<View, { kind: 'confirm' }>): Omit<Presentation<Action>, 'busy' | 'error'> {
  const { ask, confirmToken, inAdmin } = view.confirmation;
  const head = {
    avatar: view.agent ? 'alert' as const : 'none' as const,
    avatarUrl: view.avatarUrl,
    title: ask.question,
  };
  if (confirmToken) {
    return {
      ...head,
      blocks: [{ kind: 'text', text: ask.consequence }],
      buttons: [
        { label: ask.confirm, action: 'confirm', tone: 'danger' },
        { label: ask.keep, action: 'keep', tone: 'secondary' },
      ],
    };
  }
  return {
    ...head,
    blocks: [
      { kind: 'text', text: ask.consequence },
      { kind: 'note', text: inAdmin ? 'Confirm this in Admin.' : 'Ask again in a new chat to confirm it.' },
    ],
    buttons: confirmsInAdmin(view) ? [{ label: 'Open in Admin', action: 'open_admin', tone: 'secondary' }] : [],
  };
}

/**
 * Who it is, shown by example: a question and the answer it promises, or its
 * job when the proposal has no example. Its handle shows a problem only when
 * there is one.
 */
function presentProposal({ proposal, issues }: Proposal): Omit<Presentation<Action>, 'busy' | 'error'> {
  const example = exampleOf(proposal);
  const where = joinNames(['your DMs', ...channelNames(proposal.answersIn)]);
  return {
    avatar: 'agent',
    avatarUrl: httpsUrl(proposal.avatarUrl),
    title: proposal.name,
    subtitle: [
      { text: `@${proposal.handle}` },
      ...proposal.handleAvailable === false ? [{ text: ' · ' }, { text: 'handle is taken', tone: 'warn' as const }] : [],
    ],
    blocks: [
      example
        ? { kind: 'exchange', ask: example.ask.trim(), answer: example.answer.trim(), agent: proposal.name }
        : { kind: 'text', text: proposal.job },
      {
        kind: 'line',
        parts: [
          { text: 'Answers in ' },
          { text: where, strong: true },
          { text: `. Anyone in ${proposal.workspaceName?.trim() || 'your Slack workspace'} can message it.` },
        ],
      },
      ...proposal.needs.length
        ? [{
            kind: 'line' as const,
            parts: [
              { text: 'Needs ' },
              ...proposal.needs.flatMap(({ name }) => [{ chip: name }, { text: ' ' }]),
              { text: '· you sign in after it\'s created' },
            ],
          }]
        : [],
      ...issues.map((text): Block<Action> => ({ kind: 'note', text, tone: 'warn' })),
    ],
    buttons: [
      { label: 'Create in Slack', action: 'create', tone: 'primary' },
      { label: 'Change something', action: 'change_something', tone: 'secondary' },
    ],
  };
}

/** The moment Create is pressed: the same steps, with Chickpea's own first. */
function presentStarting(from: Offer): Omit<Presentation<Action>, 'busy' | 'error'> {
  const proposal = from.kind === 'proposal' ? from.proposal.proposal : undefined;
  const handle = proposal?.handle ?? (from.kind === 'similar' ? from.create.handle : undefined);
  const channels = channelNames(proposal?.answersIn ?? []);
  return {
    avatar: 'agent',
    avatarUrl: offerAvatar(from),
    title: proposal?.name ?? (from.kind === 'similar' ? from.name : ''),
    subtitle: [{ text: proposal?.workspaceName ? `Setting up in ${proposal.workspaceName}'s Slack…` : 'Setting up in Slack…' }],
    blocks: [{
      kind: 'steps',
      steps: [
        { label: 'Creating it in Chickpea', state: 'now' },
        { label: handle ? `Joining Slack as @${handle}` : 'Joining Slack', state: 'todo' },
        { label: 'Saying hello to you', state: 'todo' },
        ...channels.length ? [{ label: `Joining ${channels.join(', ')}`, state: 'todo' as const }] : [],
      ],
    }],
    buttons: [],
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
    avatarUrl: view.avatarUrl,
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
      avatarUrl: view.avatarUrl,
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
    avatarUrl: view.avatarUrl,
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
 * nothing is missing, "See its first answer", for an Agent with a first
 * question saved to ask it.
 */
function readyNextStep(view: Extract<View, { kind: 'ready' }>): Array<Button<Action>> {
  const need = view.needs[0];
  if (need) return [{ label: `Connect ${need.name}`, action: 'next_step', tone: 'secondary' }];
  return offersFirstAnswer(view) ? [{ label: 'See its first answer', action: 'try_once', tone: 'secondary' }] : [];
}

function offersFirstAnswer(view: Extract<View, { kind: 'ready' }>): boolean {
  return view.needs.length === 0 && view.status.stage !== 'needs_attention' && view.status.agent?.hasFirstAsk === true;
}

/**
 * A finished change. An Agent that is off says it stays quiet; a save on one
 * that answers says where to try it.
 */
function presentDone(view: Extract<View, { kind: 'done' }>): Omit<Presentation<Action>, 'busy' | 'error'> {
  const line = view.status === 'off' ? 'It won\'t answer in Slack until it\'s turned back on.'
    : view.saved && view.agent?.handle && view.status !== 'archived' ? tryIt(view.agent.handle, view.channels ?? [])
      : undefined;
  return {
    avatar: 'agent',
    avatarUrl: view.avatarUrl,
    title: view.summary.replace(/\.$/, ''),
    done: true,
    ...line ? { subtitle: [{ text: line }] } : {},
    blocks: [],
    // At most two: Try it again first, then Undo, then Slack.
    buttons: [
      ...offersTryAgain(view) ? [{ label: 'Try it again', action: 'try_once' as const, tone: 'primary' as const }] : [],
      ...view.undoToken ? [UNDO] : [],
      ...view.slackUrl ? [{ label: 'Open in Slack', action: 'open_slack' as const, tone: 'secondary' as const }] : [],
    ].slice(0, 2),
  };
}

/** The most characters an instructions change shows with the words around it; a changed span up to `CHANGED_SPAN_MAX` shows whole past it. */
const CHANGE_QUOTE_MAX = 240;

/**
 * The change, with Save and Cancel. Once Save is pressed it says it is
 * saving, as Create and See its first answer show their steps, until
 * update_agent answers.
 */
function presentChange(view: Extract<View, { kind: 'change' }>, saving: boolean): Omit<Presentation<Action>, 'busy' | 'error'> {
  const { preview, stale } = view;
  const count = preview.changes.length;
  return {
    avatar: 'agent',
    avatarUrl: httpsUrl(preview.agent.avatarUrl),
    title: `Change ${preview.agent.name}`,
    // The heading stays, so the live region says the step.
    ...saving ? { announce: `Change ${preview.agent.name}. Saving…` } : { subtitle: [{ text: `${count} ${count === 1 ? 'change' : 'changes'} · nothing is saved until you press Save` }] },
    blocks: [
      ...preview.changes.flatMap((change): Array<Block<Action>> => [{ kind: 'section', label: FIELD_LABELS[change.field] }, ...changeBlocks(change, view.whole)]),
      ...stale ? [{ kind: 'note' as const, text: 'It changed since this preview. Ask again for a fresh one.', tone: 'warn' as const }] : [],
      ...saving ? [{ kind: 'steps' as const, steps: [{ label: 'Saving…', state: 'now' as const }] }] : [],
    ],
    buttons: saving ? [] : [
      ...stale ? [] : [{ label: 'Save', action: 'save' as const, tone: 'primary' as const }],
      { label: 'Cancel', action: 'cancel', tone: 'secondary' },
    ],
  };
}

function changeBlocks(change: ChangePreview['changes'][number], whole: string[] | undefined): Array<Block<Action>> {
  if (change.field === 'instructions') {
    const quotes = whole ?? change.quotes.map((quote) => describeTextChange(quote, (text) => `“${text}”`));
    return quotes.length
      ? quotes.map((text) => ({ kind: 'quote', text }))
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
