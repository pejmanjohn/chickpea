import type { CustomAgentConfig, ResolvedAssignment } from '../config/types.ts';
import { SLACK_CODE_SEGMENT } from './message-format.ts';
import type { NormalizedSlackTurn } from './types.ts';

/**
 * Agent-to-Agent asks: an Agent that mentions a teammate's handle in a reply
 * it delivered in a thread asks that Agent, which answers in the same
 * thread. The ask never arrives as a Slack event (every Agent posts
 * as this app's one bot user, and admission ignores app-authored events);
 * the host admits it from the delivered reply instead.
 */

/**
 * Asks one person's message can lead to, however they chain. Past it the
 * exchange pauses until a person posts in the thread again.
 */
export const AGENT_ASK_TURN_LIMIT = 8;
/** Agents one message can ask; later mentions in it are not asked. */
export const AGENT_ASK_MAX_TARGETS = 6;
/**
 * The whole reply of the thread's own Agent, handed its teammates' answers,
 * when those answers already complete the request: nothing is posted.
 */
export const AGENT_ASK_SILENT_REPLY = 'NO_REPLY';
/** Whether a reply is the silent reply, allowing stray markup around it. */
export function isAgentAskSilentReply(text: string): boolean {
  return text.trim().replace(/^[`*"']+|[`*"'.!]+$/g, '') === AGENT_ASK_SILENT_REPLY;
}
/** Posted as the asking Agent when an exchange of asks reaches its limit. */
export const AGENT_ASK_PAUSE_TEXT =
  "I'll pause here so this exchange doesn't keep going without you. Reply in this thread to continue.";

/** What the host admits asks from: one delivered Agent reply's messages. */
export interface SlackAgentAskRequest {
  /** The asking turn: its thread, its person, and its own ask, if any. */
  turn: Pick<
    NormalizedSlackTurn,
    'workspaceId' | 'channelId' | 'threadTs' | 'messageTs' | 'userId' | 'channelType' |
    'requesterTimezone' | 'agentAsk' | 'text'
  >;
  fromAgentId: string;
  /** The replying Agent is the thread's own, not a guest. */
  fromThreadOwner?: true;
  /** Every Slack message of the reply that mentioned a handle-shaped word. */
  deliveries: Array<{ messageTs: string; text: string }>;
  /**
   * The first message of a guest's answer in a chain the thread's own Agent
   * started: when the reply asks nobody, the host hands it back to that Agent.
   */
  answer?: { messageTs: string; text: string };
}

export type SlackAgentAskDispatcher = (request: SlackAgentAskRequest) => Promise<void>;

/** The person's message an exchange of asks started from. */
export function agentAskOrigin(turn: Pick<NormalizedSlackTurn, 'messageTs' | 'agentAsk'>): string {
  return turn.agentAsk?.originMessageTs ?? turn.messageTs;
}

/**
 * Whether this turn is the thread's own Agent handed a teammate's answer: it
 * finishes the person's request, or stays silent when the answer already did.
 */
export function isHandedBackTurn(
  turn: Pick<NormalizedSlackTurn, 'agentAsk'>,
  assignment: Pick<ResolvedAssignment, 'threadGuest'>,
): boolean {
  return turn.agentAsk?.handedBack === true && assignment.threadGuest !== true;
}

/**
 * Whether this turn answers a person's message after the Agents it mentioned
 * before this one: their replies are its context, and its words are a
 * message to read, never a command it may run.
 */
export function isLaterCoAddressedTurn(turn: Pick<NormalizedSlackTurn, 'coAddressed'>): boolean {
  return (turn.coAddressed?.position ?? 0) > 0;
}

/**
 * The handle an Agent is asked by, with the user group Slack renders it
 * with: only an Agent whose handle is published has one.
 */
export function agentSlackHandle(
  agent: Pick<CustomAgentConfig, 'slackPresence'>,
): { handle: string; userGroupId: string } | undefined {
  const userGroupId = agent.slackPresence?.userGroupId;
  return userGroupId ? { handle: agent.slackPresence!.normalizedHandle, userGroupId } : undefined;
}

/**
 * Whether this Agent's replies may ask other Agents. Only user Agents ask:
 * the built-in Chickpea lists and describes Agents, so a handle in its reply
 * names that Agent and never asks it.
 */
export function agentMayAskTeammates(agent: Pick<CustomAgentConfig, 'kind'>): boolean {
  return agent.kind === 'user';
}

/**
 * Whether this turn's replies may ask other Agents: a user Agent's
 * chickpea-v1 turn with teammates here. A legacy installation has no handles.
 */
function turnMayAskAgents(
  assignment: Pick<ResolvedAssignment, 'runtimeContract' | 'agent' | 'teammates'>,
): boolean {
  return assignment.runtimeContract === 'chickpea-v1' && agentMayAskTeammates(assignment.agent) &&
    (assignment.teammates?.length ?? 0) > 0;
}

// Unlike SLACK_HANDLE_WORD, a `|` before the `@` matches: a live mention's label asks.
const HANDLE_WORD = /(?<![\p{L}\p{N}_.@/:-])@([A-Za-z0-9_-]+)/gu;

/**
 * The handle-shaped words of a delivered message outside code, lowercased,
 * in order of first appearance. Which of them are Agents is decided by the
 * host against the Agents it knows.
 */
export function mentionedHandleWords(text: string): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  text.split(SLACK_CODE_SEGMENT).forEach((segment, index) => {
    if (index % 2 === 1) return;
    for (const match of segment.matchAll(HANDLE_WORD)) {
      const word = match[1]!.toLowerCase().replace(/-+$/, '');
      if (word && !seen.has(word)) {
        seen.add(word);
        words.push(word);
      }
    }
  });
  return words;
}

/**
 * Collects a turn's delivered messages that may ask other Agents, and hands
 * them over once the turn's reply is recorded as delivered. Recording the
 * thread context stays the delivery callback's job; asks never delay or fail
 * the reply that made them.
 */
export function createAgentAskCollector(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  dispatch?: SlackAgentAskDispatcher | undefined;
}): {
  /** Note one delivered message. */
  note(delivery: { messageTs: string; text: string }): void;
  /**
   * Hand the noted messages over, once; failures are logged, never thrown.
   * A failed run hands no answer back: its notice is not one.
   */
  flush(outcome?: 'succeeded' | 'no_op' | 'failed' | 'stopped'): Promise<void>;
} {
  const deliveries: Array<{ messageTs: string; text: string }> = [];
  const eligible = Boolean(input.dispatch) && turnMayAskAgents(input.assignment);
  // A guest in a chain the thread's own Agent started: its answer goes back.
  const answersOwner = eligible && input.assignment.threadGuest === true &&
    Boolean(input.turn.agentAsk?.threadOwnerAgentId);
  let answer: { messageTs: string; text: string } | undefined;
  let flushed = false;
  return {
    note(delivery) {
      if (!eligible || flushed) return;
      if (answersOwner) answer ??= { messageTs: delivery.messageTs, text: delivery.text };
      if (mentionedHandleWords(delivery.text).length === 0) return;
      if (deliveries.some(({ messageTs }) => messageTs === delivery.messageTs)) return;
      deliveries.push({ messageTs: delivery.messageTs, text: delivery.text });
    },
    async flush(outcome) {
      if (outcome === 'failed') answer = undefined;
      if (flushed || (deliveries.length === 0 && !answer) || !input.dispatch) return;
      flushed = true;
      const { turn } = input;
      try {
        await input.dispatch({
          turn: {
            workspaceId: turn.workspaceId,
            channelId: turn.channelId,
            threadTs: turn.threadTs,
            messageTs: turn.messageTs,
            userId: turn.userId,
            text: turn.text,
            ...(turn.channelType ? { channelType: turn.channelType } : {}),
            ...(turn.requesterTimezone ? { requesterTimezone: turn.requesterTimezone } : {}),
            ...(turn.agentAsk ? { agentAsk: turn.agentAsk } : {}),
          },
          fromAgentId: input.assignment.agentId,
          ...(input.assignment.threadGuest === true ? {} : { fromThreadOwner: true as const }),
          deliveries,
          ...(answer ? { answer } : {}),
        });
      } catch (error) {
        console.warn('[chickpea] agent ask dispatch failed:', error instanceof Error ? error.name : 'unknown');
      }
    },
  };
}

export function personRequestText(turn: Pick<NormalizedSlackTurn, 'text' | 'agentAsk'>): string | undefined {
  return turn.agentAsk ? undefined : turn.text;
}

// Links and mentions are dropped first, so a URL or a handle that contains
// one of these words asks nothing.
const REMEMBER_REQUEST =
  /\b(?:remember|memori[sz]e|memory|forget|keep (?:(?:it|this|that) )?in mind|(?:make|take) a note|note (?:it|this|that) down)\b/i;

/** Whether a person's message asks to remember or forget something. */
export function personAsksToRemember(text: string | undefined): boolean {
  return text !== undefined && REMEMBER_REQUEST.test(text.replace(/<[^>]*>/g, ' '));
}

/**
 * Whether the person's message that started this exchange asked to remember
 * or forget something, read from the person's own words and carried along
 * the exchange's asks, never from an Agent's.
 */
export function exchangePersonAskedToRemember(
  turn: Pick<NormalizedSlackTurn, 'text' | 'agentAsk'>,
): boolean {
  return turn.agentAsk
    ? turn.agentAsk.personAskedToRemember === true
    : personAsksToRemember(personRequestText(turn));
}

/**
 * The one ask turn that may write memory without the person's approval: the
 * thread's own Agent, handed its teammates' answers, in an exchange the
 * person started by asking it to remember or forget something.
 */
export function handBackMayRemember(
  turn: Pick<NormalizedSlackTurn, 'agentAsk'>,
  assignment: Pick<ResolvedAssignment, 'threadGuest'>,
): boolean {
  return isHandedBackTurn(turn, assignment) && turn.agentAsk?.personAskedToRemember === true;
}
