import { ResourceNotFoundError, ResourceTemplate, type McpServer } from '@modelcontextprotocol/server';
import { readPublicAsset } from '#chickpea-assets';

import { CARD_NAMES, cardAssetPath, cardVersions, type CardName } from '../../mcp-cards/published.ts';

/**
 * The cards: MCP Apps (`ui://` HTML resources) that ChatGPT and other MCP
 * Apps hosts draw for a card tool's result. Each page is built by
 * `npm run mcp-cards:build` and ships as a Worker static asset, so the server
 * needs no MCP Apps dependency.
 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

const cardUri = (card: CardName, version: number) => `ui://chickpea/${card}-v${version}`;

/** Each card's newest URI: every tool that card draws names it. */
export const CARD_URIS = Object.fromEntries(
  CARD_NAMES.map((card) => [card, cardUri(card, cardVersions(card).at(-1)!)]),
) as Record<CardName, string>;

/** What each card is, for the resource list and for the model. */
const CARD_TEXT: Record<CardName, { title: string; description: string; widgetDescription: string }> = {
  'agent-card': {
    title: 'Chickpea Agent card',
    description: 'The card ChatGPT draws for an Agent proposal, creation, change or confirmation.',
    widgetDescription: 'Shows the Chickpea Agent from the last result: a proposal to create, its arrival in Slack, a change to save, or a change to confirm. The person acts on the card, so do not repeat what it shows.',
  },
  'connect-card': {
    title: 'Chickpea connect card',
    description: 'The card ChatGPT draws for a setup link that connects a service to an Agent or signs one in again.',
    widgetDescription: 'Shows the service from the last result with a Connect button that opens Chickpea\'s setup page, then shows when the service is connected. The person signs in on that page, so do not ask for a key, and repeat the link only when the result\'s setup has no setupToken, which the card cannot open.',
  },
  'health-card': {
    title: 'Chickpea health card',
    description: 'The card ChatGPT draws for a check of one Agent: what needs attention, each with its fix, and what looks healthy.',
    widgetDescription: 'Shows the check of one Chickpea Agent from the last result: each part that needs attention with its fix, and the parts that look healthy. The person fixes from the card, so do not repeat every row.',
  },
};

/** Hosts may link out only to Slack and to Chickpea's own pages. */
const SLACK_ORIGIN = 'https://slack.com';

/**
 * A card fetches nothing itself: it calls tools through the host, so it
 * needs no connect domains. It loads only Agent pictures, from this
 * deployment, which serves every Agent's avatar on its own origin. Links
 * open through the host, to Slack or to this deployment.
 *
 * Every version gets the same CSP, so the older cards, which load no
 * picture, list the origin too; it adds nothing their fixed bytes use. A
 * host applies resource domains to scripts and styles as well, which is
 * safe only while no route on this origin, Core's or Chickpea Cloud's,
 * serves content a person chose as a script or a style.
 */
export function cardResourceMeta(card: CardName, baseUrl: string | undefined) {
  const parsed = baseUrl ? URL.parse(baseUrl)?.origin : undefined;
  const own = parsed && parsed !== 'null' ? [parsed] : [];
  return {
    ui: { csp: { connectDomains: [], resourceDomains: own }, prefersBorder: true },
    'openai/widgetCSP': {
      connect_domains: [],
      resource_domains: own,
      redirect_domains: [...own, SLACK_ORIGIN],
    },
    'openai/widgetDescription': CARD_TEXT[card].widgetDescription,
  };
}

/**
 * Every published version of every card stays readable, because a chat
 * drawn with an older card asks for its URI again when it reopens. That card
 * calls today's tools, so a card tool's output only ever gains fields. Only
 * the newest is listed: the older ones are read by the URI a chat kept,
 * through a template no list names.
 */
export function registerCards(server: McpServer, baseUrl: string | undefined): void {
  for (const card of CARD_NAMES) {
    const meta = cardResourceMeta(card, baseUrl);
    const metadata = {
      title: CARD_TEXT[card].title,
      description: CARD_TEXT[card].description,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: meta,
    };
    const read = async (uri: URL, version: number) => ({
      contents: [{
        uri: uri.href,
        mimeType: MCP_APP_MIME_TYPE,
        text: new TextDecoder().decode(await readPublicAsset(cardAssetPath(card, version))),
        _meta: meta,
      }],
    });
    const versions = cardVersions(card);
    const newest = versions.at(-1)!;
    server.registerResource(`${card}-v${newest}`, cardUri(card, newest), metadata, (uri) => read(uri, newest));
    const older = new ResourceTemplate(`ui://chickpea/${card}-v{version}`, { list: undefined });
    server.registerResource(`${card}-older`, older, metadata, (uri, { version }) => {
      const asked = Number(version);
      if (String(asked) !== version || !versions.includes(asked)) throw new ResourceNotFoundError(uri.href);
      return read(uri, asked);
    });
  }
}
