import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { Validator } from '@cfworker/json-schema';

import { cardRefusal } from '../src/management/mcp-v5/card-host.ts';
import { workspaceManagementMcpFetch } from '../src/management/mcp.ts';
import type { McpToolError } from '../src/management/mcp-v5/conventions.ts';
import { CARD_REFUSAL_TOOL_NAMES } from '../src/management/mcp-v5/tools.ts';
import * as agentCard from '../src/mcp-cards/agent-card/model.ts';
import { hostErrorOf, hostFailed, refusalOf, type ToolResult } from '../src/mcp-cards/card-model.ts';
import * as connectCard from '../src/mcp-cards/connect-card/model.ts';
import * as healthCard from '../src/mcp-cards/health-card/model.ts';
import { GATEWAY_TIMEOUT, GATEWAY_TIMEOUT_IP, RESOURCE_NOT_FOUND } from './helpers/chatgpt-delivery.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { asChatGpt, BASE_URL, cardHost, cardServer, jsonRequest, type CardModelUnderTest, type ServerCall } from './helpers/mcp-card-host.ts';
import { slackMember } from './helpers/slack-members.ts';
import { StubTestRuns } from './helpers/stub-test-runs.ts';

/**
 * Probe 12 measured ChatGPT answering a card's call whose result has
 * `isError` with a JSON-RPC error that keeps only the text, so every refusal
 * read "Chickpea could not be reached". On a card session the tools a card
 * receives now send a refusal as a result, which ChatGPT hands the card whole.
 * Each card test here goes through ChatGPT's delivery (`asChatGpt`).
 */

const AGENT_CARD: CardModelUnderTest<agentCard.View, agentCard.Action> = {
  initial: agentCard.INITIAL,
  step: agentCard.step,
  present: agentCard.present,
  reads: new Set(['get_creation_status', 'get_agent', 'get_confirmation', 'get_practice_run']),
  followsPress: ({ view }) => (view.kind === 'creating' && view.byPress === true) || view.kind === 'first_answer',
  replays: new Set(['practice_agent']),
};
const CONNECT_CARD: CardModelUnderTest<connectCard.View, connectCard.Action> = {
  initial: connectCard.INITIAL,
  step: connectCard.step,
  present: connectCard.present,
  reads: new Set(['get_setup_status', 'check_agent']),
};
const HEALTH_CARD: CardModelUnderTest<healthCard.View, healthCard.Action> = {
  initial: healthCard.INITIAL,
  step: healthCard.step,
  present: healthCard.present,
  reads: new Set(['get_agent']),
};

const RETIRED = 'That confirmation no longer applies. Ask again to make the change.';
const NOT_YOURS = 'That confirmation isn\'t one of yours, so nothing changed.';
const NOT_YOURS_NEXT = 'Use the confirmToken from the needs_confirmation result in this conversation.';

/** A workspace with an Agent that answers in #support, so turning it off asks first. */
async function world(t: TestContext, suffix: string, options: { cards?: boolean } = { cards: true }) {
  const runs = new StubTestRuns({ status: 'answered', failure: null, result: { reply: 'Two are overdue.', read: [] } });
  const server = await cardServer(t, suffix, {
    testRuns: runs,
    modelReadiness: async () => async () => undefined,
    // Slack's record of the caller: a guest, whom a first answer refuses as a DM would.
    slackMember: async (id) => slackMember(id, 'T_ACME', { restricted: true }),
  }, options);
  const { f, call, clock, teamId } = server;
  runs.now = () => clock.now;
  await createFixtureAgent(f, 'agent_support', {
    name: 'Support Desk',
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'support' } },
  });
  await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'direct', botUserId: 'UBOT', runtimeContract: 'chickpea-v1' });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId, channelId: 'C_SUPPORT', agentId: 'agent_support', status: 'active',
    createdByMembershipId: f.owner.membership.id, channelLabel: 'support',
  });
  const version = async () => (await call('get_agent', { agentId: 'agent_support' })).structuredContent!.version as string;
  let keys = 0;
  const turnOff = async () => {
    await f.config.updateAgent('agent_support', { enabled: true });
    return call('update_agent', { agentId: 'agent_support', version: await version(), on: false, idempotencyKey: `off-${keys += 1}` });
  };
  return { ...server, runs, version, turnOff };
}

/** What Slack does after create_agent: the Agent joins and its hello is delivered. */
async function sayHello(f: Awaited<ReturnType<typeof world>>['f'], clock: { now: number }, agentId: string) {
  const agent = await f.config.getAgent(agentId);
  await f.config.updateAgent(agentId, { model: 'local-stub/invoices', slackPresence: { ...agent!.slackPresence!, health: 'healthy' } });
  const claimed = await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
  const hello = claimed.find(({ receipt }) => 'kind' in receipt && receipt.kind === 'agent_created_welcome')!;
  await f.management.settleOutbox({ outboxId: hello.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: 'D1:1.1' });
}

const tokenOf = (result: ToolResult) => {
  const held = result._meta?.['chickpea/held'] as { confirmToken?: string } | undefined;
  return held?.confirmToken ?? (result.structuredContent as { confirmation: { confirmToken: string } }).confirmation.confirmToken;
};
const told = (card: { effects: ReadonlyArray<{ type: string }> }) =>
  (card.effects.findLast(({ type }) => type === 'context') as { text: string } | undefined)?.text.split('\n').at(-1);

// Mutation proof (item 1): dropping the conversion, or cardCalls from the rule, fails this test.
test('on a card session the tools a card receives send a refusal as a result, which leads with it; every other tool keeps isError', async (t) => {
  const { call } = await world(t, 'refusal-card-session');
  assert.deepEqual([...CARD_REFUSAL_TOOL_NAMES].sort(), [
    'check_agent', 'confirm_change', 'connect_model_provider', 'connect_service', 'create_agent', 'decline_change',
    'delete_agent', 'delete_schedule', 'get_agent', 'get_confirmation', 'get_creation_status', 'get_practice_run', 'get_setup_status',
    'practice_agent', 'propose_agent', 'propose_agent_change', 'reconnect_service', 'remove_connection',
    'remove_model_provider_key', 'remove_website_login', 'undo_change', 'update_agent', 'update_member',
  ], 'a card draws it, only a card calls it, only a card\'s press calls it, or a card also calls it');

  assert.deepEqual(await call('confirm_change', { confirmToken: 'changeset_unknown' }), {
    content: [{ type: 'text', text: `Refused (not_found): ${NOT_YOURS}\n${NOT_YOURS_NEXT}` }],
    structuredContent: { error: { code: 'not_found', message: NOT_YOURS, retryable: false, nextStep: NOT_YOURS_NEXT } },
    isError: false,
  });
  // An error the SDK makes itself, before the tool runs, goes the same way.
  const invalid = await call('get_confirmation', { confirmToken: '' });
  assert.deepEqual([invalid.isError, (invalid.structuredContent as { error: McpToolError }).error.code], [false, 'invalid_input']);
  assert.match((invalid as { content: Array<{ text: string }> }).content[0]!.text, /^Refused \(invalid_input\): Chickpea did not accept that request\.\n/);
  // Only the model reads archive_agent's result, and ChatGPT tells its model an error is one.
  const archive = await call('archive_agent', { agentId: 'agent_missing', version: '0123456789abcdef', idempotencyKey: 'archive' });
  assert.equal(archive.isError, true);
  assert.doesNotMatch((archive as { content: Array<{ text: string }> }).content[0]!.text, /^Refused/);
});

test('outside a card session a refusal is what it was, byte for byte, and no listed schema changes', async (t) => {
  const plain = await world(t, 'refusal-plain', { cards: false });
  assert.equal(await plain.send('tools/call', { name: 'confirm_change', arguments: { confirmToken: 'changeset_unknown' } }),
    '{"result":{"content":[{"type":"text","text":"That confirmation isn\'t one of yours, so nothing changed.\\nUse the confirmToken from the needs_confirmation result in this conversation."}],' +
    '"structuredContent":{"error":{"code":"not_found","message":"That confirmation isn\'t one of yours, so nothing changed.","retryable":false,' +
    '"nextStep":"Use the confirmToken from the needs_confirmation result in this conversation."}},"isError":true},"jsonrpc":"2.0","id":1}');
  const listed = JSON.parse(await plain.send('tools/list', {})).result.tools as Array<{ name: string; outputSchema?: Record<string, unknown> }>;
  assert.deepEqual(listed.filter(({ outputSchema }) => outputSchema && 'anyOf' in outputSchema).map(({ name }) => name), []);
});

// Mutation proof (review): observing after the conversion counts every refusal on a card session as a success,
// and loses the fields an input refusal names.
test('a refusal sent as a result still counts as a refusal in the request metric', async (t) => {
  const { call } = await world(t, 'refusal-metrics');
  const metrics: Array<Record<string, unknown>> = [];
  t.mock.method(console, 'info', (record: unknown) => {
    if (record && typeof record === 'object') metrics.push(record as Record<string, unknown>);
  });
  const seen = () => metrics.splice(0).filter(({ event }) => event === 'mcp.request' || event === 'tool.validation_failure')
    .map(({ event, tool, outcome }) => ({ event, tool, outcome }));

  assert.equal((await call('confirm_change', { confirmToken: 'changeset_unknown' })).isError, false);
  assert.deepEqual(seen(), [{ event: 'mcp.request', tool: 'confirm_change', outcome: 'tool_error' }]);
  assert.equal((await call('get_confirmation', { confirmToken: '' })).isError, false);
  assert.deepEqual(seen(), [
    { event: 'tool.validation_failure', tool: 'get_confirmation', outcome: undefined },
    { event: 'mcp.request', tool: 'get_confirmation', outcome: 'input_refused' },
  ]);
  await call('get_agent', { agentId: 'agent_support' });
  assert.deepEqual(seen(), [{ event: 'mcp.request', tool: 'get_agent', outcome: 'success' }]);
});

// Mutation proof (review): a rewritten result that drops what the SDK stamped is one a 2026-07-28 client rejects whole.
test('on 2026-07-28 a rewritten result keeps its resultType, so a client accepts the refusal', async (t) => {
  const { f, principal } = await world(t, 'refusal-modern');
  const fetch = workspaceManagementMcpFetch({ principal, service: f.service, baseUrl: BASE_URL });
  const call = async (name: string, args: Record<string, unknown>, capabilities: Record<string, unknown>) => {
    const response = await fetch(jsonRequest({
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name,
    }, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name, arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': capabilities },
      },
    }));
    const body = await response.text();
    const { result } = JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as
      { result: ToolResult & { resultType?: string } };
    return [result.isError, (result.structuredContent as { error: McpToolError }).error.code, result.resultType, Object.keys(result._meta ?? {})];
  };
  const cards = { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } };
  const stamped = ['complete', ['io.modelcontextprotocol/serverInfo']];

  assert.deepEqual(await call('confirm_change', { confirmToken: 'changeset_unknown' }, cards), [false, 'not_found', ...stamped], 'a refusal as a result');
  assert.deepEqual(await call('get_confirmation', { confirmToken: '' }, cards), [false, 'invalid_input', ...stamped], 'and one the SDK made');
  assert.deepEqual(await call('archive_agent', { agentId: 7 }, {}), [true, 'invalid_input', ...stamped], 'an SDK error in the 5.0 shape, on any session');
  assert.deepEqual(await call('confirm_change', { confirmToken: 'changeset_unknown' }, {}), [true, 'not_found', ...stamped], 'as a tool\'s own error is');
});

// Mutation proof (item 1): listing each such tool's own schema alone makes every refusal invalid to a client that checks.
test('a card session lists each such tool\'s output with the refusal beside it, so a client that checks results accepts both', async (t) => {
  const cards = await world(t, 'refusal-schemas');
  const plain = await world(t, 'refusal-schemas-plain', { cards: false });
  const schemasOf = async (send: typeof cards.send) => Object.fromEntries(
    (JSON.parse(await send('tools/list', {})).result.tools as Array<{ name: string; outputSchema?: Record<string, unknown> }>)
      .map(({ name, outputSchema }) => [name, outputSchema]),
  );
  const [onCards, onPlain] = await Promise.all([schemasOf(cards.send), schemasOf(plain.send)]);
  const refusal = cardRefusal({ code: 'changed_since_read', message: RETIRED, retryable: true, nextStep: 'Ask again.', fix: { label: 'Open Chickpea Admin', url: 'https://chickpea.example.test/admin' } });
  const valid = (schema: Record<string, unknown> | undefined, value: unknown) => new Validator(schema as object, '2020-12', false).validate(value).valid;
  for (const [name, own] of Object.entries(onPlain)) {
    if (!own) continue;
    const listed = onCards[name];
    if (!CARD_REFUSAL_TOOL_NAMES.has(name)) {
      assert.deepEqual(listed, own, `${name}: its own output`);
      continue;
    }
    const { $schema, ...ownWithout } = own;
    assert.deepEqual(listed, { $schema, type: 'object', anyOf: [ownWithout, listed!.anyOf && (listed!.anyOf as unknown[])[1]] }, name);
    assert.equal(valid(listed, refusal.structuredContent), true, `${name}: the refusal matches the card session's schema`);
    assert.equal(valid(own, refusal.structuredContent), false, `${name}: and not the tool's own`);
  }
  const agent = await cards.call('get_agent', { agentId: 'agent_support' });
  assert.equal(valid(onCards.get_agent, agent.structuredContent), true, 'a result still matches');
  const refused = await cards.call('update_agent', { agentId: 'agent_support', version: '0123456789abcdef', on: false, idempotencyKey: 'stale' });
  assert.deepEqual([refused.isError, valid(onCards.update_agent, refused.structuredContent)], [false, true], 'and a real refusal does');
});

// Mutation proof (item 2): refusalOf that ignores a result without isError shows the host's failure on every card.
test('every card\'s refusal state shows its own sentence as ChatGPT delivers it', async (t) => {
  const { f, call, clock, turnOff, version } = await world(t, 'refusal-chatgpt');
  const chatgpt = asChatGpt(call);

  // The Agent card: Turn off after the token was kept on another card.
  const pending = await turnOff();
  const confirm = cardHost(AGENT_CARD, chatgpt, clock);
  await confirm.result(pending);
  assert.deepEqual(confirm.labels(), ['Turn off (danger)', 'Keep it on (secondary)']);
  await call('decline_change', { confirmToken: tokenOf(pending) });
  await confirm.press('confirm');
  assert.deepEqual([confirm.shown.title, confirm.shown.blocks, confirm.labels()], ['Nothing changed', [{ kind: 'text', text: RETIRED }], []]);
  assert.equal(told(confirm), `The person confirmed on the card, but nothing changed. Chickpea said: ${JSON.stringify(RETIRED)}`);

  // Save on a preview the Agent moved past.
  const preview = await call('propose_agent_change', { agentId: 'agent_support', version: await version(), change: { description: 'Answers support.' } });
  const change = cardHost(AGENT_CARD, chatgpt, clock);
  await change.result(preview);
  await call('update_agent', { agentId: 'agent_support', version: await version(), description: 'Moved on.', idempotencyKey: 'moved' });
  await change.press('save');
  assert.match(change.shown.error ?? '', /changed since you read it, so nothing changed\.$/);
  assert.deepEqual(change.labels(), ['Cancel (secondary)'], 'no Save on a stale preview');

  // Its first answer, refused: Slack would not let a guest message the Agent.
  const ready = cardHost(AGENT_CARD, chatgpt, clock);
  await ready.result(await call('propose_agent', {
    name: 'Invoice Chaser', handle: 'invoices', job: 'Chases overdue invoices.', instructions: '# Job\nChase invoices.',
    sampleAsk: 'who is overdue?', promisedAnswer: 'I list them.',
  }));
  await ready.press('create');
  await sayHello(f, clock, 'agent_invoice_chaser');
  await ready.dispatch({ type: 'tick', now: clock.now });
  assert.deepEqual(ready.labels(), ['Open in Slack (primary)', 'See its first answer (secondary)']);
  await ready.press('try_once');
  assert.deepEqual(ready.shown.blocks.filter(({ kind }) => kind === 'text'),
    [{ kind: 'text', text: 'You can\'t message Invoice Chaser in Slack yet, so you can\'t practice with it.' }]);

  // The health card: a fix whose connection is gone since the check.
  const checked = await call('check_agent', { agentId: 'agent_support' });
  const content = checked.structuredContent as { checks: Array<Record<string, unknown>> };
  const health = cardHost(HEALTH_CARD, chatgpt, clock);
  await health.result({
    ...checked,
    structuredContent: {
      ...content,
      healthy: false,
      checks: [{
        part: 'connection', name: 'Linear', status: 'failing', detail: 'Linear needs signing in again.', plain: 'Linear needs signing in again.',
        fix: { label: 'Sign in again', tool: 'reconnect_service', arguments: { agentId: 'agent_support', connectionId: 'connection_gone' } },
      }, ...content.checks],
    },
  });
  await health.press('fix:0');
  const gone = (await call('reconnect_service', { agentId: 'agent_support', connectionId: 'connection_gone' })).structuredContent as { error: McpToolError };
  assert.equal(health.shown.error, gone.error.message, 'Chickpea\'s own sentence, not "could not be reached"');

  // Cards drawn with a refusal, as a model's call on a card session now draws one.
  const connect = cardHost(CONNECT_CARD, chatgpt, clock);
  const unknown = await call('connect_service', { agentId: 'agent_missing', service: 'Gmail', owner: 'me', idempotencyKey: 'connect' });
  await connect.result(unknown);
  assert.equal(connect.shown.title, (unknown.structuredContent as { error: McpToolError }).error.message);
  const unchecked = cardHost(HEALTH_CARD, chatgpt, clock);
  const missing = await call('check_agent', { agentId: 'agent_missing' });
  await unchecked.result(missing);
  assert.equal(unchecked.shown.title, (missing.structuredContent as { error: McpToolError }).error.message);
});

// Mutation proof (item 4): reading a retired confirmation as pending, or letting another person read one, fails this test.
test('get_confirmation says where a confirmation stands, and only to the person and app it belongs to', async (t) => {
  const { f, call, clock, turnOff, principal, as } = await world(t, 'refusal-standing');
  const standing = async (result: ToolResult, by: ServerCall = call) => (await by('get_confirmation', { confirmToken: tokenOf(result) })).structuredContent;

  const kept = await turnOff();
  assert.deepEqual(await standing(kept), { status: 'pending' });
  await call('decline_change', { confirmToken: tokenOf(kept) });
  assert.deepEqual(await standing(kept), { status: 'cancelled' });

  const confirmed = await turnOff();
  await call('confirm_change', { confirmToken: tokenOf(confirmed) });
  assert.deepEqual(await standing(confirmed), { status: 'applied' });

  const expiring = await turnOff();
  const expiresAt = Date.parse((expiring.structuredContent as { confirmation: { expiresAt: string } }).confirmation.expiresAt);
  const now = clock.now;
  clock.now = expiresAt;
  assert.deepEqual(await standing(expiring), { status: 'expired' });
  clock.now = now;

  // Claimed by a confirm that is still applying, then by one whose lease ran out, then completed with nothing applied.
  const claimed = await turnOff();
  const record = (await f.management.getChangeSetProposal(tokenOf(claimed)))!;
  const applying = await f.management.claimChangeSetProposal({
    proposalId: record.proposalId, organizationId: record.organizationId, actorUserId: record.actorUserId,
    actorMembershipId: record.actorMembershipId, originKey: record.originKey, approvalScopeKey: record.approvalScopeKey, at: clock.now,
  });
  assert.deepEqual(await standing(claimed), { status: 'applied' }, 'a confirm is applying it');
  clock.now += 30_000;
  assert.deepEqual(await standing(claimed), { status: 'pending' }, 'a confirm whose lease ran out waits for a press to finish it');
  await f.management.completeChangeSetProposal(record.proposalId, {
    operationId: record.proposalId, idempotencyKey: record.idempotencyKey, status: 'failed', outcomes: [],
    effectiveRevision: 'r1', activation: 'next_turn',
  }, clock.now, applying.updatedAt);
  assert.deepEqual(await standing(claimed), { status: 'cancelled' }, 'nothing applied, and it can never apply');

  const pending = await turnOff();
  const strangers = {
    'another person': await as({ ...principal, userId: f.admin.user.id, membershipId: f.admin.membership.id, role: 'admin', clientId: principal.clientId }),
    'the same person in another app': await as({ ...principal, clientId: 'client_other_app' }),
  };
  for (const [who, by] of Object.entries(strangers)) {
    const read = await by('get_confirmation', { confirmToken: tokenOf(pending) });
    assert.deepEqual(read.structuredContent, { error: { code: 'not_found', message: 'That confirmation isn\'t one of yours.', retryable: false } }, who);
  }
});

// Mutation proof (item 4): a card that ignores get_confirmation offers Turn off and Keep on a confirmation that can no longer apply.
test('a confirmation card on a host that kept nothing asks where it stands before it offers Turn off or Keep', async (t) => {
  const { call, clock, turnOff } = await world(t, 'refusal-reopen');
  const reopen = async (result: ToolResult, now = clock.now) => {
    const card = cardHost(AGENT_CARD, asChatGpt(call), clock);
    await card.dispatch({ type: 'result', result, now });
    return card;
  };
  const writes = (card: Awaited<ReturnType<typeof reopen>>) => card.calls().filter(({ tool }) => !AGENT_CARD.reads.has(tool));

  const kept = await turnOff();
  await call('decline_change', { confirmToken: tokenOf(kept) });
  const keptAgain = await reopen(kept);
  assert.deepEqual([keptAgain.shown.title, keptAgain.shown.blocks, keptAgain.labels(), writes(keptAgain)],
    ['This confirmation no longer applies', [{ kind: 'text', text: 'Nothing changed. Ask again to make the change.' }], [], []]);

  const confirmed = await turnOff();
  await call('confirm_change', { confirmToken: tokenOf(confirmed) });
  const confirmedAgain = await reopen(confirmed);
  assert.deepEqual([confirmedAgain.shown.title, confirmedAgain.shown.done, confirmedAgain.labels(), writes(confirmedAgain)],
    ['Made the change you confirmed', true, [], []]);

  // This device's clock is behind Chickpea's, which says it expired.
  const late = await turnOff();
  const expiresAt = Date.parse((late.structuredContent as { confirmation: { expiresAt: string } }).confirmation.expiresAt);
  const now = clock.now;
  clock.now = expiresAt + 1_000;
  const lateAgain = await reopen(late, expiresAt - 60_000);
  assert.deepEqual([lateAgain.shown.title, lateAgain.labels()], ['This confirmation expired', []]);
  clock.now = now;

  // Still waiting: its buttons, once both reads answer.
  const pending = await turnOff();
  const waiting = cardHost(AGENT_CARD, asChatGpt(call), clock);
  waiting.hold = ({ tool }) => tool === 'get_confirmation';
  await waiting.result(pending);
  assert.deepEqual([waiting.labels(), waiting.shown.busy], [['Turn off (danger)', 'Keep it on (secondary)'], true], 'get_agent answered; get_confirmation is out');
  await waiting.press('keep');
  assert.deepEqual(writes(waiting), [], 'a press while it asks sends nothing');
  await waiting.answer();
  assert.deepEqual([waiting.labels(), waiting.shown.busy], [['Turn off (danger)', 'Keep it on (secondary)'], false]);
  await waiting.press('keep');
  assert.equal(waiting.shown.title, 'Kept as it is');
});

// Mutation proof (review): a get_confirmation answer taken while Turn off is out draws "Made the change you confirmed"
// before Chickpea has answered the press.
test('a confirmation read that answers while a press is out leaves the card to the press\'s own answer', async (t) => {
  const { call, clock, turnOff } = await world(t, 'refusal-read-during-press');
  const pending = await turnOff();
  const card = cardHost(AGENT_CARD, asChatGpt(call), clock);
  await card.result(pending);
  // The card comes back into view and asks again, and the person presses Turn off before that read answers.
  card.hold = ({ tool }) => tool === 'get_confirmation' || tool === 'confirm_change';
  await card.dispatch({ type: 'reread', now: clock.now });
  await card.press('confirm');
  assert.deepEqual(card.held.map(({ call: made }) => made.tool), ['get_confirmation', 'confirm_change']);
  card.held[0]!.result = await call('get_confirmation', { confirmToken: tokenOf(pending) });
  assert.deepEqual(card.held[0]!.result.structuredContent, { status: 'applied' });
  await card.answer();
  assert.deepEqual([card.shown.title, card.shown.busy], ['Turn off @support?', true]);
  await card.answer();
  assert.equal(card.shown.title, 'Turned off Support Desk');
});

test('a card works before ChatGPT lists a newer card-only tool, and reads "MCP Resource not found" as unreachable, not a refusal', async (t) => {
  const { call, clock, turnOff } = await world(t, 'refusal-unlisted');
  const notListed: ToolResult = { isError: true, hostError: hostErrorOf(RESOURCE_NOT_FOUND) };
  assert.deepEqual([hostFailed(notListed), refusalOf(notListed)], [true, undefined]);

  // get_confirmation is new: until Refresh tools, ChatGPT answers it without asking Chickpea.
  const pending = await turnOff();
  const card = cardHost(AGENT_CARD, asChatGpt(call, { unlisted: ['get_confirmation'] }), clock);
  await card.result(pending);
  assert.deepEqual([card.labels(), card.shown.busy, card.shown.error], [['Turn off (danger)', 'Keep it on (secondary)'], false, undefined]);
  await card.press('keep');
  assert.equal(card.shown.title, 'Kept as it is', 'Keep works without it');

  // A press whose tool ChatGPT has not listed: Chickpea could not be reached, and the button stays to try again.
  const second = await turnOff();
  const pressed = cardHost(AGENT_CARD, asChatGpt(call, { unlisted: ['decline_change'] }), clock);
  await pressed.result(second);
  pressed.hold = ({ tool }) => tool === 'decline_change';
  await pressed.press('keep');
  await pressed.answer('unreachable');
  assert.deepEqual([pressed.shown.title, pressed.labels(), pressed.shown.error],
    ['Turn off @support?', ['Turn off (danger)', 'Keep it on (secondary)'], 'Chickpea could not be reached. Try again.']);
  assert.deepEqual([pressed.effects.filter(({ type }) => type === 'context'), pressed.state.outcome], [[], undefined], 'nothing told or kept');
});

// Mutation proof (probe 13): a bridge that keeps the host's message carries the page, IP address and all, into the card.
test('a host\'s error page, as ChatGPT sends one for a call cut off at 300 s, reads as unreachable, and none of it reaches the card', async (t) => {
  const { f, call, clock, turnOff } = await world(t, 'refusal-gateway');
  assert.deepEqual(hostErrorOf(GATEWAY_TIMEOUT), { code: -32000 }, 'the page never comes in');
  const pending = await turnOff();
  const timedOut = ['confirm_change'];
  const card = cardHost(AGENT_CARD, asChatGpt(call, { timedOut }), clock);
  await card.result(pending);
  await card.press('confirm');
  assert.equal((await f.config.getAgent('agent_support'))!.enabled, false, 'ChatGPT gave up, and the server made the change');
  assert.deepEqual([card.shown.title, card.labels(), card.shown.error],
    ['Turn off @support?', ['Turn off (danger)', 'Keep it on (secondary)'], 'Chickpea could not be reached. Try again.']);
  const everything = JSON.stringify([card.state, card.shown, card.effects]);
  for (const words of ['Gateway time-out', 'gateway time-out', GATEWAY_TIMEOUT_IP, 'Ray ID', 'Cloudflare', 'cf-wrapper']) {
    assert.equal(everything.includes(words), false, `${words} reached the card`);
  }
  // Turn off again: Chickpea answers with what it did.
  timedOut.length = 0;
  await card.press('confirm');
  assert.deepEqual([card.shown.title, card.calls('confirm_change').length], ['Turned off Support Desk', 2]);
});
