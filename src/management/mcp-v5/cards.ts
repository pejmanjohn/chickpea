import type { McpServer } from '@modelcontextprotocol/server';
import { readPublicAsset } from '#chickpea-assets';

import { AGENT_CARD_VERSION, AGENT_CARD_VERSIONS, agentCardAssetPath } from '../../mcp-cards/agent-card/published.ts';

/**
 * The Agent card: one MCP App (`ui://` HTML resource) that ChatGPT and other
 * MCP Apps hosts draw for the tools that propose, create, change or confirm
 * an Agent. The page is built by `npm run mcp-cards:build` and ships as a
 * Worker static asset, so the server needs no MCP Apps dependency.
 */
const agentCardUri = (version: number) => `ui://chickpea/agent-card-v${version}`;
/** The newest card: every card tool names it. */
export const AGENT_CARD_URI = agentCardUri(AGENT_CARD_VERSION);
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** Hosts may link out only to Slack and to Chickpea's own pages. */
const SLACK_ORIGIN = 'https://slack.com';

/**
 * The card reaches nothing itself: it calls tools through the host, so it
 * needs no connect or resource domains. Links open through the host, to Slack
 * or to this deployment.
 */
export function agentCardResourceMeta(baseUrl: string | undefined) {
  const origin = baseUrl ? URL.parse(baseUrl)?.origin : undefined;
  return {
    ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true },
    'openai/widgetCSP': {
      connect_domains: [],
      resource_domains: [],
      redirect_domains: [...origin && origin !== 'null' ? [origin] : [], SLACK_ORIGIN],
    },
    'openai/widgetDescription': 'Shows the Chickpea Agent from the last result: a proposal to create, its arrival in Slack, a change to save, or a change to confirm. The person acts on the card, so do not repeat what it shows.',
  };
}

/**
 * Every published version stays readable, because a chat drawn with an older
 * card asks for its URI again when it reopens. That card calls today's
 * tools, so a card tool's output only ever gains fields.
 */
export function registerAgentCard(server: McpServer, baseUrl: string | undefined): void {
  const meta = agentCardResourceMeta(baseUrl);
  for (const version of AGENT_CARD_VERSIONS) {
    server.registerResource(`agent-card-v${version}`, agentCardUri(version), {
      title: 'Chickpea Agent card',
      description: 'The card ChatGPT draws for an Agent proposal, creation, change or confirmation.',
      mimeType: MCP_APP_MIME_TYPE,
      _meta: meta,
    }, async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: MCP_APP_MIME_TYPE,
        text: new TextDecoder().decode(await readPublicAsset(agentCardAssetPath(version))),
        _meta: meta,
      }],
    }));
  }
}
