import PUBLISHED from './published.json' with { type: 'json' };

/**
 * Every published version of the Agent card. `npm run mcp-cards:build`
 * appends one to published.json whenever the built page changes, because
 * hosts cache a card by its URI, and a chat drawn with an older one asks for
 * that one again.
 */
export const AGENT_CARD_VERSIONS: readonly number[] = PUBLISHED.map(({ version }) => version);
/** The newest version, the one card tools name. */
export const AGENT_CARD_VERSION: number = AGENT_CARD_VERSIONS.at(-1)!;
/** Stored as text: every asset is public, and an `.html` there would run as a page on Chickpea's origin. */
export const agentCardAssetPath = (version: number): string => `mcp-cards/agent-card-v${version}.html.txt`;
