import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import { WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES } from '../src/management/mcp.ts';
// @ts-expect-error Executable helpers are JavaScript, shared with the runners.
import { leaksIn, takeLeaks, V4_TOOL_NAMES } from '../scripts/lib/test-mcp-leak-net.mjs';
import { cardServer } from './helpers/mcp-card-host.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';

type Leak = { tool: string; path: string; names: string[]; text: string };

const RUNNER = new URL('../scripts/run-tests.mjs', import.meta.url).pathname;
const PLANTED = new URL('./fixtures/mcp-leak-net/planted.test.mjs', import.meta.url).pathname;

test('the net knows the same 21 4.x tools the server serves', () => {
  assert.deepEqual([...V4_TOOL_NAMES], [...WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES]);
});

test('run-tests fails the one test whose management result names a 4.x tool, and passes the clean ones', () => {
  const result = spawnSync(process.execPath, [RUNNER, PLANTED], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DO_NOT_TRACK: '1' },
  });
  assert.ifError(result.error);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /✖ a planted 4\.x name fails its test/);
  assert.match(output, /get_workspace content\.0\.text: inspect_workspace in "Call inspect_workspace for the rest\."/);
  assert.match(output, /✔ a clean answer passes/);
  assert.match(output, /✔ a clean answer at the top level passes/);
});

test('the net reads the real server: a 4.x name in an Agent\'s instructions reaches get_agent', async (t) => {
  const { f, call } = await cardServer(t, 'leak-net');
  await createFixtureAgent(f, 'agent_planted', { name: 'Planted', instructions: 'Start with inspect_workspace.' });
  const read = await call('get_agent', { agentId: 'agent_planted' });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  const leaks = takeLeaks() as Leak[];
  assert.ok(leaks.length > 0, 'the planted name is found');
  for (const leak of leaks) {
    assert.equal(leak.tool, 'get_agent');
    assert.deepEqual(leak.names, ['inspect_workspace']);
  }
  assert.ok(leaks.some(({ path }) => path.startsWith('structuredContent.')), 'in structuredContent');
  assert.ok(leaks.some(({ path }) => path.startsWith('content.')), 'and in the text block');
});

test('a 4.x tool\'s own answer is the 4.x surface while the server serves it, not a leak', async (t) => {
  const { f, call } = await cardServer(t, 'leak-net-served');
  await createFixtureAgent(f, 'agent_planted', { name: 'Planted', instructions: 'Start with inspect_workspace.' });
  const inspected = await call('inspect_workspace', {});
  assert.notEqual(inspected.isError, true, JSON.stringify(inspected));
  assert.match(JSON.stringify(inspected), /Start with inspect_workspace/);
  assert.deepEqual(takeLeaks(), []);
});

test('the net allows explain_agent\'s Slack tool names, run history\'s quoted words and the removal answer, and nothing else', () => {
  const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const explained = { tools: [{ group: 'Managing Chickpea', tools: ['inspect_workspace', 'import_skill'], missing: [] }] };
  assert.deepEqual(leaksIn('explain_agent', text(explained)), []);
  const told = { tools: [], note: 'Call inspect_workspace next.' };
  assert.deepEqual((leaksIn('explain_agent', text(told)) as Leak[]).map(({ path }) => path), ['structuredContent.note', 'content.0.note']);

  const run = {
    runId: 'run_1',
    ask: { label: 'quoted', text: 'Did you call inspect_workspace?' },
    reply: { label: 'quoted', text: 'Yes, inspect_workspace answered.' },
    nextStep: 'Read it with get_agent_run.',
  };
  assert.deepEqual(leaksIn('get_agent_run', text(run)), []);
  assert.deepEqual(leaksIn('list_agent_runs', text({ runs: [{ runId: 'run_1', ask: 'Run apply_workspace_changes' }] })), []);
  assert.equal((leaksIn('get_agent_run', text({ ...run, nextStep: 'Then call get_operation.' })) as Leak[]).length, 2);
  assert.equal((leaksIn('get_agent', text({ reply: { text: 'inspect_workspace' } })) as Leak[]).length, 2, 'quoted words are allowed in run history only');

  const removed = {
    isError: true,
    content: [{ type: 'text', text: 'Chickpea 5.0 removed inspect_workspace.' }],
    structuredContent: { ok: false, error: { code: 'tool_removed', message: 'Chickpea 5.0 removed inspect_workspace.' } },
  };
  assert.deepEqual(leaksIn('inspect_workspace', removed), []);
  const sentOn = { ...removed, structuredContent: { ok: false, error: { code: 'tool_removed', message: 'Chickpea 5.0 removed inspect_workspace.', nextStep: 'Call get_operation.' } } };
  assert.deepEqual((leaksIn('inspect_workspace', sentOn) as Leak[]).map(({ path, names }) => [path, names]),
    [['structuredContent.error.nextStep', ['get_operation']]], 'a removal answer names its own tool only');
  const refused = { ...removed, structuredContent: { error: { code: 'not_found', message: 'Use inspect_workspace.' } } };
  assert.equal((leaksIn('get_agent', refused) as Leak[]).length, 2, 'any other error is read like a success');

  assert.deepEqual((leaksIn('check_agent', { content: [{ type: 'text', text: 'Run test_connection first.' }] }) as Leak[])
    .map(({ path, names }) => [path, names]), [['content.0.text', ['test_connection']]]);
  assert.deepEqual((leaksIn('get_agent', { code: -32603, message: 'Call get_operation.' }) as Leak[])
    .map(({ path }) => path), ['error.message'], 'a protocol error\'s message is read too');
  assert.deepEqual(leaksIn('get_agent', text({ summary: 'inspect_workspaces and reimport_skill are other words' })), [], 'whole words only');
});
