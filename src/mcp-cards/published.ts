import PUBLISHED from './published.json' with { type: 'json' };

/**
 * The served versions of every card. `npm run mcp-cards:build` rebuilds a
 * card's newest version in place until it is `released`, which the
 * coordinator marks when it pins that version to production; after that a
 * change publishes the next version, because hosts cache a card by its URI
 * and a chat drawn with a released card asks for that one again. A version
 * below a card's oldest served one is retired: its URI reads as the retired
 * card.
 */
export type CardName = keyof typeof PUBLISHED;
export const CARD_NAMES = Object.keys(PUBLISHED) as CardName[];
export const cardVersions = (card: CardName): number[] => (PUBLISHED[card] as Array<{ version: number }>).map(({ version }) => version);
/** Stored as text: every asset is public, and an `.html` there would run as a page on Chickpea's origin. */
export const cardAssetPath = (card: CardName, version: number): string => `mcp-cards/${card}-v${version}.html.txt`;
/** One static page, no buttons, calls or data, served for every retired version of every card. */
export const RETIRED_CARD_ASSET_PATH = 'mcp-cards/retired-card.html.txt';
export const CARD_ASSET_PATHS = [
  ...CARD_NAMES.flatMap((card) => cardVersions(card).map((version) => cardAssetPath(card, version))),
  RETIRED_CARD_ASSET_PATH,
];
