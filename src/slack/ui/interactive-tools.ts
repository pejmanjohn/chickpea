import * as v from 'valibot';

import type { SlackStateStore } from '../claim-store.ts';
import {
  AskUserSchema,
  OfferActionsSchema,
  SLACK_ASK_USER_TOOL_NAME,
  SLACK_OFFER_ACTIONS_TOOL_NAME,
  SLACK_PRESENTATION_TOOL_DEFINITIONS,
  SlackPresentationInputError,
  validateAskUser,
  validateOfferActions,
  type AskUserInput,
  type OfferActionsInput,
} from './presentation-tools.ts';
import {
  UI_SURFACE_TTL_MS,
  uiSurfaceId,
  type ActionsSurfaceSpec,
  type QuestionSurfaceSpec,
} from './surface.ts';

/** Fixed turn coordinates the host bound to this request; never model input. */
export interface InteractiveSurfaceScope {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  conversationKind: 'channel' | 'im';
  agentId: string;
  turnJobId: string;
  requesterUserId: string;
}

const SLACK_TS = /^\d{1,16}\.\d{1,16}$/;

/**
 * Where ask_user and offer_actions may mount: the trusted Slack signal's
 * coordinates, or undefined wherever a click could never be admitted like a
 * reply. Group DMs admit no plain thread replies, and a legacy DM session
 * signals its channel-wide key ('dm') rather than the Slack thread a card
 * would be posted in, so a card there could never be delivered or clicked.
 */
export function interactiveSurfaceScope(
  signal: {
    workspaceId: string;
    channelId: string;
    threadTs: string;
    conversationKind?: 'channel' | 'im' | 'mpim';
    slackUserId: string;
    turnJobId: string;
  },
  agentId: string,
): InteractiveSurfaceScope | undefined {
  const conversationKind = signal.conversationKind;
  if (conversationKind !== 'channel' && conversationKind !== 'im') return undefined;
  if (!SLACK_TS.test(signal.threadTs)) return undefined;
  return {
    workspaceId: signal.workspaceId,
    channelId: signal.channelId,
    threadTs: signal.threadTs,
    conversationKind,
    agentId,
    turnJobId: signal.turnJobId,
    requesterUserId: signal.slackUserId,
  };
}

/**
 * Data part naming the question an ask_user posted, so a reply that is only
 * the question (no lead-in prose) still has host text to deliver.
 */
export const SLACK_INTERACTIVE_QUESTION_DATA_NAME = 'slackInteractiveQuestion';
export const SlackInteractiveQuestionSchema = v.strictObject({
  question: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});
export type SlackInteractiveQuestion = v.InferOutput<typeof SlackInteractiveQuestionSchema>;

/** The one interactive surface a reply may carry; its slot keeps retries idempotent. */
export const INTERACTIVE_SURFACE_SLOT = 'interactive';

export const SLACK_ASK_USER_ACKNOWLEDGEMENT =
  'Question posted as buttons under your reply. End your reply now: at most one short lead-in sentence, and do not list the options. The answer arrives as the next message.';
export const SLACK_OFFER_ACTIONS_ACKNOWLEDGEMENT =
  'Buttons recorded under your reply. Do not list them again in prose.';

type SurfaceStore = Pick<SlackStateStore, 'executeUiSurface'>;

/**
 * Persist the validated component as the turn's pending surface before the
 * tool answers, so delivery (or a retried delivery) always finds it. A later
 * attempt of the same turn replaces a surface that was never posted.
 */
async function recordSurface(
  store: SurfaceStore,
  scope: InteractiveSurfaceScope,
  spec: QuestionSurfaceSpec | ActionsSurfaceSpec,
  now = Date.now(),
): Promise<void> {
  if (!store.executeUiSurface) {
    throw new SlackPresentationInputError('Buttons are unavailable here; ask in prose instead.');
  }
  const response = await store.executeUiSurface({
    kind: 'put_surface',
    record: {
      id: uiSurfaceId(scope.turnJobId, INTERACTIVE_SURFACE_SLOT),
      namespace: 'ui',
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      threadTs: scope.threadTs,
      conversationThreadTs: scope.threadTs,
      conversationKind: scope.conversationKind,
      agentId: scope.agentId,
      turnJobId: scope.turnJobId,
      requesterUserId: scope.requesterUserId,
      spec,
      status: 'pending_delivery',
      createdAt: now,
      updatedAt: now,
      expiresAt: now + UI_SURFACE_TTL_MS,
    },
  });
  const stored = response.kind === 'surface' ? response.surface : null;
  if (!stored || stored.status !== 'pending_delivery' || stored.messageTs) {
    throw new SlackPresentationInputError('This reply already posted its buttons; answer in prose.');
  }
}

function describe(name: string): string {
  return SLACK_PRESENTATION_TOOL_DEFINITIONS.find((tool) => tool.name === name)!.description;
}

function teaching<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof SlackPresentationInputError) throw new Error(error.message);
    throw error;
  });
}

export function createAskUserTool(input: {
  store: () => Promise<SurfaceStore>;
  scope: InteractiveSurfaceScope;
  /** Lets an empty final reply fall back to the question itself. */
  onRecorded?: (question: string) => void;
}) {
  return {
    name: SLACK_ASK_USER_TOOL_NAME,
    description: describe(SLACK_ASK_USER_TOOL_NAME),
    input: AskUserSchema,
    output: v.string(),
    run: ({ data }: { data: AskUserInput }) => teaching(async () => {
      const question = validateAskUser(data);
      await recordSurface(await input.store(), input.scope, { kind: 'question', question });
      input.onRecorded?.(question.question);
      return { output: SLACK_ASK_USER_ACKNOWLEDGEMENT };
    }),
  };
}

export function createOfferActionsTool(input: {
  store: () => Promise<SurfaceStore>;
  scope: InteractiveSurfaceScope;
}) {
  return {
    name: SLACK_OFFER_ACTIONS_TOOL_NAME,
    description: describe(SLACK_OFFER_ACTIONS_TOOL_NAME),
    input: OfferActionsSchema,
    output: v.string(),
    run: ({ data }: { data: OfferActionsInput }) => teaching(async () => {
      const actions = validateOfferActions(data);
      await recordSurface(await input.store(), input.scope, { kind: 'actions', actions });
      return { output: SLACK_OFFER_ACTIONS_ACKNOWLEDGEMENT };
    }),
  };
}
