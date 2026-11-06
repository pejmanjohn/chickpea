/**
 * A card set (present_cards) settles card by card: a press on a card's
 * request button, or an outcome the Agent reports, settles that card alone.
 * The set resolves once every card with a request button is settled.
 */
import type { CardSpec, PresentCardsSpec } from './presentation-tools.ts';
import type { CardSettlements, UiSurfaceRecord } from './surface.ts';

/** Card button slots: each card owns three (the link, then its actions), so a value names its card and button. */
export function cardButtonIndex(card: number, button: number): number {
  return card * 3 + button;
}

export function cardOfSlot(slot: number): number {
  return Math.floor(slot / 3);
}

/** The request button a slot names; the link and url buttons never start a turn. */
export function cardRequestButtonAt(
  spec: PresentCardsSpec,
  slot: number,
): { card: CardSpec; label: string } | undefined {
  const card = spec.cards[cardOfSlot(slot)];
  const action = card?.actions?.[(slot % 3) - 1];
  return card && action && !action.url ? { card, label: action.label } : undefined;
}

function cardHasRequests(card: CardSpec): boolean {
  return card.actions?.some((action) => !action.url) ?? false;
}

/**
 * Each card's settlement. A set an older build settled whole on its first
 * click reads as that one pick, on the card it named.
 */
export function cardSettlementsOf(record: Pick<UiSurfaceRecord, 'cardSettlements' | 'resolution'>): CardSettlements {
  if (record.cardSettlements) return record.cardSettlements;
  const whole = record.resolution;
  if (!whole) return {};
  return { [cardOfSlot(whole.choice)]: { pick: { slot: whole.choice, byUserId: whole.byUserId, at: whole.at } } };
}

/** A set of link-only cards never resolves; it stays open until it expires. */
export function cardSetSettled(spec: PresentCardsSpec, settlements: CardSettlements): boolean {
  const requests = spec.cards.flatMap((card, index) => (cardHasRequests(card) ? [index] : []));
  return requests.length > 0 && requests.every((index) => settlements[index] !== undefined);
}

/** The card a model names: its title (exact, else in any case) when only one card has it, else its number from 1. */
export function findCard(spec: PresentCardsSpec, selector: string): number | undefined {
  const wanted = selector.replace(/\s+/g, ' ').trim();
  const exact = spec.cards.flatMap((card, index) => (card.title === wanted ? [index] : []));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const folded = spec.cards.flatMap((card, index) => (card.title.toLowerCase() === wanted.toLowerCase() ? [index] : []));
  if (folded.length === 1) return folded[0];
  if (!/^\d{1,2}$/.test(wanted)) return undefined;
  const index = Number(wanted) - 1;
  return index >= 0 && index < spec.cards.length ? index : undefined;
}
