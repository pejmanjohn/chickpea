import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { collectEnvelopeHints, parseToolEnvelope } from '../src/tools.ts';
import { FakeDeployment, fakeBrowser } from './helpers/fake-deployment.ts';
import { runCli, temporaryStore, type CliRun } from './helpers/run-cli.ts';

const SETUP_URL = 'http://127.0.0.1:9/admin/setup/complete#setup=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const deployment = new FakeDeployment({
  tools: {
    inspect_workspace: () => ({
      ok: true,
      result: {
        organizationId: 'org_test',
        effectiveRevision: 'rev_9',
        connectors: [{ id: 'gmail', name: 'Gmail', description: '' }],
        agents: [{
          id: 'agent_support', revision: 3, name: 'Support', instructions: '', enabled: true, lifecycle: 'active',
          model: 'openai/gpt-5.6-terra', skills: [{ name: 'refunds' }], mcpServers: [], apiConnections: [],
          slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: {} },
          connections: [{ id: 'c1', providerId: 'gmail', label: 'ops@example.com', ownerKind: 'team', lifecycle: 'ready', enabled: true, allowedCapabilities: [] }],
          repositories: [{ name: 'acme/api' }],
        }],
        channels: [{ workspaceId: 'T1', channelId: 'C1', revision: 1, label: '#support', lifecycle: 'active', grants: [{ agentId: 'agent_support', status: 'active', revision: 1 }] }],
        providers: [
          { id: 'openai', source: 'env', mutable: false, workspaceDefaultAffected: true, inheritingAgentCount: 1, affectedAgents: [] },
          { id: 'anthropic', source: 'missing', mutable: true, workspaceDefaultAffected: false, inheritingAgentCount: 0, affectedAgents: [] },
        ],
        team: { members: [{ id: 'm1', userId: 'u1', displayName: 'Alex', role: 'owner', status: 'active', revision: 1 }] },
      },
    }),
    get_operation: (args) => ({ ok: true, result: { operation: { operationId: args.operationId, status: 'completed' } } }),
    inspect_memory: () => ({ ok: false, error: { code: 'not_found', message: 'No such Agent.' } }),
    propose_workspace_changes: () => ({
      ok: true,
      result: { proposalId: 'prop_123', status: 'pending', digest: 'd', guide: {}, preview: { summary: 'Delete Support' }, presentation: { slack: 'Delete Support?' }, confirmationTool: 'confirm_workspace_change' },
    }),
    apply_workspace_changes: () => ({
      ok: true,
      result: {
        operationId: 'op_1', idempotencyKey: 'k', status: 'confirmation_required', effectiveRevision: 'rev_9', activation: 'next_turn',
        outcomes: [
          { itemId: 'archive', operationKind: 'archive_agent', disposition: 'confirmation_required', proposalId: 'prop_456' },
          { itemId: 'setup', operationKind: 'request_setup', disposition: 'setup_required', setupOperationId: 'setup_1', setupUrl: SETUP_URL },
        ],
      },
    }),
    confirm_workspace_change: (args) => ({ ok: true, result: { proposalId: args.proposalId, status: 'applied' } }),
    export_workspace_recipe: (args) => ({ ok: true, result: { schemaVersion: 1, name: 'Workspace', agents: (args.agentIds as string[] | undefined ?? ['all']).map((id) => ({ symbol: id })) } }),
    preview_workspace_recipe: (args) => ({
      ok: true,
      result: {
        recipeDigest: 'digest_1',
        agents: [{ symbol: (args.recipe as { agents: Array<{ symbol: string }> }).agents[0]!.symbol, status: 'create', setupRequired: ['gmail'], unavailable: [] }],
        operations: [{ itemId: 'a', kind: 'create_agent' }, { itemId: 'b', kind: 'request_setup' }],
      },
    }),
  },
});
const store = temporaryStore();

before(async () => {
  await deployment.start();
  const login = await runCli(['login', deployment.url], { store, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
});
after(() => deployment.stop());

function call(argv: string[]): Promise<CliRun> {
  return runCli(['call', deployment.url, ...argv], { store });
}

test('call prints the ok envelope as JSON and exits 0', async () => {
  const result = await call(['get_operation', '--args', '{"operationId":"op_42"}']);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: { operation: { operationId: 'op_42', status: 'completed' } } });
  assert.equal(result.stderr, '');
  assert.deepEqual(deployment.toolCalls.at(-1), { name: 'get_operation', args: { operationId: 'op_42' } });
});

test('call prints the error envelope as JSON and exits 1', async () => {
  const result = await call(['inspect_memory', '--args', '{"agentId":"agent_missing"}']);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout), { ok: false, error: { code: 'not_found', message: 'No such Agent.' } });
});

test('a proposal is shown with the exact confirm command and is never auto-confirmed', async () => {
  const calls = deployment.toolCalls.length;
  const result = await call(['propose_workspace_changes', '--args', '{"idempotencyKey":"k","guideVersion":"1","authoringReason":"agent_edit","operations":[]}']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.proposalId, 'prop_123');
  assert.match(result.stderr, /Proposal prop_123 is waiting for confirmation\. Nothing has been applied\./);
  assert.match(result.stderr, new RegExp(`chickpea call ${deployment.url} confirm_workspace_change --args '\\{"proposalId":"prop_123"\\}'`));
  assert.equal(deployment.toolCalls.length, calls + 1);
  assert.equal(deployment.toolCalls.at(-1)!.name, 'propose_workspace_changes');

  const explicit = await call(['confirm_workspace_change', '--args', '{"proposalId":"prop_123"}']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).result.status, 'applied');
});

test('confirmation_required outcomes and setup links inside an apply result are both surfaced', async () => {
  const result = await call(['apply_workspace_changes', '--args', '{"idempotencyKey":"k","operations":[]}']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /confirm_workspace_change --args '\{"proposalId":"prop_456"\}'/);
  assert.match(result.stderr, /Setup link issued\. Anyone who holds it can complete its exact action without signing in; it expires in 24 hours\./);
  assert.match(result.stderr, new RegExp(`  ${SETUP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(deployment.toolCalls.at(-1)!.name, 'apply_workspace_changes');
});

test('envelope parsing prefers structured content and hint collection ignores unrelated ids', () => {
  const parsed = parseToolEnvelope({
    content: [{ type: 'text', text: '{"ok":true,"result":{"x":1}}' }],
    structuredContent: { ok: true, result: { x: 2 } },
  });
  assert.deepEqual(parsed, { ok: true, result: { x: 2 } });
  const textOnly = parseToolEnvelope({ content: [{ type: 'text', text: '{"ok":false,"error":{"code":"e","message":"m"}}' }], isError: true });
  assert.equal(textOnly.ok, false);
  assert.deepEqual(collectEnvelopeHints({ ok: true, result: { proposalId: 'prop_done', status: 'completed', outcomes: [{ disposition: 'applied', proposalId: 'x' }] } }), { proposals: [], setupLinks: [] });
  assert.deepEqual(collectEnvelopeHints({ ok: false, error: { code: 'e', message: 'm' } }), { proposals: [], setupLinks: [] });
});

test('--args-file reads arguments from disk and malformed arguments fail before any call', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chickpea-args-'));
  const file = path.join(dir, 'args.json');
  writeFileSync(file, '{"operationId":"op_file"}');
  const ok = await call(['get_operation', '--args-file', file]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).result.operation.operationId, 'op_file');

  const calls = deployment.toolCalls.length;
  const bad = await call(['get_operation', '--args', '{oops']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /^chickpea: INVALID_ARGUMENT: Tool arguments must be valid JSON/);
  assert.equal(deployment.toolCalls.length, calls);
});

test('workspace inspect renders Agents, connections, repositories, channels, providers, and team', async () => {
  const result = await runCli(['workspace', 'inspect', deployment.url], { store });
  assert.equal(result.code, 0, result.stderr);
  const out = result.stdout;
  assert.match(out, /^Workspace org_test \(revision rev_9\)/);
  assert.match(out, /Agents \(1\)\n  Support  @support  id=agent_support  rev=3  active  presence=healthy/);
  assert.match(out, /model: openai\/gpt-5\.6-terra/);
  assert.match(out, /skills: refunds/);
  assert.match(out, /connections: ops@example\.com \(team, ready\)/);
  assert.match(out, /repositories: acme\/api/);
  assert.match(out, /Channels \(1\)\n  #support C1  active  grants: agent_support:active/);
  assert.match(out, /openai: configured \(env, read-only\), 1 inheriting Agent/);
  assert.match(out, /anthropic: not configured/);
  assert.match(out, /Connector catalog \(1\): gmail/);
  assert.match(out, /Team \(1\)\n  Alex  owner  active/);
});

test('recipe export writes the recipe JSON to stdout and preview summarizes the plan', async () => {
  const exported = await runCli(['recipe', 'export', deployment.url, '--agents', 'agent_a, agent_b'], { store });
  assert.equal(exported.code, 0, exported.stderr);
  const recipe = JSON.parse(exported.stdout) as { schemaVersion: number; agents: Array<{ symbol: string }> };
  assert.equal(recipe.schemaVersion, 1);
  assert.deepEqual(recipe.agents.map((agent) => agent.symbol), ['agent_a', 'agent_b']);
  assert.deepEqual(deployment.toolCalls.at(-1), { name: 'export_workspace_recipe', args: { agentIds: ['agent_a', 'agent_b'] } });

  const dir = mkdtempSync(path.join(tmpdir(), 'chickpea-recipe-'));
  const file = path.join(dir, 'recipe.json');
  writeFileSync(file, exported.stdout);
  const preview = await runCli(['recipe', 'preview', deployment.url, file], { store });
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Recipe digest digest_1/);
  assert.match(preview.stdout, /agent_a: create  setup required: gmail/);
  assert.match(preview.stdout, /Operations \(2\)\n  a: create_agent\n  b: request_setup/);
  assert.match(preview.stderr, /apply_workspace_changes --args-file/);
  assert.equal(deployment.toolCalls.at(-1)!.name, 'preview_workspace_recipe');
  assert.deepEqual((deployment.toolCalls.at(-1)!.args.recipe as { schemaVersion: number }).schemaVersion, 1);

  const json = await runCli(['recipe', 'preview', deployment.url, file, '--json'], { store });
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).recipeDigest, 'digest_1');
});
