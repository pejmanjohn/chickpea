import PUBLISHED from './published.json' with { type: 'json' };

/**
 * The Agent card's current version. `npm run mcp-cards:build` appends a
 * version to published.json whenever the built page changes, because hosts
 * cache a card by its URI.
 */
export const AGENT_CARD_VERSION: number = PUBLISHED.at(-1)!.version;
/** Stored as text: every asset is public, and an `.html` there would run as a page on Chickpea's origin. */
export const AGENT_CARD_ASSET_PATH = `mcp-cards/agent-card-v${AGENT_CARD_VERSION}.html.txt`;
