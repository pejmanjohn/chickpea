import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { z } from 'zod';

import { collectEnvelopeHints, parseToolEnvelope, renderEnvelopeHints } from '../src/tools.ts';
import { FakeDeployment, fakeBrowser } from './helpers/fake-deployment.ts';
import { runCli, temporaryStore, type CliRun } from './helpers/run-cli.ts';

const SETUP_URL = 'http://127.0.0.1:9/admin/setup/complete#setup=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const deployment = new FakeDeployment({
  tools: {
    get_workspace: () => ({ name: 'Example', you: { name: 'Alex', role: 'owner' }, agentCount: 1, adminUrl: 'https://chickpea.example/admin', adminOnly: [] }),
    list_agents: () => ({ agents: [{ agentId: 'agent_support', name: 'Support', handle: 'support', status: 'on', canEdit: true, needsAttention: ['Connect Gmail.'] }], canCreate: true }),
    get_operation: (args) => ({ ok: true, result: { operation: { operationId: args.operationId, status: 'completed' } } }),
    inspect_memory: () => ({ ok: false, error: { code: 'not_found', message: 'No such Agent.' } }),
    apply_workspace_changes: () => ({
      ok: true,
      result: {
        operationId: 'op_1', idempotencyKey: 'k', status: 'confirmation_required', effectiveRevision: 'rev_9', activation: 'next_turn',
        outcomes: [
          { itemId: 'delete', operationKind: 'delete_agent', disposition: 'confirmation_required', proposalId: 'changeset_456' },
          { itemId: 'setup', operationKind: 'request_setup', disposition: 'setup_required', setupOperationId: 'setup_1', setupUrl: SETUP_URL },
        ],
        presentation: { markdown: 'Delete Support?' },
      },
    }),
    confirm_workspace_change: (args) => ({ ok: true, result: { proposalId: args.proposalId, status: 'applied' } }),
    export_agents: (args) => ({ schemaVersion: 2, name: 'Workspace', agents: (args.agentIds as string[] | undefined ?? ['all']).map((id) => ({ symbol: id })) }),
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

test('a destructive change is shown with the exact confirm command and is never auto-confirmed', async () => {
  const calls = deployment.toolCalls.length;
  const result = await call(['apply_workspace_changes', '--args', '{"idempotencyKey":"k","operations":[]}']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.status, 'confirmation_required');
  assert.match(result.stderr, /This change is destructive and waits for your confirmation \(changeset_456\)\. Nothing has been applied\./);
  assert.match(result.stderr, /result\.presentation\.markdown/);
  assert.match(result.stderr, new RegExp(`chickpea call ${deployment.url} confirm_workspace_change --args '\\{"proposalId":"changeset_456"\\}'`));
  assert.equal(deployment.toolCalls.length, calls + 1);
  assert.equal(deployment.toolCalls.at(-1)!.name, 'apply_workspace_changes');

  const explicit = await call(['confirm_workspace_change', '--args', '{"proposalId":"changeset_456"}']);
  assert.equal(explicit.code, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).result.status, 'applied');
});

test('confirmation_required outcomes and setup links inside an apply result are both surfaced', async () => {
  const result = await call(['apply_workspace_changes', '--args', '{"idempotencyKey":"k","operations":[]}']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /confirm_workspace_change --args '\{"proposalId":"changeset_456"\}'/);
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
  assert.deepEqual(collectEnvelopeHints({ ok: true, result: { proposalId: 'prop_done', status: 'completed', outcomes: [{ disposition: 'applied', proposalId: 'x' }] } }), { confirmations: [], setupLinks: [], confirmTokens: [], setupPages: [] });
  assert.deepEqual(collectEnvelopeHints({ ok: false, error: { code: 'e', message: 'm' } }), { confirmations: [], setupLinks: [], confirmTokens: [], setupPages: [] });
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

test('workspace inspect combines 5.0 reads and prints workspace, role and Agent status', async () => {
  const result = await runCli(['workspace', 'inspect', deployment.url], { store });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, 'Workspace Example\nYou: Alex  owner\n\nAgents (1)\n  Support  @support  id=agent_support  on  can edit\n    needs attention: Connect Gmail.\n\nCan create Agents: yes\nWorkspace in Admin: https://chickpea.example/admin\n');
  assert.deepEqual(deployment.toolCalls.slice(-2).map(({ name }) => name), ['get_workspace', 'list_agents']);
  const json = await runCli(['workspace', 'inspect', deployment.url, '--json'], { store });
  assert.equal(json.code, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).workspace.you.role, 'owner');
  assert.equal(JSON.parse(json.stdout).agents[0].agentId, 'agent_support');
  assert.equal(JSON.parse(json.stdout).archivedLeftOut, undefined);
});

test('workspace inspect against a Core without includeArchived sends no new argument, with or without the flag', async () => {
  for (const flags of [[], ['--include-archived']]) {
    const result = await runCli(['workspace', 'inspect', deployment.url, ...flags], { store });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Agents \(1\)$/m);
    assert.deepEqual(deployment.toolCalls.at(-1), { name: 'list_agents', args: {} });
  }
});

// list_agents as Core #761 serves it: strict input, archived Agents only on request, two Agents a page.
const pagedAgents = [
  ...['a', 'b', 'c', 'd'].map((id) => ({ agentId: `agent_${id}`, name: id.toUpperCase(), status: 'on', canEdit: true, needsAttention: [] })),
  { agentId: 'agent_old', name: 'Old', status: 'archived', canEdit: true, needsAttention: [] },
];
let endlessPages = false;
const paged = new FakeDeployment({
  toolInputs: {
    list_agents: z.strictObject({
      include: z.enum(['all', 'mine']).optional(),
      includeArchived: z.boolean().optional(),
      cursor: z.string().regex(/^[1-9]\d{0,5}$/).optional(),
    }),
  },
  tools: {
    get_workspace: () => ({ name: 'Paged', you: { role: 'owner' }, agentCount: 5, adminOnly: [] }),
    list_agents: (args) => {
      const rows = pagedAgents.filter(({ status }) => args.includeArchived === true || status !== 'archived');
      const from = Number(args.cursor ?? 0);
      const more = endlessPages || from + 2 < rows.length;
      return { agents: rows.slice(from, from + 2), canCreate: true, ...(more ? { nextCursor: String(from + 2) } : {}) };
    },
  },
});
const pagedStore = temporaryStore();

before(async () => {
  await paged.start();
  const login = await runCli(['login', paged.url], { store: pagedStore, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
});
after(() => paged.stop());

test('workspace inspect follows nextCursor through every page and says archived Agents are left out', async () => {
  const listCalls = () => paged.toolCalls.filter(({ name }) => name === 'list_agents').map(({ args }) => args);

  const result = await runCli(['workspace', 'inspect', paged.url], { store: pagedStore });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, [
    'Workspace Paged', 'You: owner', '',
    'Agents (4 shown; archived Agents are left out, --include-archived lists them)',
    '  A  no handle  id=agent_a  on  can edit',
    '  B  no handle  id=agent_b  on  can edit',
    '  C  no handle  id=agent_c  on  can edit',
    '  D  no handle  id=agent_d  on  can edit',
    '', 'Can create Agents: yes', '',
  ].join('\n'));
  assert.deepEqual(listCalls(), [{}, { cursor: '2' }]);

  const json = await runCli(['workspace', 'inspect', paged.url, '--json'], { store: pagedStore });
  assert.equal(json.code, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.agents.map(({ agentId }: { agentId: string }) => agentId), ['agent_a', 'agent_b', 'agent_c', 'agent_d']);
  assert.equal(parsed.archivedLeftOut, true);
  assert.equal(parsed.canCreate, true);
  assert.equal('nextCursor' in parsed, false);
});

test('workspace inspect --include-archived asks every page for archived Agents', async () => {
  const before = paged.toolCalls.length;
  const result = await runCli(['workspace', 'inspect', paged.url, '--include-archived'], { store: pagedStore });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Agents \(5\)$/m);
  assert.match(result.stdout, /^ {2}Old {2}no handle {2}id=agent_old {2}archived {2}can edit$/m);
  assert.deepEqual(
    paged.toolCalls.slice(before).filter(({ name }) => name === 'list_agents').map(({ args }) => args),
    [{ includeArchived: true }, { includeArchived: true, cursor: '2' }, { includeArchived: true, cursor: '4' }],
  );
});

test('workspace inspect stops after 50 pages with an error instead of printing part of the list', async (t) => {
  endlessPages = true;
  t.after(() => { endlessPages = false; });
  const before = paged.toolCalls.length;
  const result = await runCli(['workspace', 'inspect', paged.url], { store: pagedStore });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^chickpea: TOO_MANY_PAGES: list_agents had more than 50 pages/);
  assert.ok(result.stderr.includes(`list_agents --args '{"cursor":"<nextCursor>"}'`), result.stderr);
  assert.equal(paged.toolCalls.slice(before).filter(({ name }) => name === 'list_agents').length, 50);

  // The hint pages the same list the person asked for.
  const archived = await runCli(['workspace', 'inspect', paged.url, '--include-archived'], { store: pagedStore });
  assert.equal(archived.code, 1);
  assert.equal(archived.stdout, '');
  assert.ok(archived.stderr.includes(`list_agents --args '{"includeArchived":true,"cursor":"<nextCursor>"}'`), archived.stderr);
});

test('recipe export uses export_agents and prints the recipe unchanged', async () => {
  const exported = await runCli(['recipe', 'export', deployment.url, '--agents', 'agent_a, agent_b'], { store });
  assert.equal(exported.code, 0, exported.stderr);
  const recipe = JSON.parse(exported.stdout);
  assert.equal(recipe.schemaVersion, 2);
  assert.deepEqual(recipe.agents.map((agent: { symbol: string }) => agent.symbol), ['agent_a', 'agent_b']);
  assert.deepEqual(deployment.toolCalls.at(-1), { name: 'export_agents', args: { agentIds: ['agent_a', 'agent_b'] } });
});

test('recipe preview is removed without reading files, signing in or calling a tool', async () => {
  const calls = deployment.toolCalls.length;
  for (const flags of [[], ['--json'], ['--quiet']]) {
    const preview = await runCli(['recipe', 'preview', ...flags], { readFile: () => { throw new Error('must not read'); } });
    assert.equal(preview.code, 1);
    assert.equal(preview.stdout, '');
    assert.equal(preview.stderr, 'recipe preview was removed. A coding agent applies a recipe through create_agent and update_agent.\n');
  }
  assert.equal(deployment.toolCalls.length, calls);
});

test('built-in commands on an older Core ask for an update without calling 4.x tools', async (t) => {
  const older = new FakeDeployment({ legacyOnly: true });
  await older.start();
  t.after(() => older.stop());
  const olderStore = temporaryStore();
  const login = await runCli(['login', older.url], { store: olderStore, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
  for (const argv of [['workspace', 'inspect', older.url], ['recipe', 'export', older.url]]) {
    const result = await runCli(argv, { store: olderStore });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /UPDATE_REQUIRED: Update your Chickpea Core/);
  }
  assert.deepEqual(older.toolCalls, []);
});

test('5.0 parsing preserves structured success, refusal guidance and SDK validation text', () => {
  assert.deepEqual(parseToolEnvelope({ content: [{ type: 'text', text: 'display only' }], structuredContent: { agents: [] } }), { ok: true, result: { agents: [] } });
  const error = { code: 'not_allowed', message: 'Ask an owner.', nextStep: 'Open Admin.', fix: { label: 'Admin', url: 'https://chickpea.example/admin' }, retryable: false };
  for (const isError of [true, false]) {
    assert.deepEqual(parseToolEnvelope({ content: [{ type: 'text', text: 'Ask an owner.' }], structuredContent: { error }, isError }), { ok: false, error });
  }
  assert.deepEqual(parseToolEnvelope({ content: [{ type: 'text', text: 'Input validation error: agentId is required' }], isError: true }), { ok: false, error: { code: 'tool_error', message: 'Input validation error: agentId is required' } });
});

test('5.0 results that wait for confirmation or issue a setup link carry the same guidance', async () => {
  const waiting = { status: 'needs_confirmation', summary: 'Delete Support?', confirmation: { confirmToken: 'confirm_1', preview: 'Deletes Support.' } };
  const linked = { status: 'needs_setup', summary: 'Sign in to Gmail.', setup: { url: SETUP_URL, setupToken: 'setup_1', what: 'Gmail' } };
  assert.deepEqual(collectEnvelopeHints({ ok: true, result: waiting }), { confirmations: [], setupLinks: [], confirmTokens: ['confirm_1'], setupPages: [] });
  const lines = renderEnvelopeHints(collectEnvelopeHints({ ok: true, result: linked }), 'https://chickpea.example');
  assert.deepEqual(lines.slice(1), [`  ${SETUP_URL}`, 'Cancel it with the cancel_setup_link tool if it leaks.']);
  const confirm = renderEnvelopeHints(collectEnvelopeHints({ ok: true, result: waiting }), 'https://chickpea.example');
  assert.equal(confirm.at(-1), `  chickpea call https://chickpea.example confirm_change --args '{"confirmToken":"confirm_1"}'`);
  // Only a plain handle at the top of the result becomes a command to paste.
  for (const result of [
    { confirmation: { confirmToken: "x'; rm -rf ~; '", preview: 'x' } },
    { agent: { confirmation: { confirmToken: 'nested_1' }, setup: { url: SETUP_URL } } },
    { setup: { url: 'https://chickpea.example/setup\u001b[2J' } },
  ]) {
    assert.deepEqual(collectEnvelopeHints({ ok: true, result }), { confirmations: [], setupLinks: [], confirmTokens: [], setupPages: [] });
  }
  // A card host's result holds the token for the card; nothing to confirm from here.
  assert.deepEqual(collectEnvelopeHints({ ok: true, result: { status: 'needs_confirmation', confirmation: { preview: 'x' } } }).confirmTokens, []);
});
