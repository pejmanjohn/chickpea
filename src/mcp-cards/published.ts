import PUBLISHED from './published.json' with { type: 'json' };

/**
 * Every published version of every card. `npm run mcp-cards:build` appends
 * one to published.json whenever a card's built page changes, because hosts
 * cache a card by its URI, and a chat drawn with an older one asks for that
 * one again.
 */
export type CardName = keyof typeof PUBLISHED;
export const CARD_NAMES = Object.keys(PUBLISHED) as CardName[];
export const cardVersions = (card: CardName): number[] => (PUBLISHED[card] as Array<{ version: number }>).map(({ version }) => version);
/** Stored as text: every asset is public, and an `.html` there would run as a page on Chickpea's origin. */
export const cardAssetPath = (card: CardName, version: number): string => `mcp-cards/${card}-v${version}.html.txt`;
export const CARD_ASSET_PATHS = CARD_NAMES.flatMap((card) => cardVersions(card).map((version) => cardAssetPath(card, version)));
