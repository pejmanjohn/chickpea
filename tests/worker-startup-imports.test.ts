import assert from 'node:assert/strict';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { importGraph, reachable, workerEntries } from './helpers/import-graph.ts';
// @ts-expect-error Build tooling JavaScript helper.
import { compareSizes, exportCommit, formatGrowth, growthFailure, growthLine, growthPlan, short } from '../scripts/lib/budget-growth.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Modules that load on first use and never at Worker startup, with where they
 * first load. Every module a Worker's entry imports statically loads before a
 * Durable Object's constructor runs, at about 0.1 s per MiB. One static import
 * from anything the entry reaches turns a lazy load into a no-op, which is how
 * the lazy loads of just-bash and shared-prefix.ts stopped working unnoticed.
 */
const LAZY_MODULES: Record<string, string> = {
  'just-bash': "a Flue agent's sandbox (agents/slack-thread.ts, config/egress.ts)",
  'src/agents/shared-prefix.ts': "the Anthropic platform-funded payload hook (config/model-access.ts)",
  'src/agents/shared-prefix-tools.json': "the Anthropic platform-funded payload hook (config/model-access.ts)",
  '@composio/core': 'the Composio client (config/composio-settings.ts)',
  'src/connections/catalog/manifests':
    "a connector's detail (connections/catalog/index.ts): turn staging, an Agent object's start, the Composio provider, Admin",
  'image-in-browser': 'image output preparation (images/prepare-output.ts)',
  'unpdf': 'the first PDF attachment read (slack/attachment-normalization.ts)',
  '@modelcontextprotocol/sdk/client': 'the MCP SDK (config/mcp-sdk.ts): a connection test, an identity probe, an OAuth start, exchange, refresh or registration',
  '@modelcontextprotocol/sdk/validation': 'the MCP SDK (config/mcp-sdk.ts): a connection test or an identity probe',
  '@modelcontextprotocol/sdk/shared/auth-utils.js': "the MCP SDK (config/mcp-sdk.ts): an OAuth authorization's start",
  '@modelcontextprotocol/server': 'the management MCP server (management/mcp.ts), behind the MCP route app.ts mounts lazily',
  'better-auth': 'Better Auth (auth/better-auth.ts): a sign-in, a session read, an MCP or an Admin authentication',
  '@better-auth/mcp': 'Better Auth (auth/better-auth.ts): a sign-in, a session read, an MCP or an Admin authentication',
  '@better-auth/cimd': 'client ID metadata documents (auth/mcp-client-metadata.ts, from auth/better-auth.ts)',
  'src/auth/mcp-client-metadata.ts': 'client ID metadata documents (auth/better-auth.ts)',
  'src/auth/better-auth-runtime.ts': "Better Auth's public routes (app.ts) and Admin's sign-out (admin/routes.ts)",
  'src/auth/better-auth-routes.ts': "Better Auth's public routes (auth/better-auth-runtime.ts)",
  'src/auth/mcp-oauth-routes.ts': 'the MCP resource and its sign-in pages (app.ts)',
  'src/management/mcp.ts': 'the management MCP server (auth/mcp-oauth-routes.ts)',
  'src/management/playbook': 'get_guide and the discovery guide resource (management/mcp-v5/tools.ts, management/mcp.ts)',
  'src/management/recipes.ts': 'a workspace recipe export or preview (management/service.ts)',
  'src/management/setup-return-app.ts': "a finished MCP setup link's success page (management/setup-routes.ts)",
  'src/slack/group-dm/runtime.ts': "start_slack_group_dm's first call (slack/group-dm/tools.ts)",
  'src/slack/group-dm/service.ts': "start_slack_group_dm's first call (slack/group-dm/runtime.ts)",
  'src/slack/channel-creation/runtime.ts': "create_slack_channel's first call (slack/channel-creation/tools.ts)",
  'src/slack/channel-creation/service.ts': "create_slack_channel's first call (slack/channel-creation/runtime.ts)",
  'src/management/slack-key-setup.ts': "an Add key setup's issue, its approval-time setups, or a pasted-key check (management/service.ts)",
  'src/slack/key-form.ts': 'an Add key card, click or form (channels/slack.ts, cloudflare.ts, slack/run-turn.ts)',
  'src/slack/canvases/service.ts': 'a canvas tool call (slack/canvases/tools.ts)',
  'src/slack/ui/card-set-message.ts': 'a card click redraw or an update_card call (channels/slack.ts, slack/ui/agent-card-redraw.ts)',
  'src/slack/ui/agent-card-redraw.ts': "update_card's first call (agents/slack-thread.ts)",
  'src/slack/funding-refusal-reply.ts': 'an out-of-usage reply or an Ask an Owner click (slack/run-turn.ts, channels/slack.ts)',
  'src/slack/answer-release.ts': "a turn's shadow of the host answer release, with its latency log (slack/run-turn.ts), or the host release itself",
  'src/slack/host-release-relay.ts': "a reply's relay while host answer release is on (slack/agent-view-presentation.ts)",
  'src/routines/pause-notice.ts': "a routine's out-of-usage pause, or the good run after it (routines/execution.ts)",
  'src/connections/service-error-text.ts': "a Composio-reported failure's reason (connections/providers/composio.ts)",
  'src/admin/usage-report.ts': "a hosted Usage report or activity page (admin/usage-api.ts)",
  'src/admin/routes.ts': "Admin's first request (app.ts)",
  'src/management/setup-routes.ts': "a setup link's or Admin's first request (app.ts, admin/routes.ts)",
  'src/management/connect-routes.ts': "a connect page's first request (app.ts)",
  'src/slack/agent-apps/admin-routes.ts': "an Agent app's token page, in Admin (admin/routes.ts)",
  'src/admin/page.ts': "an Admin page's first render (admin/routes.ts, slack/agent-apps/admin-routes.ts)",
  'src/management/connector-landing-page.ts': 'a connect page or a setup link (management/connect-routes.ts, management/setup-routes.ts)',
  'src/config/connector-logos.ts': 'an Admin page or a connect page (admin/page.ts, management/connector-landing-page.ts)',
  'src/config/suggested-skills.ts': "an Admin page's first render (admin/page.ts)",
  'src/admin/billing-api.ts': "the Plan page's API, on its first request (admin/routes.ts)",
  'src/state/test-run-lifecycle.ts': "a state store's first test run, test-run alarm pass or cancellation pass (cloudflare.ts)",
  'src/state/test-run-instance.ts': "a test run's first dispatch or step (cloudflare.ts)",
  'src/usage/test-run-usage.ts': 'the test-run lifecycle or tools (state/test-run-lifecycle.ts, management/mcp-v5/test-runs.ts)',
  'src/agents/test-run-plan.ts': 'the test-run instance port or tools (state/test-run-instance.ts, management/mcp-v5/test-runs.ts)',
  'src/management/mcp-v5/test-runs.ts': "a practice tool's first call (management/mcp-v5/tools.ts)",
  'src/browser/approval.ts': "browser_open's or browser_act's first call (browser/tools.ts)",
  'src/slack/turn-plan-reads.ts': "a thread runner's first turn (slack/thread-runner.ts)",
  'src/config/turn-read-batch.ts': "a thread runner's first turn, or a state store's first read batch (cloudflare.ts)",
};

/**
 * Source bytes of the repository modules Worker startup loads, comments and
 * types included. A change may add 16 KiB over its merge base
 * (scripts/lib/budget-growth.mjs); this ceiling backstops the total. Once per
 * merge train it may be set to the measured size plus 64 KiB, and it comes
 * down when a change moves modules behind import(). scripts/worker-closure.mjs
 * holds the built artifact to the growth rule alone.
 */
const STARTUP_SOURCE_CEILING_BYTES = 9_938_645 + 64 * 1024;

function isModule(node: string, module: string): boolean {
  return node === module || node.startsWith(module + '/');
}

/** Each repository module Worker startup loads under `root`, with its size in bytes. */
function startupSources(root: string): Map<string, number> {
  const graph = importGraph(root);
  return new Map([...graph.reachable(graph.workerEntries(), false).keys()]
    .filter((node) => node.startsWith('src/'))
    .map((file) => [file, statSync(join(root, file)).size]));
}

const current = startupSources(ROOT);
const measured = new Map<string, Map<string, number>>();
/** Startup sources at `commit`, or in the working tree when it is undefined. */
function startupSourcesAt(commit: string | undefined): Map<string, number> {
  if (commit === undefined) return current;
  if (!measured.has(commit)) {
    const directory = exportCommit(ROOT, commit, ['src', 'package.json']);
    try {
      measured.set(commit, startupSources(directory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return measured.get(commit)!;
}

const plan = growthPlan(ROOT);

test('the lazily loaded modules stay out of what the Worker loads at startup', () => {
  const entries = workerEntries();
  assert.ok(entries.includes('src/agents/slack-thread.ts'), "the scan finds the 'use agent' modules");
  const startup = reachable(entries, false);
  const everything = reachable(entries, true);
  for (const [module, firstLoad] of Object.entries(LAZY_MODULES)) {
    // A renamed or removed module would otherwise pass without guarding anything.
    assert.ok([...everything.keys()].some((node) => isModule(node, module)),
      `${module} is still imported somewhere; update LAZY_MODULES`);
    const loaded = [...startup].find(([node]) => isModule(node, module));
    assert.equal(loaded, undefined,
      `${module} loads at Worker startup through ${loaded?.[1].join(' -> ')}. ` +
      `Import it with import() where it is used: ${firstLoad}.`);
  }
});

test('the repository modules Worker startup loads stay under their ceiling', () => {
  const bytes = [...current.values()].reduce((sum, size) => sum + size, 0);
  if (bytes <= STARTUP_SOURCE_CEILING_BYTES) return;
  const grew = plan.base === undefined ? '' : `Modules that grew since the merge base:\n${
    formatGrowth(compareSizes(startupSourcesAt(plan.base), current).rows)}\n`;
  assert.fail(`Worker startup loads ${current.size} repository modules, ${bytes} bytes, over the ` +
    `${STARTUP_SOURCE_CEILING_BYTES}-byte ceiling.\n${grew}Load new code with import() where it is used. ` +
    'Once per merge train, STARTUP_SOURCE_CEILING_BYTES may be set to the measured size plus 64 KiB.');
});

test('a change adds at most its allowance to Worker startup over its merge base', { skip: plan.skip ?? false }, (t) => {
  if (plan.error) assert.fail(plan.error);
  t.diagnostic(`The merge base with ${plan.ref} is ${short(plan.base)}.`);
  for (const change of plan.changes) {
    const { growth, rows } = compareSizes(startupSourcesAt(change.from), startupSourcesAt(change.to));
    t.diagnostic(growthLine(change, growth));
    assert.ok(growth <= change.allowance,
      growthFailure({ what: "Worker startup's repository source", change, ref: plan.ref, growth, rows }));
  }
});
