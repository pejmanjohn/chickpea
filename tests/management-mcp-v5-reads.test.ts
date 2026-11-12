import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import {
  createWorkspaceManagementMcpServer,
  WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES,
  WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES,
} from '../src/management/mcp.ts';
import {
  accountProfileId,
  MCP_ERROR_CODES,
  versionToken,
} from '../src/management/mcp-v5/conventions.ts';
import { agentConnectionsOf } from '../src/management/mcp-v5/reads.ts';
import { changeResultOutput, createAgentInputSchema, updateAgentInputSchema } from '../src/management/mcp-v5/schemas.ts';
import { CARD_URIS } from '../src/management/mcp-v5/cards.ts';
import { FIVE_ZERO_TOOL_NAMES, FIVE_ZERO_TOOLS } from '../src/management/mcp-v5/tools.ts';
import { emitManagementMetric } from '../src/management/telemetry.ts';
import { DEFAULT_AGENT_AVATAR_FILES, DEFAULT_AGENT_AVATAR_NAMES } from '../src/slack/agent-presence/default-avatar-pool.ts';
import type { ManagementReceiptOutboxRecord } from '../src/management/types.ts';
import {
  applyThroughAdapter,
  createFixtureAgent,
  createManagementAdapterFixture,
  ownerMcpContext,
  ownerSlackDmContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { MEMBER_SLACK_USER, slackFacts } from './helpers/management-authority-fixture.ts';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
const SCHEMES = [{ type: 'oauth2', scopes: ['chickpea:workspace'] }];
/** The tools whose result a card draws (tests/mcp-agent-card.test.ts covers why). */
const CARD_TOOLS: Readonly<Record<string, string>> = {
  ...Object.fromEntries([
    'propose_agent', 'propose_agent_change', 'create_agent', 'update_agent', 'undo_change',
    'delete_agent', 'remove_connection', 'remove_website_login', 'delete_schedule', 'remove_model_provider_key', 'update_member',
  ].map((tool) => [tool, CARD_URIS['agent-card']])),
  connect_service: CARD_URIS['connect-card'],
  reconnect_service: CARD_URIS['connect-card'],
  check_agent: CARD_URIS['health-card'],
};
const READ_5 = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
/** The fixture's clock; an older delivered receipt is past retention and swept. */
const NOW = 1_800_000_000_000;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};

async function harness(
  t: TestContext,
  suffix: string,
  as: 'owner' | 'member' = 'owner',
  overrides: Parameters<typeof createManagementAdapterFixture>[1] = {},
) {
  const f = await createManagementAdapterFixture(suffix, overrides);
  t.after(() => f.close());
  if (as === 'member') {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`,
      authenticationSurface: 'better_auth',
      reasonCode: 'mcp_v5_test',
    });
  }
  const person = as === 'owner' ? f.owner : f.admin;
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: person.binding.betterAuthUserId ?? 'ba_owner',
    userId: person.user.id,
    membershipId: person.membership.id,
    organizationId: person.membership.organizationId,
    role: as,
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
    { legacy: 'stateless' },
  );
  const rpc = (method: string, params: Record<string, unknown>, protocol = LEGACY) =>
    mcpCall(handler.fetch, protocol, method, params);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc('tools/call', { name, arguments: args })).result as ToolResult;
  return { f, principal, rpc, call };
}

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  protocol: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  const name = typeof params.name === 'string' ? params.name : undefined;
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': protocol,
      ...(protocol === MODERN ? { 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: protocol === MODERN
        ? {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': protocol,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          }
        : params,
    }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trimStart().startsWith('{')
    ? body
    : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
  return JSON.parse(json);
}

function structured(result: ToolResult): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent, 'the text block carries the same JSON');
  return result.structuredContent;
}

function errorOf(result: ToolResult): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = result.structuredContent?.error;
  assert.ok(error, `a 5.0 error carries structuredContent.error: ${JSON.stringify(result)}`);
  assert.equal(typeof error.message, 'string');
  assert.equal(typeof error.retryable, 'boolean');
  assert.ok(result.content[0]!.text.startsWith(error.message as string));
  return error;
}

async function grantChannel(f: ManagementAdapterFixture, agentId: string, status: 'active' | 'pending' = 'active') {
  await f.config.putChannel({ workspaceId: f.owner.binding.slackTeamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: f.owner.binding.slackTeamId,
    channelId: 'C_SUPPORT',
    agentId,
    status,
    createdByMembershipId: f.owner.membership.id,
  });
}

for (const protocol of [LEGACY, MODERN]) {
  test(`every 5.0 tool states its hints, securitySchemes and outputSchema, after the 4.x tools (${protocol})`, async (t) => {
    const { rpc } = await harness(t, `descriptors-${protocol.slice(0, 4)}`);
    const { tools } = (await rpc('tools/list', {}, protocol)).result as {
      tools: Array<Record<string, unknown> & { name: string; description: string }>;
    };
    assert.deepEqual(tools.map(({ name }) => name), [...WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES, ...FIVE_ZERO_TOOL_NAMES]);
    assert.deepEqual(tools.map(({ name }) => name), WORKSPACE_MANAGEMENT_MCP_TOOL_NAMES);
    for (const tool of tools.filter(({ name }) => (FIVE_ZERO_TOOL_NAMES as readonly string[]).includes(name))) {
      const annotations = tool.annotations as Record<string, unknown>;
      if (annotations.readOnlyHint === false) {
        // A write's hints are pinned tool by tool in management-client-compatibility.
        for (const hint of ['destructiveHint', 'idempotentHint', 'openWorldHint']) {
          assert.equal(typeof annotations[hint], 'boolean', `${tool.name}: ${hint}`);
        }
      } else {
        // check_agent's connection checks send one request each to hosts the workspace configured.
        assert.deepEqual(annotations, tool.name === 'check_agent' ? { ...READ_5, openWorldHint: true } : READ_5, tool.name);
      }
      assert.deepEqual(tool.securitySchemes, SCHEMES, `${tool.name}: descriptor securitySchemes`);
      const meta = tool._meta as Record<string, unknown>;
      assert.deepEqual(meta.securitySchemes, SCHEMES, `${tool.name}: the _meta mirror`);
      assert.equal((tool.outputSchema as { type?: string } | undefined)?.type, 'object', tool.name);
      assert.deepEqual(
        meta.ui,
        ['get_creation_status', 'decline_change', 'get_confirmation'].includes(tool.name) ? { visibility: ['app'] }
          : CARD_TOOLS[tool.name] ? { resourceUri: CARD_TOOLS[tool.name] } : undefined,
        tool.name,
      );
      assert.equal(meta['openai/profile'], tool.name === 'get_account' ? true : undefined, tool.name);
      const words = tool.description.split(/\s+/).length;
      assert.ok(words <= 70, `${tool.name}: ${words} words; keep a description near 60`);
    }
    const profile = tools.find(({ name }) => name === 'get_account')!.outputSchema as Record<string, unknown>;
    assert.deepEqual(Object.keys(profile.properties as object).sort(), ['email', 'id', 'name', 'nickname']);
    assert.deepEqual(profile.required, ['id']);
    assert.equal(profile.additionalProperties, undefined, 'a listed output accepts a field a later release adds');
  });
}

test('a 5.0 description names only tools this server has, and statuses and codes its results carry', () => {
  const known = new Set<string>([...FIVE_ZERO_TOOL_NAMES, ...MCP_ERROR_CODES, ...changeResultOutput.shape.status.options]);
  for (const [name, tool] of Object.entries(FIVE_ZERO_TOOLS)) {
    const unknown = [...tool.description.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map(([word]) => word).filter((word) => !known.has(word));
    assert.deepEqual(unknown, [], `${name} names something no tool, status or code is`);
  }
});

test('the profile id is frozen: one derivation, pinned, never reused across memberships', () => {
  assert.equal(accountProfileId('org_fixed', 'mem_fixed'), 'e28ebb3edf4d8f7b74a5d2a3d6283c0a');
  assert.notEqual(accountProfileId('org_fixed', 'mem_other'), accountProfileId('org_fixed', 'mem_fixed'));
  assert.equal(versionToken('agent', 'agent_a', 3, 'org_fixed'), versionToken('agent', 'agent_a', 3, 'org_fixed'));
  assert.notEqual(versionToken('agent', 'agent_a', 4, 'org_fixed'), versionToken('agent', 'agent_a', 3, 'org_fixed'));
  assert.match(versionToken('agent', 'agent_a', 3, 'org_fixed'), /^[a-f0-9]{16}$/);
});

test('get_account and get_workspace name the person, their workspace and role, and no internal ID', async (t) => {
  const { f, principal, call } = await harness(t, 'account');
  const account = structured(await call('get_account'));
  assert.equal(account.id, accountProfileId(principal.organizationId, principal.membershipId));
  assert.match(account.nickname as string, /\(Owner\)$/);
  assert.deepEqual(Object.keys(account).filter((key) => !['id', 'name', 'nickname', 'email'].includes(key)), []);

  await createFixtureAgent(f, 'agent_research');
  const workspace = structured(await call('get_workspace'));
  assert.deepEqual(workspace.you, { name: 'Owner', role: 'owner' });
  assert.equal(workspace.agentCount, 1);
  assert.equal(workspace.adminUrl, 'https://chickpea.example.test/admin');
  const adminOnly = (workspace.adminOnly as Array<{ what: string }>).map(({ what }) => what);
  assert.ok(adminOnly.includes('Model providers') && adminOnly.includes('Agent pictures'), adminOnly.join(', '));
  assertNoInternalIds(JSON.stringify({ account, workspace }), f);
});

function assertNoInternalIds(serialized: string, f: ManagementAdapterFixture): void {
  for (const forbidden of [
    f.owner.membership.organizationId, f.owner.membership.id, f.owner.user.id,
    f.admin.membership.id, f.admin.user.id, '"revision"', 'configurationGeneration', 'creatorMembershipId',
    'organizationId', 'membershipId', 'effectiveRevision',
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked: ${serialized.slice(0, 400)}`);
}

test('list_agents leaves archived Agents out unless asked, keeps each entry short, and pages inside 20,000 characters', async (t) => {
  const { f, call } = await harness(t, 'list-pages');
  await createFixtureAgent(f, 'agent_long', { name: 'Long', description: `${'A'.repeat(150)}\n\nmore` });
  await createFixtureAgent(f, 'agent_shelved', { name: 'Shelved', lifecycle: 'archived', enabled: false });
  const first = structured(await call('list_agents'));
  assert.deepEqual((first.agents as Array<{ agentId: string }>).map(({ agentId }) => agentId), ['agent_long'], 'archived left out');
  assert.equal((first.agents as Array<{ description: string }>)[0]!.description, `${'A'.repeat(99)}…`, 'one line, cut at 100');
  const all = structured(await call('list_agents', { includeArchived: true }));
  assert.deepEqual((all.agents as Array<{ agentId: string; status: string }>).map(({ agentId, status }) => [agentId, status]),
    [['agent_long', 'on'], ['agent_shelved', 'archived']]);
  // Ninety Agents with the longest descriptions a list keeps: pages that each fit, and every Agent once.
  for (let index = 0; index < 90; index += 1) {
    await createFixtureAgent(f, `agent_many_${String(index).padStart(2, '0')}`, { name: `Many ${index} ${'n'.repeat(40)}`, description: 'd'.repeat(300) });
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const made = await call('list_agents', cursor ? { cursor } : {});
    const size = made.content.map(({ text }) => text).join('').length + JSON.stringify(made.structuredContent).length;
    assert.ok(size <= 20_000, `${size} characters on page ${pages + 1}`);
    const page = structured(made);
    seen.push(...(page.agents as Array<{ agentId: string }>).map(({ agentId }) => agentId));
    cursor = page.nextCursor as string | undefined;
    pages += 1;
  } while (cursor);
  assert.ok(pages >= 2, `${pages} pages`);
  assert.deepEqual(seen.sort(), ['agent_long', ...Array.from({ length: 90 }, (_, index) => `agent_many_${String(index).padStart(2, '0')}`)].sort());
  assert.equal(new Set(seen).size, seen.length, 'no Agent twice');
  const refused = await call('list_agents', { cursor: 'abc' });
  assert.equal(refused.isError, true);
});

test('a list_agents cursor never skips or repeats an Agent when another is archived or created between pages', async (t) => {
  const { f, call } = await harness(t, 'list-stable');
  const ids = Array.from({ length: 50 }, (_, index) => `agent_page_${String(index).padStart(2, '0')}`);
  for (const id of ids) await createFixtureAgent(f, id, { name: `${id} ${'n'.repeat(40)}`, description: 'd'.repeat(300) });
  const listed = (page: Record<string, unknown>) => (page.agents as Array<{ agentId: string }>).map(({ agentId }) => agentId);
  /** Every page, with `between` run once after the first. */
  const read = async (between: () => Promise<unknown>) => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages === 1) await between();
      const page = structured(await call('list_agents', cursor ? { cursor } : {}));
      seen.push(...listed(page));
      cursor = page.nextCursor as string | undefined;
      pages += 1;
    } while (cursor);
    assert.ok(pages >= 2, `${pages} pages`);
    return seen;
  };
  const first = structured(await call('list_agents'));
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(ids.some((id) => (first.nextCursor as string).includes(id)), false, 'the cursor names no Agent in plain text');

  // An Agent on the first page archived before the second: an offset would skip the next page's first Agent.
  const archived = await read(() => f.config.updateAgent('agent_page_00', { lifecycle: 'archived', enabled: false }));
  assert.deepEqual(archived, ids, 'in agentId order, each once, the archived one as the first page listed it');

  // An Agent created ahead of the cursor before the second page: an offset would list one Agent twice.
  const created = await read(() => createFixtureAgent(f, 'agent_new_0'));
  assert.deepEqual(created, ids.slice(1), 'none twice; the new one sorts before the cursor and waits for the next read');
  assert.deepEqual(listed(structured(await call('list_agents'))).slice(0, 2), ['agent_new_0', 'agent_page_01']);

  // A Member's list keeps the Agents they can edit first, then shared ones, which Slack's directory sorts by name:
  // each group in agentId order, and the cursor carries the group, so a page boundary inside either one holds.
  const member = await harness(t, 'list-stable-member', 'member', {
    slackFacts: slackFacts({ C_SUPPORT: { name: 'support', private: false, member: true, archived: false } }, { [MEMBER_SLACK_USER]: ['C_SUPPORT'] }),
  });
  const inSlack = (handle: string) => ({
    slackPresence: {
      requestedHandle: handle, normalizedHandle: handle, desiredState: 'active' as const, health: 'healthy' as const,
      avatar: { kind: 'generated' as const, revision: 1, seed: handle },
    },
  });
  for (const [id, name] of [['agent_b', 'Bravo'], ['agent_d', 'Delta']] as const) {
    await createFixtureAgent(member.f, id, { name, editPolicy: 'all_workspace_members' });
  }
  for (const [id, name] of [['agent_a', 'Zulu'], ['agent_c', 'Alpha']] as const) {
    await createFixtureAgent(member.f, id, { name, ...inSlack(name.toLowerCase()) });
    await grantChannel(member.f, id);
  }
  const memberList = async (after?: string) => (structured(await member.call('list_agents', after === undefined ? {} : {
    cursor: `after1_${Buffer.from(after).toString('base64url')}`,
  })).agents as Array<{ agentId: string; canEdit: boolean }>).map(({ agentId, canEdit }) => [agentId, canEdit]);
  assert.deepEqual(await memberList(), [['agent_b', true], ['agent_d', true], ['agent_a', false], ['agent_c', false]]);
  assert.deepEqual(await memberList('e:agent_b'), [['agent_d', true], ['agent_a', false], ['agent_c', false]]);
  assert.deepEqual(await memberList('e:agent_d'), [['agent_a', false], ['agent_c', false]], 'every shared Agent follows the last one they edit');
  assert.deepEqual(await memberList('s:agent_a'), [['agent_c', false]], 'no Agent they edit follows a shared one, whatever its ID');
  assert.deepEqual(await memberList('s:agent_c'), []);

  // An offset cursor from before is refused, so a list read across an update starts again instead of shifting.
  for (const cursor of ['40', 'after1_', 'after1_%%%', ...['e:Not An Id!', 'agent_page_01', 'x:agent_page_01', 'e:'].map((place) => `after1_${Buffer.from(place).toString('base64url')}`)]) {
    const error = errorOf(await call('list_agents', { cursor }));
    assert.deepEqual([error.code, error.message, error.nextStep], [
      'invalid_input',
      'Chickpea can\'t continue the list from that cursor.',
      'Call list_agents without a cursor to start again from the first page.',
    ], cursor);
  }
});

test('list_agents, get_agent and the other reads carry handles and versions, never revisions', async (t) => {
  const { f, call } = await harness(t, 'reads');
  await createFixtureAgent(f, 'agent_research', { description: 'Finds sources.' });
  await grantChannel(f, 'agent_research');
  const agents = structured(await call('list_agents'));
  const [row, ...others] = agents.agents as Array<Record<string, unknown>>;
  assert.deepEqual(others, []);
  // A list's entry only: get_agent has the links and the whole description.
  assert.deepEqual(row, {
    agentId: 'agent_research',
    name: 'Research',
    handle: 'research',
    description: 'Finds sources.',
    status: 'on',
    canEdit: true,
    needsAttention: [],
  });
  assert.equal(agents.canCreate, true);
  assert.equal(agents.nextCursor, undefined);
  assert.deepEqual(structured(await call('list_agents', { include: 'mine' })).agents, agents.agents);

  const agent = structured(await call('get_agent', { agentId: 'agent_research' }));
  assert.match(agent.version as string, /^[a-f0-9]{16}$/);
  assert.equal(agent.instructions, 'Find and cite sources.');
  assert.deepEqual(agent.channels, [{ channelId: 'C_SUPPORT', name: 'support' }]);
  assert.deepEqual(agent.slack, { presence: 'not_in_slack', ownApp: false, groupDms: 'unknown' });

  const memory = structured(await call('get_agent_memory', { agentId: 'agent_research' }));
  assert.equal(memory.body, '');
  assert.match(memory.version as string, /^[a-f0-9]{16}$/);

  const reads = await Promise.all([
    call('list_services', { search: 'gmail' }),
    call('list_models'),
    call('list_members'),
    call('list_slack_channels'),
    call('list_schedules'),
  ]);
  const [services, models, members, channels, schedules] = reads.map(structured);
  assert.ok((services!.services as Array<{ service: string }>).some(({ service }) => service === 'gmail'));
  assert.equal(services!.count, (services!.services as unknown[]).length);
  assert.ok(Array.isArray(models!.models));
  assert.ok((members!.members as Array<{ role: string }>).some(({ role }) => role === 'owner'));
  assert.deepEqual(channels!.channels, [{
    channelId: 'C_SUPPORT',
    name: 'support',
    settings: { label: 'support', on: true },
    agents: [{ agentId: 'agent_research', name: 'Research', status: 'on' }],
  }]);
  assert.equal(channels!.complete, false, 'no Slack directory in this fixture');
  assert.deepEqual(schedules!.schedules, []);
  assertNoInternalIds(JSON.stringify({ agents, agent, memory, reads }), f);

  const before = agent.version;
  await applyThroughAdapter(f, ownerMcpContext(f), 'rename-research', [{
    itemId: 'rename',
    kind: 'update_agent',
    agentId: 'agent_research',
    expectedRevision: (await f.config.getAgent('agent_research')).revision,
    patch: { description: 'Finds and cites sources.' },
  }]);
  const after = structured(await call('get_agent', { agentId: 'agent_research' }));
  assert.notEqual(after.version, before, 'a change gives a new version');
});

test('propose_agent saves nothing and returns create_agent arguments it accepts, with what to settle', async (t) => {
  const { f, call } = await harness(t, 'propose');
  await createFixtureAgent(f, 'agent_desk', {
    name: 'Desk',
    slackPresence: {
      requestedHandle: 'support',
      normalizedHandle: 'support',
      desiredState: 'active',
      health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'desk' },
    },
  });
  await grantChannel(f, 'agent_desk');
  const agentsBefore = await f.config.listUserAgents();
  const result = structured(await call('propose_agent', {
    name: 'Support Desk',
    handle: '@Support',
    job: 'Answers billing questions from the support Channel.',
    instructions: 'Answer billing questions with links to the invoice.',
    sampleAsk: 'Why was I charged twice?',
    promisedAnswer: 'You were charged once; the second line is a refund.',
    services: ['Gmail', 'Nonexistent Service'],
    channels: ['#support', 'C_UNKNOWN'],
    model: 'nobody/not-a-model',
  })) as {
    proposal: Record<string, unknown>;
    create: { tool: string; arguments: Record<string, unknown> };
    issues: string[];
  };
  assert.deepEqual(await f.config.listUserAgents(), agentsBefore, 'nothing is created');
  assert.equal(result.create.tool, 'create_agent');
  assert.equal(createAgentInputSchema.safeParse(result.create.arguments).success, true);
  const { idempotencyKey, avatar, ...args } = result.create.arguments;
  assert.equal(typeof idempotencyKey, 'string');
  const picture = DEFAULT_AGENT_AVATAR_FILES[DEFAULT_AGENT_AVATAR_NAMES.indexOf(avatar as string)];
  assert.ok(picture, `create.arguments.avatar names a default picture: ${String(avatar)}`);
  assert.equal(result.proposal.avatarUrl, `https://chickpea.example.test/chickpea-avatars/agent-defaults/${picture}`,
    'the proposal shows the picture Create sends');
  assert.deepEqual(args, {
    name: 'Support Desk',
    handle: 'support',
    description: 'Answers billing questions from the support Channel.',
    instructions: 'Answer billing questions with links to the invoice.',
    firstAsk: 'Why was I charged twice?',
    channels: ['C_SUPPORT'],
  });
  assert.equal(result.proposal.handleAvailable, false);
  assert.deepEqual(result.proposal.needs, [{ service: 'gmail', name: 'Gmail', connected: false }]);
  assert.deepEqual(result.proposal.answersIn, [{ channelId: 'C_SUPPORT', name: 'support' }]);
  for (const expected of [/@support already belongs to Desk/, /Nonexistent Service/, /C_UNKNOWN/, /That model isn't one this workspace can use/]) {
    assert.ok(result.issues.some((issue) => expected.test(issue)), `${expected}: ${result.issues.join(' | ')}`);
  }
  // The card draws these issues: they name no tool and no model ID.
  assert.ok(result.issues.every((issue) => !/list_[a-z_]+|not-a-model/.test(issue)), result.issues.join(' | '));
});

test('propose_agent_change previews an edit, says when saving confirms, and refuses a stale version', async (t) => {
  const { f, call } = await harness(t, 'change');
  await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, 'agent_research');
  const { version } = structured(await call('get_agent', { agentId: 'agent_research' })) as { version: string };
  const before = await f.config.getAgent('agent_research');

  const off = structured(await call('propose_agent_change', {
    agentId: 'agent_research',
    version,
    change: { on: false, instructions: '# Rules\nFind and cite two sources.' },
  })) as {
    changes: Array<{ field: string; before?: unknown; after?: unknown; quotes: unknown[] }>;
    save: { tool: string; arguments: Record<string, unknown> };
    needsConfirmation: boolean;
  };
  assert.deepEqual(await f.config.getAgent('agent_research'), before, 'nothing is saved');
  assert.equal(off.needsConfirmation, true, 'turning off an Agent that answers in a Channel confirms');
  assert.deepEqual(off.changes.find(({ field }) => field === 'on'), { field: 'on', before: true, after: false, quotes: [] });
  assert.ok((off.changes.find(({ field }) => field === 'instructions')?.quotes.length ?? 0) > 0);
  assert.equal(off.save.tool, 'update_agent');
  assert.equal(updateAgentInputSchema.safeParse(off.save.arguments).success, true);
  assert.equal(off.save.arguments.version, version);

  const rename = structured(await call('propose_agent_change', {
    agentId: 'agent_research', version, change: { name: 'Researcher' },
  }));
  assert.equal(rename.needsConfirmation, false);
  assert.deepEqual(rename.changes, [{ field: 'name', before: 'Research', after: 'Researcher', quotes: [] }]);

  const stale = errorOf(await call('propose_agent_change', {
    agentId: 'agent_research', version: '0000000000000000', change: { name: 'Researcher' },
  }));
  assert.equal(stale.code, 'changed_since_read');
  assert.equal(stale.retryable, true);
  assert.match(stale.nextStep as string, /get_agent/);
});

test('5.0 errors share one shape, including the SDK\'s input refusals; 4.x errors are unchanged', async (t) => {
  const { call } = await harness(t, 'errors');
  const missing = errorOf(await call('get_agent', { agentId: 'agent_missing' }));
  assert.equal(missing.code, 'not_found');
  assert.equal(missing.retryable, false);
  // A card shows an error's message, so it names no tool and no field; the next step, for the model, does.
  assert.equal(missing.message, 'That Agent is gone, or you can\'t manage it.');
  assert.match(missing.nextStep as string, /list_agents/);

  const refused = errorOf(await call('get_agent', { agentId: 'Not An Id!' }));
  assert.equal(refused.code, 'invalid_input');
  assert.equal(refused.message, 'Chickpea did not accept that request.');
  assert.match(refused.nextStep as string, /^Fix the arguments and call get_agent again\. .*agentId/);

  assert.equal(errorOf(await call('get_agent_memory', { agentId: 'agent_missing' })).code, 'not_found');

  const unknownSetup = errorOf(await call('get_setup_status', { setupToken: 'setup_missing' }));
  assert.equal(unknownSetup.code, 'not_found');

  const legacyRefusal = await call('get_operation', { operationId: '' });
  assert.equal(legacyRefusal.isError, true);
  assert.equal(legacyRefusal.structuredContent, undefined, 'a 4.x refusal keeps its plain text');
  assert.match(legacyRefusal.content[0]!.text, /^Input validation error: /);
});

test('list_members is for Owners and Admins; a member gets not_allowed', async (t) => {
  const { call } = await harness(t, 'member', 'member');
  const refused = errorOf(await call('list_members'));
  assert.equal(refused.code, 'not_allowed');
  const models = structured(await call('list_models'));
  assert.equal(models.providers, undefined, 'a member sees no provider keys');
  assert.equal(models.workspaceDefaults, undefined);
});

// Defect caught: a 5.0 read finding an Agent among the ones a member may use, not the ones they may edit.
test('a member reads only the Agents they may edit: another person\'s Agent is not found', async (t) => {
  const { f, call } = await harness(t, 'member-agents', 'member');
  // In Slack and open to DMs, so the member may use it; only the Owner may edit it.
  await createFixtureAgent(f, 'agent_owner_only', {
    slackPresence: {
      requestedHandle: 'owner-desk',
      normalizedHandle: 'owner-desk',
      desiredState: 'active',
      health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'owner' },
    },
  });
  await grantChannel(f, 'agent_owner_only');
  assert.deepEqual(structured(await call('list_agents')).agents, []);
  for (const [tool, args] of [
    ['get_agent', { agentId: 'agent_owner_only' }],
    ['get_agent_memory', { agentId: 'agent_owner_only' }],
    ['get_creation_status', { agentId: 'agent_owner_only' }],
    ['propose_agent_change', { agentId: 'agent_owner_only', version: '0123456789abcdef', change: { description: 'Mine now.' } }],
  ] as const) {
    assert.equal(errorOf(await call(tool, args)).code, 'not_found', tool);
  }
});

// A setup link's poll reads one Agent's connections alone, so it must see what the snapshot shows, and no more.
test('one Agent\'s connections read alone match the workspace snapshot, and only for an Agent the caller may edit', async (t) => {
  const { f } = await harness(t, 'agent-connections', 'member');
  const teamId = f.owner.user.slackTeamId!;
  const member = {
    userId: f.admin.user.id, membershipId: f.admin.membership.id, organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'agent-connections' },
  } as const;
  await createFixtureAgent(f, 'agent_shared', { editPolicy: 'all_workspace_members' });
  await createFixtureAgent(f, 'agent_owner_only');
  // On each Agent: the team's account, the member's own that needs signing in again, and the Owner's own.
  for (const agentId of ['agent_shared', 'agent_owner_only']) {
    for (const [kind, owner, lifecycle] of [
      ['team', undefined, 'ready'],
      ['mine', f.admin.membership.id, 'needs_attention'],
      ['theirs', f.owner.membership.id, 'ready'],
    ] as const) {
      const id = `connection_${kind}_${agentId}`;
      await f.config.putConnectionAccount({
        id, workspaceId: teamId, ownerKind: owner ? 'member' : 'team', ...owner ? { ownerMembershipId: owner } : {},
        createdByMembershipId: owner ?? f.owner.membership.id, providerId: id, label: id, lifecycle, secretRefId: `secret_${id}`,
        policy: { kind: 'api', allowedHosts: [`${kind}.example`], pathPrefixes: [], headerName: 'Authorization', allowedMethods: ['GET'], authMode: 'credential' },
      } as never, 0);
      await f.config.putAgentConnectionBinding({ agentId, connectionAccountId: id, providerId: id, allowedCapabilities: [], enabled: true });
    }
  }
  const snapshot = (await f.service.inspectWorkspace(member)).agents.find(({ id }) => id === 'agent_shared')!;
  const deps = { service: f.service, context: async () => member };
  const { config, hasFirstAsk, ...alone } = (await agentConnectionsOf(deps, member, 'agent_shared'))!;
  assert.equal(config.id, 'agent_shared', 'the Agent it read, for its picture');
  assert.equal(hasFirstAsk, false, 'an Agent created without a first question');
  assert.deepEqual(alone, {
    mcpServers: snapshot.mcpServers,
    apiConnections: snapshot.apiConnections,
    connectionStatus: snapshot.connectionStatus,
    connections: snapshot.connections,
  });
  assert.deepEqual(alone?.connections?.map(({ id, reconnect }) => [id, Boolean(reconnect)]), [
    ['connection_mine_agent_shared', true], ['connection_team_agent_shared', false],
  ]);
  assert.equal(JSON.stringify(alone).includes('connection_theirs'), false, 'the Owner\'s own account stays theirs');
  assert.equal(await agentConnectionsOf(deps, member, 'agent_owner_only'), undefined, 'not an Agent the member may edit');
  assert.equal(await agentConnectionsOf(deps, member, 'agent_missing'), undefined);

  // An Agent acting for the Owner in Slack reads its own connections only, as its snapshot lists only itself.
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1' });
  const dm = ownerSlackDmContext(f);
  const acting = { ...dm, actingAgentId: 'agent_shared', origin: { ...dm.origin, agentId: 'agent_shared' } };
  const asAgent = { service: f.service, context: async () => acting };
  assert.ok(await agentConnectionsOf(asAgent, acting, 'agent_shared'));
  assert.equal(await agentConnectionsOf(asAgent, acting, 'agent_owner_only'), undefined, 'another Agent, though the Owner may edit it');
});

test('propose_agent refuses a blank name as the caller\'s input, not a server fault', async (t) => {
  const { call } = await harness(t, 'blank-name');
  const refused = errorOf(await call('propose_agent', {
    name: '   ',
    handle: 'desk',
    job: 'Answers billing questions.',
    instructions: 'Answer billing questions.',
    sampleAsk: 'Why was I charged twice?',
  }));
  assert.equal(refused.code, 'invalid_input');
  assert.equal(refused.retryable, false);
});

test('get_creation_status follows the Agent into Slack and its hello in the creator\'s DM', async (t) => {
  const { f, principal, call } = await harness(t, 'creation');
  await createFixtureAgent(f, 'agent_new', {
    slackPresence: {
      requestedHandle: 'new-desk',
      normalizedHandle: 'new-desk',
      desiredState: 'active',
      health: 'pending',
      avatar: { kind: 'generated', revision: 1, seed: 'new' },
    },
  });
  const status = async () => structured(await call('get_creation_status', { agentId: 'agent_new' }));
  assert.deepEqual(await status(), {
    stage: 'joining',
    agent: { name: 'Research', handle: 'new-desk', status: 'on', avatarUrl: 'https://chickpea.example.test/assets/agents/agent_new/avatar/1' },
    channels: 'none',
    slackUrl: `slack://open?team=${f.owner.binding.slackTeamId}`,
  });

  const welcome: ManagementReceiptOutboxRecord = {
    outboxId: 'agent_welcome_op_new',
    operationId: 'op_new',
    destination: { kind: 'initiator_dm', organizationId: principal.organizationId, userId: principal.userId },
    receipt: {
      kind: 'agent_created_welcome',
      creationOperationId: 'op_new',
      agentId: 'agent_new',
      agentName: 'Research',
      requesterMembershipId: principal.membershipId,
      surface: 'direct',
      persona: { name: 'Research' },
    },
    status: 'pending',
    attempts: 0,
    nextAttemptAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
  await f.management.putOutbox(welcome);
  const created = await f.config.getAgent('agent_new');
  await f.config.updateAgent('agent_new', { slackPresence: { ...created.slackPresence!, health: 'healthy' } });
  await grantChannel(f, 'agent_new', 'pending');
  assert.equal((await status()).stage, 'joining', 'the hello is not sent yet');
  assert.equal((await status()).channels, 'joining');

  await f.management.claimDueOutbox(NOW, 1, NOW + 60_000);
  await f.management.settleOutbox({ outboxId: welcome.outboxId, outcome: 'delivered', at: NOW + 1, deliveryRef: 'D1:1.1' });
  assert.equal((await status()).stage, 'said_hello');
  assert.equal((await status()).hello, 'Hi — I’m Research.', 'the card quotes the hello it posted');

  const other = errorOf(await call('get_creation_status', { agentId: 'agent_missing' }));
  assert.equal(other.code, 'not_found', 'an Agent the caller cannot manage reads as missing, as in get_agent');
});

test('5.0 tool names and error codes pass the closed telemetry vocabularies', () => {
  const records: Array<Record<string, unknown>> = [];
  const sink = { info: (record: Record<string, unknown>) => records.push(record) };
  for (const tool of FIVE_ZERO_TOOL_NAMES) emitManagementMetric('tool.call', { tool }, sink);
  for (const reason of MCP_ERROR_CODES) emitManagementMetric('tool.call', { reason }, sink);
  assert.deepEqual(records.map((record) => record.tool ?? record.reason), [...FIVE_ZERO_TOOL_NAMES, ...MCP_ERROR_CODES]);
});
