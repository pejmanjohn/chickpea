import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import { parseTestTurnInitialData } from '../src/agents/test-turn.ts';
import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { BUGSNAG_MCP_SERVER_URL } from '../src/config/bugsnag-policy.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import {
  getTestRun,
  TEST_RUN_NOTE,
  TEST_RUN_WAIT_MS,
  testRunMessage,
  TRY_AGENT_ONCE_RETURNS_BY_MS,
  tryAgentOnce,
} from '../src/management/mcp-v5/test-runs.ts';
import { FIVE_ZERO_TOOLS } from '../src/management/mcp-v5/tools.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import { TEST_RUN_DAILY_RUNS, TEST_RUN_VISIBLE_MS } from '../src/management/test-runs.ts';
import { hostedInstallation } from './helpers/installation-objects.ts';
import {
  createManagementAdapterFixture,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { FakeTestRunInstances, TestClock, testRunLifecycle } from './helpers/test-runs.ts';

const LEGACY = '2025-11-25';
const BASE_URL = 'https://chickpea.example.test';
const ASK = 'Which tickets are waiting on me?';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};

interface Options {
  /** No test runs: Node, or a standalone Cloudflare deployment. */
  unserved?: true;
  unready?: readonly string[];
  /** Call as the Admin, demoted to a member. */
  asMember?: true;
  /** What Slack says of each Channel. */
  slackChannels?: Record<string, { name: string; private: boolean }>;
}

async function harness(t: TestContext, suffix: string, options: Options = {}) {
  const installation = hostedInstallation(`inst_tools_${suffix}`);
  const instances = new FakeTestRunInstances();
  const clock = new TestClock(Date.now());
  // The fixture's service compiles plans for an unscoped instance, as a single installation's store would run them.
  const lifecycle = testRunLifecycle(installation, instances, clock, { platformEnv: undefined });
  const f = await createManagementAdapterFixture(suffix, ({ settings }): Partial<WorkspaceManagementServiceInput> => ({
    settings,
    modelReadiness: async () => async (model) =>
      options.unready?.includes(model) ? { unavailable: 'credential_missing' } : undefined,
    slackMemberTimezone: async () => 'Europe/Paris',
    ...(options.unserved ? {} : { testRuns: lifecycle }),
    ...(options.slackChannels ? {
      slackFacts: async () => ({
        async lookupChannel(channelId: string) {
          const channel = options.slackChannels![channelId];
          if (!channel) throw new Error(`channel_not_found:${channelId}`);
          return { id: channelId, ...channel, member: true, archived: false };
        },
        async listMemberChannels() {
          return new Set(Object.keys(options.slackChannels!));
        },
      }),
    } : {}),
  }));
  t.after(() => f.close());
  const teamId = f.owner.binding.slackTeamId;
  await f.config.ensureWorkspaceInstallation({
    workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1',
  });
  if (options.asMember) {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id, role: 'member', actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`, authenticationSurface: 'better_auth', reasonCode: 'test_run_tools',
    });
  }
  const callAs = (person: typeof f.owner) => {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: person.binding.betterAuthUserId ?? `ba_${suffix}`, userId: person.user.id,
      membershipId: person.membership.id, organizationId: person.membership.organizationId,
      role: person === f.owner ? 'owner' : options.asMember ? 'member' : 'admin', clientId: `client_${suffix}`,
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: BASE_URL }),
      { legacy: 'stateless' },
    );
    return async (name: string, args: Record<string, unknown>) => {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': LEGACY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      const body = await response.text();
      const json = body.trimStart().startsWith('{')
        ? body
        : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return (JSON.parse(json) as { result: ToolResult }).result;
    };
  };
  const deps = (person: typeof f.owner) => ({
    service: f.service,
    context: async () => ({
      userId: person.user.id, membershipId: person.membership.id, organizationId: person.membership.organizationId,
      origin: { kind: 'mcp' as const, clientId: `client_${suffix}` },
    }),
    baseUrl: BASE_URL,
  });
  return { f, teamId, installation, instances, clock, lifecycle, call: callAs(f.owner), callAs, deps };
}

/** An Agent the owner created, with a stored first ask, in no Channel: only its creator may DM it. */
async function seedAgent(f: ManagementAdapterFixture, extra: Record<string, unknown> = {}, firstAsk: string | null = ASK) {
  return f.config.createAgent({
    id: 'agent_tested', name: 'Ops', instructions: 'Keep the support queue moving.', enabled: true, lifecycle: 'active',
    creatorMembershipId: f.owner.membership.id, editPolicy: 'creator_and_admins', configurationGeneration: 1,
    model: 'local-stub/ops', skills: [], mcpServers: [], apiConnections: [], repositories: [], ...extra,
  } as never, undefined, firstAsk ?? undefined);
}

function structured(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function errorOf(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.structuredContent!.error!;
}

test('try_agent_once and get_test_run are card-only, with U2\'s hints, and the description promises reads, not "posts nothing"', () => {
  const tryOnce = FIVE_ZERO_TOOLS.try_agent_once;
  assert.deepEqual(tryOnce.visibility, ['app']);
  assert.deepEqual(FIVE_ZERO_TOOLS.get_test_run.visibility, ['app']);
  assert.deepEqual(tryOnce.write, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  assert.equal(FIVE_ZERO_TOOLS.get_test_run.write, undefined, 'get_test_run reads only');
  assert.match(tryOnce.description, /Runs it once, read-only: it makes only read requests and sends nothing to Slack\./);
  assert.doesNotMatch(tryOnce.description, /posts nothing/i);
  assert.match(TEST_RUN_NOTE, /read-only\. It makes only read requests and sends nothing to Slack\./);
});

test('try_agent_once runs the stored first ask once, as the caller, and answers with what it read', async (t) => {
  const { f, call, instances, installation } = await harness(t, 'answer');
  await seedAgent(f);
  instances.settleEvery = { kind: 'answered', reply: 'Two tickets: **#41** and **#42**.', read: ['Zendesk'] };
  const result = await call('try_agent_once', { agentId: 'agent_tested', idempotencyKey: 'key_answer' });
  const run = structured(result);
  assert.deepEqual({ ...run, runToken: typeof run.runToken }, {
    status: 'answered', runToken: 'string', ask: ASK, reply: 'Two tickets: **#41** and **#42**.', read: ['Zendesk'], note: TEST_RUN_NOTE,
  });
  assert.equal(JSON.parse(result.content[0]!.text).note, TEST_RUN_NOTE, 'a client without the card reads the same');

  // Dispatched as a plain message, the ask escaped as Slack user text is, with the caller's framing facts.
  const [dispatch] = instances.dispatched;
  assert.equal(dispatch!.message, ASK);
  const data = parseTestTurnInitialData(dispatch!.initialData);
  assert.equal(data.runtimePlan.conversation.surface, 'test');
  assert.equal(data.runtimePlan.actorMembershipId, f.owner.membership.id);
  assert.equal(data.requester.timezone, 'Europe/Paris');
  const row = installation.stores.testRuns.unerased()[0] ?? installation.db.get('SELECT 1') as never;
  assert.ok(row);
  // Its usage operation is a test_turn for the caller, in the test agent's DM shape.
  const operation = installation.db.get("SELECT operation_kind, conversation_kind, requester_membership_id, profile_id, status FROM usage_operations") as Record<string, unknown>;
  assert.deepEqual(operation, {
    operation_kind: 'test_turn', conversation_kind: 'direct_message', requester_membership_id: f.owner.membership.id, profile_id: 'agent_tested',
    status: 'completed',
  }, 'its terminal is written on the clock its admission was');
  // The same key returns the same run.
  const again = structured(await call('try_agent_once', { agentId: 'agent_tested', idempotencyKey: 'key_answer' }));
  assert.equal(again.runToken, run.runToken);
  assert.equal(instances.dispatched.length, 1);
  // get_test_run reads it back.
  assert.deepEqual(structured(await call('get_test_run', { runToken: run.runToken })), run);
});

const api = (host: string) => ({
  kind: 'api' as const, allowedHosts: [host], pathPrefixes: ['/api/'], headerName: 'Authorization',
  allowedMethods: ['GET' as const], authMode: 'credential' as const,
});

async function connect(
  f: ManagementAdapterFixture,
  teamId: string,
  agentId: string,
  account: Record<string, unknown> & { id: string; providerId: string },
) {
  await f.config.putConnectionAccount({
    ownerKind: 'team', workspaceId: teamId, createdByMembershipId: f.owner.membership.id, secretRefId: `secret_${account.id}`,
    lifecycle: 'ready', ...account,
  } as never, 0);
  await f.config.putAgentConnectionBinding({
    agentId, connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
  });
}

test('Node and a standalone deployment have no test runs, which no retry changes', async (t) => {
  const { f, call } = await harness(t, 'unserved', { unserved: true });
  await seedAgent(f);
  for (const [tool, args] of [['try_agent_once', { agentId: 'agent_tested', idempotencyKey: 'k' }], ['get_test_run', { runToken: 'tr_x' }]] as const) {
    const error = errorOf(await call(tool, args));
    assert.deepEqual([error.code, error.message, error.retryable],
      ['test_run_unavailable', 'Test runs aren\'t available on this workspace yet.', false]);
  }
});

test('try_agent_once refuses before a run starts, each with its own words and fix', async (t) => {
  const { f, teamId, call, instances } = await harness(t, 'refusals', { unready: ['local-stub/slow'] });
  const refusal = async (agentId: string) =>
    errorOf(await call('try_agent_once', { agentId, idempotencyKey: `key_${agentId}` }));

  await seedAgent(f, { id: 'agent_unasked' }, null);
  let error = await refusal('agent_unasked');
  assert.deepEqual([error.code, error.message], ['not_found', 'Ops has no saved first question to test.']);

  // Chickpea's own Agent is no Agent the caller manages, as the workspace snapshot never lists it.
  await f.config.materializeChickpeaAgent();
  error = await refusal('agent_chickpea');
  assert.deepEqual([error.code, error.message], ['not_found', 'That Agent is gone, or you can\'t change it.']);

  // A card's Agent deleted since it was drawn: the person's words, not the model's.
  await seedAgentWithId(f, 'agent_deleted');
  assert.equal(await f.config.deleteAgent('agent_deleted'), true);
  error = await refusal('agent_deleted');
  assert.deepEqual([error.code, error.message, error.nextStep],
    ['not_found', 'That Agent is gone, or you can\'t change it.', 'Call list_agents for the current agentIds.'], 'the model\'s next step is kept');

  await seedAgent(f, { id: 'agent_off', enabled: false });
  error = await refusal('agent_off');
  assert.deepEqual([error.code, error.message], ['not_allowed', 'You can\'t message Ops in Slack yet, so it can\'t be tested as you.']);

  await seedAgent(f, { id: 'agent_slow', model: 'local-stub/slow' });
  error = await refusal('agent_slow');
  assert.equal(error.code, 'model_unavailable');
  assert.match(String(error.message), /^Ops can't run right now\. Its provider, local-stub, is not set up\./);

  // A personal connection the caller has not signed in to yet.
  await seedAgent(f, { id: 'agent_personal' });
  await connect(f, teamId, 'agent_personal', {
    id: 'connection_personal', providerId: 'linear', label: 'Linear', policy: api('api.linear.app'),
    ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
  });
  error = await refusal('agent_personal');
  assert.deepEqual([error.code, error.message], ['needs_setup', 'Finish setting up Linear first, then try again.']);
  assert.ok(error.fix, 'with a way to finish it');

  // An MCP server none of whose tools an Admin declared a read, though the server hints one reads.
  await seedAgent(f, { id: 'agent_docs' });
  await connect(f, teamId, 'agent_docs', {
    id: 'connection_docs', providerId: 'docs', label: 'Docs MCP',
    policy: {
      kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [],
      allowedTools: ['search'], discoveredTools: [{ name: 'search', description: 'Search the docs.', annotations: { readOnlyHint: true } }],
    },
  });
  error = await refusal('agent_docs');
  assert.deepEqual([error.code, error.message], ['not_testable',
    'None of Docs MCP\'s tools are marked as reads, so a test run can\'t use it. Mark the tools that only read as reads, then try again.']);
  assert.deepEqual(error.fix, {
    label: 'Mark Docs MCP\'s read tools', tool: 'update_connection', arguments: { agentId: 'agent_docs', connectionId: 'docs' },
  }, 'the fix is a 5.0 call that names the connection, never Admin, whose tool editor cannot mark a read');
  assert.match(String(error.nextStep), /update_connection with those in changes\.readTools/);
  assert.match(String(error.nextStep), /only when the person confirms it only reads; never from its name alone/);
  assert.deepEqual(instances.dispatched, [], 'nothing was dispatched');
});

const docsMcp = (extra: Record<string, unknown> = {}) => ({
  kind: 'mcp', url: 'https://mcp.docs.example/mcp', transport: 'streamable-http', authMode: 'bearer', headerNames: [],
  allowedTools: ['search', 'delete_page'],
  discoveredTools: [{ name: 'search', annotations: { readOnlyHint: true } }, { name: 'delete_page' }],
  ...extra,
});

test('not_testable\'s fix leads somewhere: update_connection marks the read, and the run goes ahead with that tool alone', async (t) => {
  const { f, teamId, call, instances } = await harness(t, 'mark_reads');
  await seedAgent(f);
  await connect(f, teamId, 'agent_tested', { id: 'connection_docs', providerId: 'docs', label: 'Docs MCP', policy: docsMcp() });
  const refused = errorOf(await call('try_agent_once', { agentId: 'agent_tested', idempotencyKey: 'key_before' }));
  assert.equal(refused.code, 'not_testable');
  const fix = refused.fix as { tool: string; arguments: Record<string, unknown> };
  const { version } = structured(await call('get_agent', { agentId: 'agent_tested' })) as { version: string };
  const marked = structured(await call(fix.tool, {
    ...fix.arguments, version, changes: { readTools: ['search'], writeTools: ['delete_page'] }, idempotencyKey: 'mark',
  }));
  assert.equal(marked.status, 'done');
  instances.settleEvery = { kind: 'answered', reply: 'Found it.', read: ['Docs MCP'] };
  const run = structured(await call('try_agent_once', { agentId: 'agent_tested', idempotencyKey: 'key_after' }));
  assert.equal(run.status, 'answered');
  const plan = parseTestTurnInitialData(instances.dispatched[0]!.initialData).runtimePlan;
  assert.deepEqual(plan.mcpConnections.map(({ allowedTools }) => allowedTools), [['search']], 'only the marked read is mounted');

  // A ready connection that allows no tools has none to mark, and get_agent names none to allow: Admin chooses them.
  await seedAgent(f, { id: 'agent_no_tools' });
  await connect(f, teamId, 'agent_no_tools', {
    id: 'connection_no_tools', providerId: 'empty_docs', label: 'Empty Docs', policy: docsMcp({ allowedTools: [] }),
  });
  const empty = errorOf(await call('try_agent_once', { agentId: 'agent_no_tools', idempotencyKey: 'key_no_tools' }));
  assert.deepEqual([empty.code, empty.message, empty.fix], ['not_testable',
    'Empty Docs allows no tools yet, so a test run can\'t use it. Choose its tools on the Agent\'s page in Admin, then mark the ones that only read.',
    { label: 'Choose its tools in Admin', url: `${BASE_URL}/admin/agents/agent_no_tools` }]);
  assert.equal(instances.dispatched.length, 1, 'nothing more was dispatched');
});

test('only someone who may change a connection is offered its fix, as in Admin; a catalog MCP service gets none', async (t) => {
  const { f, teamId, callAs, instances } = await harness(t, 'mark_authority', { asMember: true });
  // The member created both Agents, so they may change them and DM them.
  const mine = { creatorMembershipId: f.admin.membership.id };
  await seedAgent(f, { id: 'agent_team', ...mine });
  await connect(f, teamId, 'agent_team', { id: 'connection_team_docs', providerId: 'docs', label: 'Docs MCP', policy: docsMcp() });
  const member = callAs(f.admin);
  let error = errorOf(await member('try_agent_once', { agentId: 'agent_team', idempotencyKey: 'key_team' }));
  assert.deepEqual([error.code, error.message, error.fix], ['not_testable',
    'None of Docs MCP\'s tools are marked as reads, so a test run can\'t use it. An Owner or Admin can mark the tools that only read as reads.',
    undefined]);
  const { version } = structured(await member('get_agent', { agentId: 'agent_team' })) as { version: string };
  error = errorOf(await member('update_connection', {
    agentId: 'agent_team', connectionId: 'docs', version, changes: { readTools: ['search'] }, idempotencyKey: 'member-marks-team',
  }));
  assert.equal(error.code, 'not_allowed', 'a member cannot mark a team connection\'s reads, as Admin refuses them');

  // Their own personal connection is theirs to mark.
  await seedAgent(f, { id: 'agent_personal', ...mine });
  await connect(f, teamId, 'agent_personal', {
    id: 'connection_own_docs', providerId: 'own_docs', label: 'My Docs', policy: docsMcp(),
    ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
  });
  error = errorOf(await member('try_agent_once', { agentId: 'agent_personal', idempotencyKey: 'key_personal' }));
  assert.equal((error.fix as { tool?: string } | undefined)?.tool, 'update_connection');
  const own = structured(await member('get_agent', { agentId: 'agent_personal' })) as { version: string };
  assert.equal(structured(await member('update_connection', {
    agentId: 'agent_personal', connectionId: 'own_docs', version: own.version, changes: { readTools: ['search'] }, idempotencyKey: 'mine',
  })).status, 'done');

  // A reviewed connector added by URL is chosen in Admin, and update_connection refuses it, so no fix points there.
  await seedAgent(f, { id: 'agent_bugsnag', ...mine });
  await connect(f, teamId, 'agent_bugsnag', {
    id: 'connection_own_bugsnag', providerId: 'bugsnag', label: 'Bugsnag',
    ownerKind: 'member', ownerMembershipId: f.admin.membership.id,
    policy: docsMcp({
      url: BUGSNAG_MCP_SERVER_URL, toolAccessMode: 'review', allowedTools: ['bugsnag_update_error'],
      discoveredTools: [{ name: 'bugsnag_update_error' }],
    }),
  });
  error = errorOf(await member('try_agent_once', { agentId: 'agent_bugsnag', idempotencyKey: 'key_bugsnag' }));
  // Its fix says what to do; the card says to try again after it, so no "ask in Slack" sits above that.
  assert.deepEqual([error.message, error.fix], ['None of Bugsnag\'s tools are marked as reads, so a test run can\'t use it.',
    { label: 'Open the Agent in Admin', url: 'https://chickpea.example.test/admin/agents/agent_bugsnag' }]);
  const bugsnag = structured(await member('get_agent', { agentId: 'agent_bugsnag' })) as { version: string };
  error = errorOf(await member('update_connection', {
    agentId: 'agent_bugsnag', connectionId: 'bugsnag', version: bugsnag.version,
    changes: { readTools: ['bugsnag_update_error'] }, idempotencyKey: 'mark-bugsnag',
  }));
  assert.equal(error.code, 'invalid_input', 'update_connection refuses a reviewed connector, as the fix would have led to');
  const stored = (await f.config.listConnectionAccounts(teamId)).find(({ id }) => id === 'connection_own_bugsnag');
  assert.equal(stored?.policy.kind === 'mcp' ? stored.policy.toolPolicies : null, undefined, 'and writes nothing');

  // Neither Admin nor update_connection marks a catalog MCP service's tools, so no fix points anywhere.
  await seedAgent(f, { id: 'agent_linear', ...mine });
  await connect(f, teamId, 'agent_linear', {
    id: 'connection_linear', providerId: 'linear', label: 'Linear',
    policy: docsMcp({ url: 'https://mcp.linear.app/mcp', presetId: 'linear', authMode: 'oauth', allowedTools: ['list_issues'], discoveredTools: [{ name: 'list_issues' }] }),
  });
  error = errorOf(await member('try_agent_once', { agentId: 'agent_linear', idempotencyKey: 'key_linear' }));
  assert.deepEqual([error.message, error.fix], [
    'None of Linear\'s tools are marked as reads, so a test run can\'t use it. Ask Ops in Slack instead.', undefined]);
  assert.deepEqual(instances.dispatched, []);
});

test('a personal connection the caller has signed in to is no reason to refuse', async (t) => {
  const { f, teamId, deps, instances, clock } = await harness(t, 'personal_ready');
  await seedAgent(f);
  await connect(f, teamId, 'agent_tested', {
    id: 'connection_mine', providerId: 'linear', label: 'Linear', policy: api('api.linear.app'),
    ownerKind: 'member', ownerMembershipId: f.owner.membership.id,
  });
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: ['Linear'] };
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const run = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_mine' }, timing);
  assert.deepEqual([run.status, run.read], ['answered', ['Linear']]);
});

test('a caller who can no longer change the Agent no longer reads its run', async (t) => {
  const { f, teamId, deps, instances, clock } = await harness(t, 'lost_edit', {
    slackChannels: { C_SUPPORT: { name: 'support', private: false } },
  });
  await seedAgent(f);
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_tested', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: false,
  });
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: [] };
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const run = await tryAgentOnce(deps(f.admin), { agentId: 'agent_tested', idempotencyKey: 'key_admin' }, timing);
  assert.equal(run.status, 'answered', 'an Admin may change it, and the Channel lets them message it');
  assert.equal((await getTestRun(deps(f.admin), { runToken: run.runToken }, timing)).status, 'answered');
  await f.identity.updateMembershipAuthority({
    membershipId: f.admin.membership.id, role: 'member', actorMembershipId: f.owner.membership.id,
    correlationId: 'lost-edit-demotion', authenticationSurface: 'better_auth', reasonCode: 'test_run_tools',
  });
  await assert.rejects(getTestRun(deps(f.admin), { runToken: run.runToken }, timing),
    (error: { error?: { code?: string; message?: string } }) =>
      error.error?.code === 'not_found' && error.error.message === 'This test run has expired.');
});

test('one run at a time, ten a day, and a key names one run', async (t) => {
  const { f, deps, instances, clock, installation } = await harness(t, 'limits');
  await seedAgent(f);
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const tryOnce = (idempotencyKey: string, agentId = 'agent_tested') =>
    tryAgentOnce(deps(f.owner), { agentId, idempotencyKey }, timing);
  const refused = (code: string, message?: RegExp) => (error: { error?: { code?: string; message?: string; retryable?: boolean } }) =>
    error.error?.code === code && (!message || message.test(error.error.message ?? ''));
  const first = await tryOnce('key_first');
  assert.equal(first.status, 'running');
  await assert.rejects(tryOnce('key_second'),
    refused('in_progress', /^Another test run is going in this workspace\. Try again in a minute\.$/));
  // Finished but never read again: the next start settles it rather than wait for the alarm.
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: [] };
  for (let run = 1; run < TEST_RUN_DAILY_RUNS; run += 1) assert.equal((await tryOnce(`key_${run}`)).status, 'answered');
  await assert.rejects(tryOnce('key_eleventh'),
    refused('usage_limit', /^Test runs for this workspace have reached today's limit\. They start again in about \d+ hours?\.$/));
  // A replay of a run already started is no new run, whatever the limits say.
  assert.equal((await tryOnce('key_first')).runToken, first.runToken);
  // The same key for another Agent is refused.
  await seedAgentWithId(f, 'agent_other');
  await assert.rejects(tryOnce('key_first', 'agent_other'), refused('key_reused'));
  assert.equal(Number(installation.db.get('SELECT COUNT(*) AS n FROM management_test_runs')?.n), TEST_RUN_DAILY_RUNS);
});

async function seedAgentWithId(f: ManagementAdapterFixture, id: string) {
  return f.config.createAgent({
    id, name: 'Other', instructions: 'Help.', enabled: true, lifecycle: 'active', creatorMembershipId: f.owner.membership.id,
    editPolicy: 'creator_and_admins', configurationGeneration: 1, model: 'local-stub/ops', skills: [], mcpServers: [],
    apiConnections: [], repositories: [],
  } as never, undefined, ASK);
}

test('a member who can use an Agent but not change it is told so; one who cannot use it reads not found', async (t) => {
  const { f, teamId, callAs } = await harness(t, 'member', {
    asMember: true, slackChannels: { C_SUPPORT: { name: 'support', private: false } },
  });
  await seedAgent(f);
  const tryAsMember = async (agentId: string) =>
    errorOf(await callAs(f.admin)('try_agent_once', { agentId, idempotencyKey: `key_${agentId}` }));
  let error = await tryAsMember('agent_tested');
  assert.deepEqual([error.code, error.message], ['not_found', 'That Agent is gone, or you can\'t change it.'],
    'in no Channel, only its creator may use it');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_tested', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: false,
  });
  error = await tryAsMember('agent_tested');
  assert.deepEqual([error.code, error.message], ['not_allowed', 'Only someone who can change Ops can test it.']);
});

test('try_agent_once returns running 15 seconds after the call starts, a slow admission included; get_test_run waits 20', async (t) => {
  const { f, deps, instances, clock } = await harness(t, 'waits');
  await seedAgent(f);
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  // Admission takes 6 seconds, as it did on a busy workspace.
  const testRunStore = f.service.testRunStore.bind(f.service);
  f.service.testRunStore = async (context) => {
    clock.advance(6_000);
    return testRunStore(context);
  };
  const calledAt = clock.now();
  const running = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_wait' }, timing);
  assert.equal(running.status, 'running');
  const returnedAfter = clock.now() - calledAt;
  assert.equal(TRY_AGENT_ONCE_RETURNS_BY_MS, 15_000);
  assert.ok(returnedAfter <= 15_000 && returnedAfter > 13_000, `it returned ${returnedAfter} ms after the call started`);
  // A retry of the same key waits for the run only until 15 seconds after it was called, too.
  const retriedAt = clock.now();
  const replayed = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_wait' }, timing);
  assert.deepEqual([replayed.status, replayed.runToken], ['running', running.runToken]);
  const replayedAfter = clock.now() - retriedAt;
  assert.ok(replayedAfter <= 15_000 && replayedAfter > 13_000, `the retry returned ${replayedAfter} ms after it was called`);
  f.service.testRunStore = testRunStore;
  const polledAt = clock.now();
  const still = await getTestRun(deps(f.owner), { runToken: running.runToken }, timing);
  assert.equal(still.status, 'running');
  assert.ok(clock.now() - polledAt > TEST_RUN_WAIT_MS - 2_000, 'get_test_run waited about 20 seconds');
  instances.settleEvery = { kind: 'answered', reply: 'Here it is.', read: ['Zendesk'] };
  const answered = await getTestRun(deps(f.owner), { runToken: running.runToken }, timing);
  assert.deepEqual([answered.status, answered.reply, answered.read], ['answered', 'Here it is.', ['Zendesk']]);
});

test('admission reads the tested Agent alone: never the workspace snapshot, nor any other Agent', async (t) => {
  const { f, deps, instances, clock } = await harness(t, 'scoped');
  await seedAgent(f);
  for (let index = 0; index < 25; index += 1) await seedAgentWithId(f, `agent_other_${index}`);
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: [] };
  let snapshots = 0;
  const inspect = f.service.inspectWorkspace.bind(f.service);
  f.service.inspectWorkspace = async (context) => {
    snapshots += 1;
    return inspect(context);
  };
  const perAgent: string[] = [];
  for (const method of ['listAgentConnectionBindings', 'getAgentModelRole'] as const) {
    const original = f.config[method].bind(f.config) as (...args: unknown[]) => unknown;
    (f.config as unknown as Record<string, unknown>)[method] = (agentId: string, ...rest: unknown[]) => {
      perAgent.push(`${method}:${agentId}`);
      return original(agentId, ...rest);
    };
  }
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const run = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_scoped' }, timing);
  assert.equal(run.status, 'answered');
  assert.equal(snapshots, 0);
  assert.deepEqual(perAgent.filter((call) => !call.endsWith(':agent_tested')), [], 'no other Agent was read');
});

test('get_test_run reads only the caller\'s own run, and not after an hour', async (t) => {
  const { f, deps, instances, clock } = await harness(t, 'caller_only');
  await seedAgent(f);
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: [] };
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const run = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_mine' }, timing);
  await assert.rejects(getTestRun(deps(f.admin), { runToken: run.runToken }, timing),
    (error: { error?: { code?: string; message?: string } }) =>
      error.error?.code === 'not_found' && error.error.message === 'This test run has expired.');
  clock.advance(TEST_RUN_VISIBLE_MS);
  const expired = (error: { error?: { code?: string; message?: string } }) =>
    error.error?.code === 'not_found' && error.error.message === 'This test run has expired.';
  await assert.rejects(getTestRun(deps(f.owner), { runToken: run.runToken }, timing), expired);
  // The same key past the hour neither returns the old run nor starts a new one.
  await assert.rejects(tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_mine' }, timing), expired);
  assert.equal(instances.dispatched.length, 1);
});

test('get_test_run reads only a lost Agent as expired; any other failure is reported as it is', async (t) => {
  const { f, deps, instances, clock } = await harness(t, 'reader_failure');
  await seedAgent(f);
  instances.settleEvery = { kind: 'answered', reply: 'Done.', read: [] };
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const run = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: 'key_reader' }, timing);
  const failing = deps(f.owner);
  const service = Object.create(f.service) as typeof f.service;
  service.agentReader = async () => { throw new Error('The config store did not answer.'); };
  await assert.rejects(getTestRun({ ...failing, service }, { runToken: run.runToken }, timing), /did not answer/);
});

test('a failed run says why, in the caller\'s words', async (t) => {
  const { f, deps, instances, clock } = await harness(t, 'failures');
  await seedAgent(f);
  const timing = { now: () => clock.now(), sleep: async (ms: number) => clock.advance(ms) };
  const cases = [
    [{ kind: 'failed', failure: 'deadline', creditBack: 'timeout' }, 'The test run took too long and was stopped. Ask Ops in Slack instead.'],
    [{ kind: 'failed', failure: 'out_of_usage', creditBack: null }, 'This workspace is out of usage, so the test run couldn\'t finish.'],
    [{ kind: 'failed', failure: 'daily_limit', resumesAt: clock.now() + 7_000_000, creditBack: null },
      'Test runs for this workspace have reached today\'s limit. They start again in about 2 hours.'],
    [{ kind: 'failed', failure: 'failed', creditBack: 'chickpea' }, 'The test run didn\'t finish. Ask Ops in Slack instead.'],
    [{ kind: 'not_found' }, 'The test run didn\'t finish. Ask Ops in Slack instead.'],
  ] as const;
  for (const [index, [settlement, problem]] of cases.entries()) {
    instances.settleEvery = settlement as never;
    const run = await tryAgentOnce(deps(f.owner), { agentId: 'agent_tested', idempotencyKey: `key_fail_${index}` }, timing);
    assert.deepEqual([run.status, run.problem, run.reply], ['failed', problem, undefined]);
  }
});

test('the ask is sent as a person\'s text: Slack\'s control characters escaped', () => {
  assert.equal(testRunMessage('Is <@U123> & co > 3?'), 'Is &lt;@U123&gt; &amp; co &gt; 3?');
});
