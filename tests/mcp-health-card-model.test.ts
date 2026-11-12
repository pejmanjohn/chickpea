import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { ConnectionCheckOutcome } from '../src/connections/connection-check.ts';
import { ManagementError } from '../src/management/types.ts';
import { buttonCount, type ToolResult } from '../src/mcp-cards/card-model.ts';
import { INITIAL, present, step, type Action } from '../src/mcp-cards/health-card/model.ts';
import { createFixtureAgent, type ManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { assertPlain, BASE_URL, cardHost, cardServer } from './helpers/mcp-card-host.ts';

/**
 * The health card's state machine against Core's real MCP server. By itself
 * it may only read the Agent: check_agent sends a request to each custom
 * connection, so it, like every fix, waits for a press.
 */
const HEALTH_CARD = { initial: INITIAL, step, present, reads: new Set(['get_agent']) };

async function harness(t: TestContext, suffix: string, checks: Record<string, ConnectionCheckOutcome | Error> = {}) {
  const tested: string[] = [];
  const server = await cardServer(t, suffix, {
    modelReadiness: async () => async () => undefined,
    testConnection: async ({ connectionId }) => {
      tested.push(connectionId);
      const outcome = checks[connectionId];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { kind: 'ok', url: 'https://acme.zendesk.com/api/v2/users/me', status: 200 };
    },
  });
  await server.f.config.ensureWorkspaceInstallation({
    workspaceId: server.teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1',
  });
  return { ...server, tested, card: () => cardHost(HEALTH_CARD, server.call, server.clock) };
}

/** An Agent in a public Channel with a team API connection that works, one that needs reconnecting, and a custom MCP server. */
async function seedOps(f: ManagementAdapterFixture, teamId: string) {
  await createFixtureAgent(f, 'agent_ops', {
    name: 'Ops',
    model: 'local-stub/ops',
    slackPresence: { requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'ops' } },
  });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_ops', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support', channelIsPrivate: false,
  });
  const api = (host: string) => ({
    kind: 'api' as const, allowedHosts: [host], pathPrefixes: ['/api/'], headerName: 'Authorization',
    allowedMethods: ['GET' as const], authMode: 'credential' as const,
  });
  const accounts = [
    { id: 'connection_zendesk', providerId: 'zendesk', label: 'Zendesk', policy: api('acme.zendesk.com'), lifecycle: 'ready' as const },
    { id: 'connection_linear', providerId: 'linear', label: 'Linear', policy: api('api.linear.app'), lifecycle: 'needs_attention' as const },
    {
      id: 'connection_docs', providerId: 'docs', label: 'Docs MCP', lifecycle: 'ready' as const,
      policy: {
        kind: 'mcp' as const, url: 'https://mcp.docs.example/mcp', transport: 'streamable-http' as const, authMode: 'bearer' as const,
        headerNames: [], allowedTools: ['search'], discoveredTools: [{ name: 'search', description: 'Search the docs.' }],
      },
    },
  ];
  const stored: Record<string, { revision: number }> = {};
  for (const account of accounts) {
    stored[account.id] = await f.config.putConnectionAccount({
      ...account, ownerKind: 'team', workspaceId: teamId, createdByMembershipId: f.owner.membership.id,
      secretRefId: `secret_${account.id}`,
    } as never, 0);
    await f.config.putAgentConnectionBinding({
      agentId: 'agent_ops', connectionAccountId: account.id, providerId: account.providerId, allowedCapabilities: [], enabled: true,
    });
  }
  return stored;
}

type Shown = ReturnType<typeof present>;

/** Rows of the card, as a person reads them: mark, title, detail, link. */
function rows(shown: Shown): string[] {
  const block = shown.blocks.find(({ kind }) => kind === 'rows');
  return block?.kind === 'rows'
    ? block.rows.map((row) => [row.icon, row.title, row.detail, row.control && `[${row.control.label}]`].filter(Boolean).join(' · '))
    : [];
}

function fixOf(shown: Shown, title: string): Action {
  const block = shown.blocks.find(({ kind }) => kind === 'rows');
  const row = block?.kind === 'rows' ? block.rows.find((candidate) => candidate.title === title) : undefined;
  assert.ok(row?.control, `${title} has a fix`);
  return row.control.action;
}

const BROKEN = {
  connection_docs: { kind: 'key_rejected', status: 401, detail: 'Unauthorized' },
  connection_zendesk: { kind: 'unreachable', url: 'https://acme.zendesk.com/api/', detail: 'timed out' },
} satisfies Record<string, ConnectionCheckOutcome>;

test('what needs attention comes first, each with its fix as a link; the healthy parts fold into one row', async (t) => {
  const { f, teamId, call, card, clock } = await harness(t, 'health-card', BROKEN);
  await seedOps(f, teamId);
  const result = await call('check_agent', { agentId: 'agent_ops' });
  assert.equal(result._meta?.['chickpea/tool'], 'check_agent');
  assert.deepEqual(JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text), result.structuredContent, 'a client without cards gets it all');
  assert.equal(result.structuredContent!.agent.agentId, 'agent_ops');

  const health = card();
  await health.result(result);
  const shown = health.shown;
  assert.equal(shown.title, '3 things need attention');
  assert.equal(shown.avatar, 'alert');
  assert.deepEqual(shown.subtitle, [{ text: '@ops · checked its connections, model, Slack, Channels and who can reach it' }]);
  assert.deepEqual(rows(shown), [
    'failed · Linear · It needs to be reconnected. · [Reconnect Linear]',
    'failed · Zendesk · Chickpea could not reach the service.',
    'failed · Docs MCP · The service rejected its saved key. · [Send a link to save a new key]',
    'done · 4 other parts look healthy · [Show]',
  ]);
  const docs = (result.structuredContent!.checks as Array<{ name: string; detail: string; connectionId: string }>).find(({ name }) => name === 'Docs MCP')!;
  assert.equal(docs.detail, 'The service rejected its saved key. HTTP 401. Unauthorized', 'the model still gets the whole detail');
  // The check's own connection IDs and the stored accounts' IDs.
  const ids = [
    ...(result.structuredContent!.checks as Array<{ connectionId?: string }>).flatMap(({ connectionId }) => connectionId ?? []),
    'connection_docs', 'connection_zendesk', 'connection_linear',
  ];
  assertPlain(shown, ids);
  assert.deepEqual(health.labels(), ['Check again (secondary)']);
  assert.equal(buttonCount(shown), 1, 'every fix is a text link');

  await health.press('show');
  assert.deepEqual(rows(health.shown).slice(3), [
    'done · 4 other parts look healthy · [Hide]',
    'done · local-stub/ops · It runs on local-stub/ops.',
    'done · @ops · Ready in Slack.',
    'done · #support · Answers here.',
    ...rows(health.shown).slice(7),
  ]);
  // One sentence and what to do; how Chickpea routes a DM stays in detail, for the model.
  assert.equal(rows(health.shown)[7]!, 'done · You, in a DM · You can DM it: choose it in Chickpea\'s Home tab in Slack.');
  assert.equal(rows(health.shown).length, 8);
  assertPlain(health.shown, ids);
  await health.press('hide');
  assert.equal(rows(health.shown).length, 4);
  await health.dispatch({ type: 'reread', now: clock.now });
  assert.deepEqual(health.calls().map(({ tool }) => tool), ['get_agent', 'get_agent'], 'showing it, and coming back to it, read only the Agent');
});

// Mutation proof: a health fix never writes without a click.
test('a setup-link fix calls its tool only when pressed, and opens the Chickpea page it returns', async (t) => {
  const { f, teamId, call, card, clock } = await harness(t, 'health-fix', BROKEN);
  await seedOps(f, teamId);
  const health = card();
  await health.result(await call('check_agent', { agentId: 'agent_ops' }));
  for (const idle of ['reread', 'tick', 'reread'] as const) await health.dispatch({ type: idle, now: clock.now });
  assert.deepEqual(health.calls().filter(({ tool }) => tool !== 'get_agent'), [], 'mount, focus and timers fix nothing');

  const fix = fixOf(health.shown, 'Linear');
  await health.press(fix);
  const [made] = health.calls('reconnect_service');
  assert.deepEqual(made?.args, { agentId: 'agent_ops', connectionId: 'linear' }, 'the check\'s own arguments');
  const opened = health.effects.filter((effect) => effect.type === 'open');
  assert.equal(opened.length, 1);
  const page = new URL((opened[0] as { url: string }).url);
  assert.equal(page.origin, BASE_URL);
  assert.match(page.pathname, /^\/setup\/setup_/, 'Chickpea\'s page for this one connection');
  assert.deepEqual(rows(health.shown)[0], 'now · Linear · Finish on the Chickpea page that opened, then come back. · [Reconnect Linear]');
  assert.equal(health.shown.title, '3 things need attention', 'the title stays the same');
  assert.deepEqual(health.effects.filter(({ type }) => type === 'context'), [{
    type: 'context',
    text: 'The person pressed "Reconnect Linear" for the Agent "Ops" on the card, which opened Chickpea\'s page. It changes when they finish there.',
  }]);
  assert.equal(health.shown.announce, '3 things need attention. Linear: Finish on the Chickpea page that opened, then come back.');

  // Pressed again after the host gave up: the same call, and one link opens.
  health.hold = ({ tool }) => tool === 'reconnect_service';
  const docs = fixOf(health.shown, 'Docs MCP');
  await health.press(docs);
  await health.press(docs);
  assert.equal(health.calls('reconnect_service').length, 2, 'the second press waits for the first');
  const [late] = health.held;
  await health.answer('unreachable');
  assert.deepEqual([health.shown.busy, health.shown.error], [false, 'Chickpea could not be reached. Try again.']);
  await health.press(docs);
  const [first, second] = health.calls('reconnect_service').slice(1);
  assert.deepEqual(second!.args, first!.args, 'a retry sends the same call');
  await health.dispatch({ type: 'reply', call: late!.call, result: late!.result, now: clock.now });
  assert.equal(health.effects.filter((effect) => effect.type === 'open').length, 1, 'the first press\'s late answer opens nothing');
  await health.answer();
  assert.equal(health.effects.filter((effect) => effect.type === 'open').length, 2, 'the retry\'s answer opens its link');
});

// Mutation proof: a late reply never moves a newer view.
test('a fix that answers after Chickpea could not be reached opens nothing, with no retry in between', async (t) => {
  const { f, teamId, call, card, clock } = await harness(t, 'health-late', BROKEN);
  await seedOps(f, teamId);
  const health = card();
  await health.result(await call('check_agent', { agentId: 'agent_ops' }));
  health.hold = ({ tool }) => tool === 'reconnect_service';
  await health.press(fixOf(health.shown, 'Linear'));
  const [late] = health.held;
  await health.answer('unreachable');
  assert.equal(health.shown.error, 'Chickpea could not be reached. Try again.');
  await health.dispatch({ type: 'reply', call: late!.call, result: late!.result, now: clock.now });
  assert.deepEqual(health.effects.filter(({ type }) => type === 'open'), [], 'the answer came after the card gave the button back');
  assert.deepEqual(rows(health.shown)[0], 'failed · Linear · It needs to be reconnected. · [Reconnect Linear]');
});

test('a fix that would change the Agent goes to the chat, and a link fix opens only when pressed', async (t) => {
  const { f, teamId, call, card } = await harness(t, 'health-ask');
  await seedOps(f, teamId);
  const result = await call('check_agent', { agentId: 'agent_ops' });
  const checks = result.structuredContent!.checks as Array<Record<string, unknown>>;
  const linear = checks.findIndex(({ name }) => name === 'Linear');
  const withFix = (fix: Record<string, unknown>): ToolResult => ({
    ...result,
    structuredContent: { ...result.structuredContent, checks: checks.map((check, index) => index === linear ? { ...check, fix } : check) },
  });

  const writes = [
    { label: 'Send a GitHub access link', tool: 'apply_workspace_changes', arguments: { idempotencyKey: 'k', operations: [] } },
    { label: 'Add Linear again', tool: 'connect_service', arguments: { agentId: 'agent_ops', custom: { kind: 'api' }, idempotencyKey: 'k' } },
    { label: 'Turn it on', tool: 'update_agent', arguments: { agentId: 'agent_ops', on: true } },
  ];
  for (const fix of writes) {
    const health = card();
    await health.result(withFix(fix));
    await health.press(fixOf(health.shown, 'Linear'));
    assert.deepEqual(health.calls().filter(({ tool }) => tool !== 'get_agent'), [], `${fix.tool}: no call from the card`);
    assert.deepEqual(health.effects.at(-1), { type: 'message', sent: `Fix Linear for Ops: ${fix.label}.` });
  }

  const admin = card();
  await admin.result(withFix({ label: 'Open the Agent in Admin', url: `${BASE_URL}/admin/agents/agent_ops` }));
  assert.deepEqual(admin.effects.filter(({ type }) => type === 'open'), []);
  await admin.press(fixOf(admin.shown, 'Linear'));
  assert.deepEqual(admin.effects.at(-1), { type: 'open', url: `${BASE_URL}/admin/agents/agent_ops` });
  assert.deepEqual(admin.calls().filter(({ tool }) => tool !== 'get_agent'), []);

  // Mutation proof: a fix link opens only when it is a web link.
  for (const url of ['javascript:alert(1)', `${BASE_URL.replace('https:', 'http:')}/admin/agents/agent_ops`]) {
    const unsafe = card();
    await unsafe.result(withFix({ label: 'Open it', url }));
    await unsafe.press(fixOf(unsafe.shown, 'Linear'));
    assert.deepEqual(unsafe.effects.filter(({ type }) => type !== 'call'), [], url);
  }
});

test('a turned-off Agent\'s check offers to turn it back on, through the chat', async (t) => {
  const { f, teamId, call, card } = await harness(t, 'health-off');
  await seedOps(f, teamId);
  await f.config.updateAgent('agent_ops', { enabled: false });
  const health = card();
  await health.result(await call('check_agent', { agentId: 'agent_ops' }));
  const row = rows(health.shown).find((line) => line.includes('turned off'));
  assert.match(row ?? '', /Ops is turned off, so it answers no one\. · \[Turn it back on\]$/);
  await health.press(fixOf(health.shown, 'You, in a DM'));
  assert.deepEqual(health.effects.at(-1), { type: 'message', sent: 'Fix you, in a DM for Ops: Turn it back on.' });
  assert.deepEqual(health.calls().filter(({ tool }) => tool !== 'get_agent'), [], 'the model turns it on, not the card');
});

// Mutation proof: the card opens a fix's link only when it is Chickpea's page for that one connection.
test('a fix whose answer is not Chickpea\'s page for one connection asks the chat instead of opening it', async (t) => {
  const { f, teamId, call, clock } = await harness(t, 'health-admin-link');
  await seedOps(f, teamId);
  const result = await call('check_agent', { agentId: 'agent_ops' });
  for (const url of [`${BASE_URL}/admin/agents/agent_ops`, 'https://elsewhere.example/x']) {
    const server = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => name === 'reconnect_service'
      ? { structuredContent: { status: 'needs_setup', summary: 'Open the link to reconnect Linear.', setup: { url, what: 'Linear' } } }
      : call(name, args);
    const health = cardHost(HEALTH_CARD, server, clock);
    await health.result(result);
    await health.press(fixOf(health.shown, 'Linear'));
    assert.equal(health.calls('reconnect_service').length, 1);
    assert.deepEqual(health.effects.filter(({ type }) => type === 'open'), [], url);
    assert.deepEqual(health.effects.at(-1), { type: 'message', sent: 'Fix Linear for Ops: Reconnect Linear.' }, url);
    assert.deepEqual([health.shown.busy, health.shown.error], [false, undefined]);
  }
});

test('coming back into view reads the Agent: a connection that became ready reads healthy, a failed test does not', async (t) => {
  const { f, teamId, call, card, clock } = await harness(t, 'health-reread', BROKEN);
  const stored = await seedOps(f, teamId);
  const health = card();
  await health.result(await call('check_agent', { agentId: 'agent_ops' }));
  // The card reads the Agent as it mounts.
  await health.dispatch({ type: 'reread', now: clock.now });
  await health.press(fixOf(health.shown, 'Linear'));

  const linear = (await f.config.listConnectionAccounts(teamId)).find(({ id }) => id === 'connection_linear')!;
  await f.config.putConnectionAccount({ ...linear, lifecycle: 'ready' } as never, stored.connection_linear!.revision);
  await health.dispatch({ type: 'reread', now: clock.now });
  assert.equal(health.shown.title, '2 things need attention');
  assert.deepEqual(rows(health.shown).slice(0, 2), [
    'failed · Zendesk · Chickpea could not reach the service.',
    'failed · Docs MCP · The service rejected its saved key. · [Send a link to save a new key]',
  ], 'Docs MCP was stored as ready all along: its failed test stands until checked again');
  assert.equal(health.shown.announce, '2 things need attention. Linear: Connected.');
  await health.press('show');
  assert.ok(rows(health.shown).includes('done · Linear · Connected.'));
  assert.deepEqual(health.calls().filter(({ tool }) => tool === 'check_agent'), [], 'no request left Chickpea');
});

test('unknown reads as unknown, never healthy; a clean check reads healthy', async (t) => {
  const { f, teamId, call, card } = await harness(t, 'health-unknown');
  await createFixtureAgent(f, 'agent_quiet', {
    name: 'Quiet',
    model: 'local-stub/quiet',
    slackPresence: { requestedHandle: 'quiet', normalizedHandle: 'quiet', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'quiet' } },
  });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_PRIVATE', label: 'private', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_PRIVATE', agentId: 'agent_quiet', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'private', channelIsPrivate: true,
  });
  const quiet = card();
  await quiet.result(await call('check_agent', { agentId: 'agent_quiet' }));
  assert.equal(quiet.shown.title, 'No problems found');
  assert.deepEqual(rows(quiet.shown).map((row) => row.split(' · ').slice(0, 2).join(' · ')), [
    'unknown · You, in a DM',
    'done · 3 other parts look healthy',
  ], 'the part the check could not tell about stays out of the healthy ones');

  const result = await call('check_agent', { agentId: 'agent_quiet' });
  const healthy = card();
  await healthy.result({
    ...result,
    structuredContent: { ...result.structuredContent, checks: (result.structuredContent!.checks as Array<{ status: string }>).filter(({ status }) => status === 'ok') },
  });
  assert.equal(healthy.shown.title, 'Everything looks healthy');
  assert.equal(healthy.shown.avatar, 'agent');
  assert.match(rows(healthy.shown)[0]!, /^done · \d parts? looks? healthy · \[Show\]$/);
});

test('Check again runs the check only when pressed, and gives the button back if Chickpea cannot be reached', async (t) => {
  const { f, teamId, call, card, tested } = await harness(t, 'health-again', BROKEN);
  await seedOps(f, teamId);
  const health = card();
  await health.result(await call('check_agent', { agentId: 'agent_ops' }));
  const before = tested.length;
  health.hold = ({ tool }) => tool === 'check_agent';
  await health.press('check_again');
  assert.equal(health.shown.busy, true);
  await health.answer('unreachable');
  assert.deepEqual([health.shown.busy, health.shown.error], [false, 'Chickpea could not be reached. Try again.']);
  health.hold = () => false;
  await health.press('check_again');
  assert.deepEqual(health.calls('check_agent').map(({ args }) => args), [{ agentId: 'agent_ops' }, { agentId: 'agent_ops' }]);
  assert.equal(tested.length, before + 2 * 2, 'two presses, one request per custom connection each');
  assert.equal(health.shown.title, '3 things need attention');
});

test('a connection the check could not test reads as unknown, in plain words', async (t) => {
  const { f, teamId, call, card } = await harness(t, 'health-ambiguous', {
    connection_docs: new ManagementError('invalid_request', 'More than one connection uses docs, so Chickpea could not tell which one to test. Name it by its own connection id.'),
  });
  await seedOps(f, teamId);
  const result = await call('check_agent', { agentId: 'agent_ops' });
  const docs = (result.structuredContent!.checks as Array<{ name: string; detail: string; connectionId: string }>).find(({ name }) => name === 'Docs MCP')!;
  assert.match(docs.detail, /More than one connection uses/, 'the model gets the reason');
  const health = card();
  await health.result(result);
  assert.ok(rows(health.shown).includes('unknown · Docs MCP · The check could not tell whether it works.'));
  assertPlain(health.shown, [docs.connectionId, 'connection_docs']);
  assert.doesNotMatch(JSON.stringify(health.shown), /More than one connection/, 'the card shows plain words, not the service\'s reason');
  // Zendesk answered: its healthy row, once shown, says so without the status.
  await health.press('show');
  assert.ok(rows(health.shown).includes('done · Zendesk · It answered.'), rows(health.shown).join('\n'));
  assertPlain(health.shown, [docs.connectionId, 'connection_docs', 'connection_zendesk']);
});

test('a Channel Chickpea has no name for reads as "a private Channel", never its Slack ID', async (t) => {
  const { f, teamId, call, card } = await harness(t, 'health-unnamed-channel');
  await createFixtureAgent(f, 'agent_quiet', { name: 'Quiet', model: 'local-stub/quiet' });
  // A grant with no Channel record and no label: the result names the Channel by its ID.
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C0UNNAMED01', agentId: 'agent_quiet', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelIsPrivate: true,
  });
  const result = await call('check_agent', { agentId: 'agent_quiet', place: 'C0UNNAMED01' });
  const checks = result.structuredContent!.checks as Array<{ part: string; name: string; channelId?: string }>;
  assert.deepEqual(
    checks.filter(({ channelId }) => channelId).map(({ part, name }) => [part, name]),
    [['channel', 'C0UNNAMED01'], ['admission', 'you, in C0UNNAMED01']],
    'the model keeps the ID',
  );
  const health = card();
  await health.result(result);
  await health.press('show');
  const titles = rows(health.shown).map((row) => row.split(' · ')[1]);
  assert.ok(titles.includes('A private Channel'), titles.join('\n'));
  assert.ok(titles.includes('You, in a private Channel'), titles.join('\n'));
  assert.doesNotMatch(JSON.stringify(health.shown), /C0UNNAMED01/);
});

test('a row without plain words gets a sentence for its part and status, never its detail', async () => {
  const nothing = async (): Promise<ToolResult> => ({ isError: true });
  const health = cardHost(HEALTH_CARD, nothing, { now: 0 });
  await health.result({ structuredContent: {
    agent: { agentId: 'agent_ops', name: 'Ops' }, person: { you: true }, place: { kind: 'dm' },
    checks: [
      { part: 'connection', name: 'Docs MCP', status: 'failing', detail: 'The service rejected its saved key. HTTP 401. Unauthorized' },
      { part: 'schedule', name: 'Morning digest', status: 'warning', detail: 'Paused. consecutive_failures', plain: 7 },
    ],
  } });
  assert.deepEqual(rows(health.shown), [
    'failed · Docs MCP · It is not working.',
    'warning · Morning digest · Some of its runs need a look.',
  ]);
});

test('an error or a result of the wrong shape shows nothing to press', async (t) => {
  const { call, card, clock } = await harness(t, 'health-errors');
  const missing = card();
  await missing.result(await call('check_agent', { agentId: 'agent_missing' }));
  assert.deepEqual([missing.shown.title, missing.labels()], ['That Agent is gone, or you can\'t manage it.', []]);
  const nothing = async (): Promise<ToolResult> => ({ isError: true });
  const linear = { part: 'connection', name: 'Linear', detail: 'It needs to be reconnected.', status: 'failing' };
  for (const check of [
    { part: 'connection', name: 'Linear', detail: 'It needs to be reconnected.' },
    { part: 'billing', name: 'x', detail: 'y', status: 'ok' },
    { ...linear, status: 'toString' },
    { ...linear, fix: { label: 'Reconnect Linear', tool: 'connect_service' } },
    { ...linear, fix: 'Reconnect Linear' },
    { ...linear, fix: { tool: 'reconnect_service', arguments: {} } },
  ]) {
    const malformed = cardHost(HEALTH_CARD, nothing, clock);
    await malformed.result({ structuredContent: { agent: { name: 'Ops' }, person: { you: true }, place: { kind: 'dm' }, checks: [check] } });
    assert.deepEqual([malformed.shown.title, malformed.labels()], ['Nothing to show here.', []], 'a row of no known status is never healthy');
  }
});
