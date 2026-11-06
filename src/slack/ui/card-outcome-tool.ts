import * as v from 'valibot';

import type { SlackStateStore } from '../claim-store.ts';
import { findCard } from './card-set.ts';
import { SlackPresentationInputError, validateCardOutcomeText } from './presentation-tools.ts';
import type { CardSetScope, UiSurfaceRpcResponse } from './surface-store.ts';
import { CARD_OUTCOME_TONES, type UiSurfaceRecord } from './surface.ts';

/**
 * update_card: the one edit an Agent may make to a message it posted. It
 * sets an outcome on one card of a card set it presented in this
 * conversation; the host stores it and redraws the set. It cannot change the
 * answer, another component, or anyone else's cards.
 */
export const SLACK_UPDATE_CARD_TOOL_NAME = 'update_card';

export const UpdateCardSchema = v.strictObject({
  cards: v.pipe(v.string(), v.maxLength(40, 'cards must be 40 characters or fewer.')),
  card: v.pipe(v.string(), v.maxLength(150, 'card must be 150 characters or fewer.')),
  tone: v.picklist(CARD_OUTCOME_TONES),
  text: v.pipe(v.string(), v.maxLength(150, 'text must be 150 characters or fewer.')),
});
export type UpdateCardInput = v.InferOutput<typeof UpdateCardSchema>;

const DESCRIPTION =
  'Show the outcome on one card you posted with present_cards in this conversation, such as "Done, $30/day verified" or "Failed: the budget changed since". Use it after you act on a card button someone pressed, or on a typed request that one of your cards covers ("approve 2"). Name the set by its ref ("cards 1a2b3c4d", from the button press message or the present_cards result) and the card by its exact title or its number from 1. tone is done, failed or info. The card loses its request buttons and shows the outcome; nothing else in the message changes.';

const REF = /^\(?\s*(?:cards\s+)?([a-f0-9]{8})\s*\)?$/i;

type SurfaceStore = Pick<SlackStateStore, 'executeUiSurface'>;

function fail(message: string): never {
  throw new SlackPresentationInputError(message);
}

function surfaceOf(response: UiSurfaceRpcResponse): UiSurfaceRecord | undefined {
  return response.kind === 'surface' ? response.surface ?? undefined : undefined;
}

export function createUpdateCardTool(input: {
  store: () => Promise<SurfaceStore>;
  /** The conversation this turn answers in, bound by the host; never model input. */
  scope: CardSetScope;
  /** Redraw the set in its answer message; whether Slack shows the outcome now. */
  redraw: (surface: UiSurfaceRecord) => Promise<boolean>;
  now?: () => number;
}) {
  const scope: CardSetScope = {
    workspaceId: input.scope.workspaceId,
    channelId: input.scope.channelId,
    threadTs: input.scope.threadTs,
    agentId: input.scope.agentId,
  };
  const run = async (data: UpdateCardInput) => {
    const ref = REF.exec(data.cards.trim())?.[1]?.toLowerCase() ??
      fail('cards must name a card set like "cards 1a2b3c4d", from the button press message or the present_cards result.');
    const text = validateCardOutcomeText(data.text);
    const store = await input.store();
    if (!store.executeUiSurface) fail('Cards are unavailable here; say the outcome in your reply.');
    const found = surfaceOf(await store.executeUiSurface({ kind: 'find_card_set', scope, ref }));
    if (!found) {
      fail(`No card set "cards ${ref}" that you posted in this conversation. Use the ref from the button press message or the present_cards result.`);
    }
    const spec = found.spec;
    if (spec.kind !== 'cards') fail(`cards ${ref} is not a card set.`);
    const now = input.now?.() ?? Date.now();
    if (found.status === 'expired' || found.expiresAt <= now) fail(`cards ${ref} has expired; say the outcome in your reply instead.`);
    if (found.status === 'pending_delivery') {
      fail(`cards ${ref} is not posted yet. Set an outcome once the reply with these cards is delivered.`);
    }
    if (found.status !== 'open' && found.status !== 'resolved') fail(`cards ${ref} has closed; say the outcome in your reply instead.`);
    const card = findCard(spec.cards, data.card);
    if (card === undefined) {
      fail(`No card "${data.card}" in cards ${ref}. Name it by its exact title or its number, 1 to ${spec.cards.cards.length}.`);
    }
    const updated = surfaceOf(await store.executeUiSurface({
      kind: 'set_card_outcome', id: found.id, scope, card, outcome: { tone: data.tone, text, at: now },
    }));
    if (!updated) fail(`cards ${ref} has closed; say the outcome in your reply instead.`);
    const named = `card ${card + 1}, "${spec.cards.cards[card]!.title}"`;
    const shown = await input.redraw(updated).catch(() => false);
    return shown
      ? `Outcome shown on ${named}. Its request buttons are gone.`
      : `Outcome saved on ${named}, but the card could not be redrawn just now; say the outcome in your reply.`;
  };
  return {
    name: SLACK_UPDATE_CARD_TOOL_NAME,
    description: DESCRIPTION,
    input: UpdateCardSchema,
    output: v.string(),
    run: async ({ data }: { data: UpdateCardInput }) => {
      try {
        return { output: await run(data) };
      } catch (error) {
        if (error instanceof SlackPresentationInputError) throw new Error(error.message);
        throw error;
      }
    },
  };
}
