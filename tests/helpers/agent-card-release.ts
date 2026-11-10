import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

/**
 * The Agent card's server as a release would run it after publishing the
 * versions in PUBLISHED_JSON, with that release's assets in the working
 * directory. Prints what tools name, what the allowlist lets through, and
 * what each card URI serves. tests/mcp-agent-card.test.ts runs it to try a
 * version bump without publishing one.
 */

const PUBLISHED = new URL('../../src/mcp-cards/agent-card/published.json', import.meta.url).href;
const published = readFileSync(process.env.PUBLISHED_JSON!, 'utf8');
registerHooks({
  load: (url, context, next) => url.split('?')[0] === PUBLISHED
    ? { format: 'json', source: published, shortCircuit: true }
    : next(url, context),
});

const { createMcpHandler, McpServer } = await import('@modelcontextprotocol/server');
const { AGENT_CARD_URI, registerAgentCard } = await import('../../src/management/mcp-v5/cards.ts');
const { isPublicAssetPath } = await import('../../src/assets/public-assets.ts');

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'chickpea-release', version: '0' });
  registerAgentCard(server, 'https://chickpea.example.test');
  return server;
}, { legacy: 'stateless' });

async function rpc(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }));
  const body = await response.text();
  const json = body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  return JSON.parse(json);
}

const versions = (JSON.parse(published) as Array<{ version: number }>).map(({ version }) => version);
const { result } = await rpc('resources/list');
const served: Record<string, string> = {};
for (const { uri } of result.resources as Array<{ uri: string }>) {
  const read = await rpc('resources/read', { uri });
  served[uri] = read.result?.contents[0].text ?? `error: ${read.error?.message}`;
}
console.log(JSON.stringify({
  toolsName: AGENT_CARD_URI,
  allowlisted: versions.filter((version) => isPublicAssetPath(`mcp-cards/agent-card-v${version}.html.txt`)),
  served,
}));
