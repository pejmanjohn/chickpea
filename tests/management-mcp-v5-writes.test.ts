import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { confirmedSummary } from '../src/management/mcp-v5/changes.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import { ManagementError, type ManagementActorContext, type ManagementChangeSetPreview } from '../src/management/types.ts';
import {
  createFixtureAgent,
  createManagementAdapterFixture,
  ownerSlackDmContext,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { serviceResult } from './helpers/management-service-result.ts';
import { withPersonApproval } from './helpers/slack-person-approval.ts';

const NOW = 1_800_000_000_000;
const THIRTY_MINUTES = 30 * 60_000;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown> & { error?: Record<string, unknown> };
  isError?: boolean;
};
type Call = (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
type Person = 'owner' | 'admin';

/**
 * One workspace on a clock the test moves. `as` names the person each call
 * acts as and the client they connected; `member` demotes the second person.
 */
async function harness(
  t: TestContext,
  suffix: string,
  options: {
    member?: boolean;
    overrides?: Partial<WorkspaceManagementServiceInput>;
    slackFacts?: WorkspaceManagementServiceInput['slackFacts'];
  } = {},
) {
  const clock = { now: NOW };
  const f = await createManagementAdapterFixture(suffix, {
    now: () => clock.now,
    ...(options.slackFacts ? { slackFacts: options.slackFacts } : {}),
    ...options.overrides,
  });
  t.after(() => f.close());
  if (options.member) {
    await f.identity.updateMembershipAuthority({
      membershipId: f.admin.membership.id,
      role: 'member',
      actorMembershipId: f.owner.membership.id,
      correlationId: `${suffix}-demotion`,
      authenticationSurface: 'better_auth',
      reasonCode: 'mcp_v5_test',
    });
  }
  const as = (who: Person, clientId = `client_${suffix}`): Call => {
    const person = who === 'owner' ? f.owner : f.admin;
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: person.binding.betterAuthUserId ?? `ba_${who}`,
      userId: person.user.id,
      membershipId: person.membership.id,
      organizationId: person.membership.organizationId,
      role: who === 'owner' ? 'owner' : options.member ? 'member' : 'admin',
      clientId,
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
      { legacy: 'stateless' },
    );
    return async (name, args = {}) => {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const json = body.trimStart().startsWith('{')
        ? body
        : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return (JSON.parse(json) as { result: ToolResult }).result;
    };
  };
  return { f, clock, as, call: as('owner'), teamId: f.owner.binding.slackTeamId };
}

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0]!.text), result.structuredContent, 'the text block carries the same JSON');
  return result.structuredContent;
}

function errorOf(result: ToolResult, code: string): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = result.structuredContent?.error;
  assert.ok(error, `a 5.0 error carries structuredContent.error: ${JSON.stringify(result)}`);
  assert.equal(error.code, code, JSON.stringify(error));
  assert.ok(result.content[0]!.text.startsWith(error.message as string));
  return error;
}

function assertNoInternalIds(serialized: string, f: ManagementAdapterFixture): void {
  for (const forbidden of [
    f.owner.membership.organizationId, f.owner.membership.id, f.owner.user.id,
    f.admin.membership.id, f.admin.user.id, '"revision"', 'configurationGeneration', 'creatorMembershipId',
    'organizationId', 'membershipId', 'effectiveRevision', 'proposalId', 'operationId',
    'confirm_workspace_change', 'apply_workspace_changes',
  ]) assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked: ${serialized.slice(Math.max(0, serialized.indexOf(forbidden) - 300), serialized.indexOf(forbidden) + 100)}`);
}

async function grantChannel(f: ManagementAdapterFixture, teamId: string, agentId: string, channelId = 'C_SUPPORT') {
  await f.config.putChannel({ workspaceId: teamId, channelId, label: channelId.slice(2).toLowerCase(), lifecycle: 'active' });
  await f.config.putAgentChannelGrant({
    workspaceId: teamId,
    channelId,
    agentId,
    status: 'active',
    createdByMembershipId: f.owner.membership.id,
    channelLabel: channelId.slice(2).toLowerCase(),
  });
}

/** The owner signed in through one app, as the 5.0 tools reach the service. */
function mcpOwner(f: ManagementAdapterFixture, clientId: string): ManagementActorContext {
  return {
    userId: f.owner.user.id, membershipId: f.owner.membership.id, organizationId: f.owner.membership.organizationId,
    origin: { kind: 'mcp', clientId },
  };
}

async function version(call: Call, agentId: string): Promise<string> {
  return structured(await call('get_agent', { agentId })).version;
}

test('create_agent takes propose_agent\'s arguments unchanged, joins its Channels, says hello, and replays', async (t) => {
  const { f, call, teamId } = await harness(t, 'create');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  const proposed = structured(await call('propose_agent', {
    name: 'Support Desk',
    handle: 'support-desk',
    job: 'Answers support questions from the help center.',
    instructions: 'Answer from the help center and link the article.',
    sampleAsk: 'How do I reset my password?',
    promisedAnswer: 'Open Settings, then Security.',
    channels: ['#support'],
  }));
  const args = proposed.create.arguments;

  const created = structured(await call('create_agent', args));
  assert.equal(created.status, 'done');
  // The summary is for the person, so it names no tool; following its arrival is the model's next step.
  assert.equal(created.summary, 'Created Support Desk. It joins 1 Channel.');
  assert.equal(created.nextStep, 'get_creation_status follows its arrival in Slack.');
  const { agentId } = created.agent;
  assert.equal(agentId, 'agent_support_desk');
  assert.equal(created.agent.links.admin, 'https://chickpea.example.test/admin/agents/agent_support_desk');
  assert.equal(created.undoToken, undefined, 'a creation has no undo');
  assert.equal(created.version, await version(call, agentId));
  const stored = await f.config.getAgent(agentId);
  assert.deepEqual([stored.name, stored.description, stored.enabled], ['Support Desk', 'Answers support questions from the help center.', true]);
  const grants = await f.config.listAgentChannelGrants(teamId, 'C_SUPPORT');
  assert.deepEqual(grants.map(({ agentId: granted, status }) => [granted, status]), [[agentId, 'active']]);

  // The hello in Slack (DB-2) ends with the first ask the proposal showed.
  const welcomes = await f.management.execute({
    kind: 'list_direct_agent_creation_welcomes',
    userId: f.owner.user.id,
    agentId,
    requesterMembershipId: f.owner.membership.id,
  }) as { outbox: Array<{ receipt: { firstAsk?: string } }> };
  assert.equal(welcomes.outbox[0]?.receipt.firstAsk, 'How do I reset my password?');
  assert.equal(await f.config.getAgentFirstAsk(agentId), 'How do I reset my password?', 'the creation stores its ask');
  assert.equal(structured(await call('get_creation_status', { agentId })).channels, 'joined');

  // A retry replays: the same result, and no second Agent or welcome.
  assert.deepEqual(structured(await call('create_agent', args)), created);
  assert.equal((await f.config.listUserAgents()).length, 1);
  errorOf(await call('create_agent', { ...args, name: 'Billing Desk', handle: 'billing-desk', channels: undefined }), 'key_reused');

  // A near-duplicate asks first; a distinct one needs its own handle.
  const similar = structured(await call('create_agent', { ...args, channels: undefined, idempotencyKey: 'again' }));
  assert.equal(similar.status, 'similar_agent_exists');
  assert.deepEqual(similar.matches, [{ agentId, name: 'Support Desk', handle: 'support-desk' }]);
  const distinct = structured(await call('create_agent', {
    name: 'Support Desk', handle: 'support-desk-two', instructions: 'Second desk.', createEvenIfSimilar: true, idempotencyKey: 'distinct',
  }));
  assert.equal(distinct.agent.agentId, 'agent_support_desk_2', 'a derived agentId skips one in use');
  assert.equal(await f.config.getAgentFirstAsk(distinct.agent.agentId), null, 'a creation without an ask stores none');

  errorOf(await call('create_agent', {
    name: 'Nowhere', instructions: 'x', channels: ['#no-such-channel'], idempotencyKey: 'nowhere',
  }), 'invalid_input');
  assert.equal((await f.config.listUserAgents()).some(({ name }) => name === 'Nowhere'), false, 'an unknown Channel creates nothing');
  assertNoInternalIds(JSON.stringify({ created, similar, distinct }), f);
});

test('update_agent checks the version, replays a retry, refuses a reused key, and saves a field and image model pair', async (t) => {
  const { f, as, call } = await harness(t, 'update');
  await createFixtureAgent(f, 'agent_research');
  const read = await version(call, 'agent_research');

  const saved = structured(await call('update_agent', {
    agentId: 'agent_research', version: read, description: 'Finds and cites sources.', idempotencyKey: 'describe',
  }));
  assert.deepEqual([saved.status, saved.summary, saved.agent.agentId], ['done', 'Saved Research.', 'agent_research']);
  assert.notEqual(saved.version, read);
  assert.equal(saved.version, await version(call, 'agent_research'), 'the version a next change sends');
  assert.match(saved.undoToken, /^mcp5_/);

  // The retry's version is stale now, but the stored result answers first.
  assert.deepEqual(structured(await call('update_agent', {
    agentId: 'agent_research', version: read, description: 'Finds and cites sources.', idempotencyKey: 'describe',
  })), saved);
  // The same person's identical call from another app is that app's own call, so nothing replays.
  const afterSave = await f.config.getAgent('agent_research');
  errorOf(await as('owner', 'client_other_app')('update_agent', {
    agentId: 'agent_research', version: read, description: 'Finds and cites sources.', idempotencyKey: 'describe',
  }), 'changed_since_read');
  assert.deepEqual(await f.config.getAgent('agent_research'), afterSave);
  // The stored result is bound to its app too: its own app reads it by ID, another app finds nothing.
  const readBack = (clientId: string) => serviceResult(() => f.service.getOperation(mcpOwner(f, clientId), saved.undoToken));
  assert.equal((await readBack('client_update')).ok, true);
  const elsewhere = await readBack('client_other_app');
  assert.equal(elsewhere.ok ? undefined : elsewhere.error.code, 'operation_not_found');
  errorOf(await call('update_agent', {
    agentId: 'agent_research', version: saved.version, description: 'Other words.', idempotencyKey: 'describe',
  }), 'key_reused');
  const stale = errorOf(await call('update_agent', {
    agentId: 'agent_research', version: read, description: 'Other words.', idempotencyKey: 'stale',
  }), 'changed_since_read');
  assert.equal(stale.retryable, true);
  assert.equal((await f.config.getAgent('agent_research')).description, 'Finds and cites sources.');
  errorOf(await call('update_agent', { agentId: 'agent_research', version: saved.version, idempotencyKey: 'empty' }), 'invalid_input');
  errorOf(await call('update_agent', {
    agentId: 'agent_research', version: saved.version, on: false, imageModel: null, idempotencyKey: 'off-and-image',
  }), 'invalid_input');

  const pair = structured(await call('update_agent', {
    agentId: 'agent_research', version: saved.version, name: 'Researcher', imageModel: null, idempotencyKey: 'pair',
  }));
  assert.deepEqual([pair.status, pair.agent.name, pair.undoToken], ['done', 'Researcher', undefined]);
  assert.equal(pair.version, await version(call, 'agent_research'));
  assertNoInternalIds(JSON.stringify({ saved, pair }), f);
});

test('turning off an Agent that answers in Channels waits for confirm_change, which only its person can use', async (t) => {
  const { f, clock, as, call, teamId } = await harness(t, 'confirm');
  await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, teamId, 'agent_research');
  const args = { agentId: 'agent_research', version: await version(call, 'agent_research'), on: false, idempotencyKey: 'off' };

  const pending = structured(await call('update_agent', args));
  assert.equal(pending.status, 'needs_confirmation');
  const { confirmToken, preview, expiresAt } = pending.confirmation;
  assert.equal(expiresAt, new Date(NOW + THIRTY_MINUTES).toISOString());
  assert.ok(preview.length > 0);
  assert.equal(pending.undoToken, undefined);
  assert.equal((await f.config.getAgent('agent_research')).enabled, true, 'nothing applies before the confirmation');
  assert.deepEqual(structured(await call('update_agent', args)), pending, 'a retry returns the same confirmation');

  // Another person, or the same person in another app, cannot use the token.
  errorOf(await as('admin')('confirm_change', { confirmToken }), 'not_found');
  errorOf(await as('owner', 'client_other_app')('confirm_change', { confirmToken }), 'not_found');
  errorOf(await call('confirm_change', { confirmToken: 'changeset_unknown' }), 'not_found');
  assert.equal((await f.config.getAgent('agent_research')).enabled, true);

  clock.now += THIRTY_MINUTES - 1;
  const confirmed = structured(await call('confirm_change', { confirmToken }));
  assert.deepEqual([confirmed.status, confirmed.agent.agentId], ['done', 'agent_research']);
  assert.equal((await f.config.getAgent('agent_research')).enabled, false);
  assert.ok(confirmed.undoToken, 'a confirmed change can be undone');
  assert.equal(confirmed.version, await version(call, 'agent_research'));

  // Replays: confirming again after the lifetime, and retrying the first call.
  clock.now += THIRTY_MINUTES;
  assert.deepEqual(structured(await call('confirm_change', { confirmToken })), confirmed);
  errorOf(await as('admin')('confirm_change', { confirmToken }), 'not_found');
  errorOf(await as('owner', 'client_other_app')('confirm_change', { confirmToken }), 'not_found');
  assert.equal(structured(await call('update_agent', args)).status, 'done');
  assertNoInternalIds(JSON.stringify({ pending, confirmed }), f);
});

test('a confirmToken expires 30 minutes after it was made; a new call makes a fresh one', async (t) => {
  const { f, clock, as, call, teamId } = await harness(t, 'expiry');
  await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, teamId, 'agent_research');
  const args = { agentId: 'agent_research', version: await version(call, 'agent_research'), on: false, idempotencyKey: 'off' };
  const { confirmToken } = structured(await call('update_agent', args)).confirmation;

  clock.now += THIRTY_MINUTES;
  // The binding is checked before the expiry, so an expired token tells no one else it exists.
  errorOf(await as('admin')('confirm_change', { confirmToken }), 'not_found');
  errorOf(await as('owner', 'client_other_app')('confirm_change', { confirmToken }), 'not_found');
  const expired = errorOf(await call('confirm_change', { confirmToken }), 'confirmation_expired');
  assert.equal(expired.retryable, true);
  assert.match(expired.nextStep as string, /new idempotencyKey/);
  assert.equal((await f.config.getAgent('agent_research')).enabled, true);
  errorOf(await call('update_agent', args), 'confirmation_expired');

  // The service enforces it, so no door confirms the token.
  await assert.rejects(f.service.confirmWorkspaceChange({ context: mcpOwner(f, 'client_expiry'), proposalId: confirmToken }),
    (error: unknown) => error instanceof ManagementError && error.code === 'proposal_expired');

  const fresh = structured(await call('update_agent', { ...args, idempotencyKey: 'off-again' }));
  assert.notEqual(fresh.confirmation.confirmToken, confirmToken);
  assert.equal(fresh.confirmation.expiresAt, new Date(clock.now + THIRTY_MINUTES).toISOString());
  assert.equal(structured(await call('confirm_change', { confirmToken: fresh.confirmation.confirmToken })).status, 'done');
  assert.equal((await f.config.getAgent('agent_research')).enabled, false);
});

test('the confirmation preview shows a crafted Agent name as its text, on one line', async (t) => {
  const { f, call, teamId } = await harness(t, 'preview');
  const agent = await createFixtureAgent(f, 'agent_research', {
    name: 'Research ![p](https://evil.example/px?d=1)\n[Click to approve](https://evil.example/a)\r\n**Nothing is removed**',
  });
  await grantChannel(f, teamId, 'agent_research');
  const { preview } = structured(await call('update_agent', {
    agentId: agent.id, version: await version(call, agent.id), on: false, idempotencyKey: 'off',
  })).confirmation;
  const shown = String.raw`Research !\[p\](https://evil.example/px?d=1) \[Click to approve\](https://evil.example/a) \*\*Nothing is removed\*\*`;
  assert.ok(preview.includes(`**${shown} — `), preview);
  assert.doesNotMatch(preview, /(?<!\\)!\[|(?<!\\)\]\(/, 'no image or link survives');
  assert.doesNotMatch(preview, /^\s*(?:\\?\[Click|\\?\*\\?\*Nothing)/m, 'the name adds no line');

  // The change set's own Markdown, which the Slack door carries, is the same.
  const applied = await f.service.applyWorkspaceChanges({
    context: mcpOwner(f, 'client_preview'), idempotencyKey: 'set-off', confirmationLifetimeMs: THIRTY_MINUTES,
    operations: [{ itemId: 'off', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch: { enabled: false } }],
  });
  assert.ok('presentation' in applied && applied.presentation?.markdown?.includes(`**${shown} — `), JSON.stringify(applied));
});

// What a 4.x tool left behind: apply_workspace_changes and undo_workspace_change made sets with no
// expiry, through the same service call this makes. 5.0.0 removed the tool that confirmed them.
test('a confirmation a 4.x tool left pending expired with 5.0.0; its ids carry over, and Slack\'s never expire', async (t) => {
  const { f, call, teamId } = await harness(t, 'legacy');
  const agent = await createFixtureAgent(f, 'agent_research');
  await grantChannel(f, teamId, 'agent_research');
  const fourX = mcpOwner(f, 'client_legacy');
  const off = [{ itemId: 'off', kind: 'update_agent' as const, agentId: agent.id, expectedRevision: agent.revision, patch: { enabled: false } }];
  const left = await f.service.applyWorkspaceChanges({ context: fourX, idempotencyKey: 'legacy-off', operations: off });
  assert.ok('outcomes' in left && left.status === 'confirmation_required');
  assert.equal(left.confirmation, undefined, 'a set with no expiry');
  assert.equal(left.presentation, undefined, 'shows no preview: it reads as expired');
  const confirmToken = left.outcomes[0]!.proposalId!;
  assert.equal((await f.management.getChangeSetProposal(confirmToken))?.expiresAt, undefined);

  // confirm_change refuses it as expired and applies nothing; get_confirmation says so; a replay shows no preview.
  const refused = errorOf(await call('confirm_change', { confirmToken }), 'confirmation_expired');
  assert.match(refused.nextStep as string, /new idempotencyKey/);
  assert.equal((await f.config.getAgent(agent.id)).enabled, true);
  assert.deepEqual(structured(await call('get_confirmation', { confirmToken })), { status: 'expired' });
  const replayed = await f.service.applyWorkspaceChanges({ context: fourX, idempotencyKey: 'legacy-off', operations: off });
  assert.ok('outcomes' in replayed && replayed.presentation === undefined && replayed.confirmation === undefined);
  // decline_change still retires it.
  assert.equal(structured(await call('decline_change', { confirmToken })).status, 'unchanged');
  assert.equal((await f.management.getChangeSetProposal(confirmToken))?.status, 'stale');

  // A set a 4.x tool confirmed before 5.0.0 still replays its result.
  const done = await f.service.applyWorkspaceChanges({ context: fourX, idempotencyKey: 'legacy-off-2', operations: off });
  assert.ok('outcomes' in done);
  const doneToken = done.outcomes[0]!.proposalId!;
  const record = (await f.management.getChangeSetProposal(doneToken))!;
  await f.management.claimChangeSetProposal({
    proposalId: doneToken, organizationId: record.organizationId, actorUserId: record.actorUserId,
    actorMembershipId: record.actorMembershipId, originKey: record.originKey, approvalScopeKey: record.approvalScopeKey, at: NOW,
  });
  const completed = { ...done, status: 'completed' as const };
  await f.management.completeChangeSetProposal(doneToken, completed, NOW);
  assert.deepEqual(await f.service.confirmWorkspaceChange({ context: fourX, proposalId: doneToken }), completed);

  // The ids that carry over: a 4.x change's operationId undoes through undo_change, and a 4.x setup link's
  // setupOperationId reads through get_setup_status.
  const renamed = await f.service.applyWorkspaceChanges({
    context: fourX, idempotencyKey: 'legacy-rename',
    operations: [{ itemId: 'name', kind: 'update_agent', agentId: agent.id, expectedRevision: (await f.config.getAgent(agent.id)).revision,
      patch: { description: 'Renamed by 4.x.' } }],
  });
  assert.ok('outcomes' in renamed && renamed.status === 'completed');
  const undone = structured(await call('undo_change', { undoToken: renamed.operationId, idempotencyKey: 'undo-4x' }));
  assert.equal(undone.status, 'done');
  assert.equal((await f.config.getAgent(agent.id)).description, undefined);
  const setup = await f.service.applyWorkspaceChanges({
    context: fourX, idempotencyKey: 'legacy-setup',
    operations: [{ itemId: 'key', kind: 'request_setup', target: { kind: 'provider_credential', providerId: 'openai' } }],
  });
  assert.ok('outcomes' in setup);
  const setupToken = setup.outcomes[0]!.setupOperationId!;
  assert.equal(typeof setupToken, 'string');
  assert.equal(structured(await call('get_setup_status', { setupToken })).status, 'waiting');

  // Slack's sets have no expiry by design, and the person's approval still applies one; it names no confirmed preview.
  const slack = ownerSlackDmContext(f);
  const held = await f.service.applyWorkspaceChanges({ context: slack, idempotencyKey: 'slack-off', operations: [{
    ...off[0]!, expectedRevision: (await f.config.getAgent(agent.id)).revision,
  }] });
  assert.ok('outcomes' in held && held.status === 'confirmation_required', JSON.stringify(held));
  const slackToken = held.outcomes[0]!.proposalId!;
  assert.equal((await f.management.getChangeSetProposal(slackToken))?.expiresAt, undefined);
  const approved = await f.service.confirmWorkspaceChange({ context: withPersonApproval(slack, slackToken), proposalId: slackToken });
  assert.deepEqual([approved.status, 'confirmed' in approved], ['completed', false]);
  assert.equal((await f.config.getAgent(agent.id)).enabled, false);
});

test('undo_change reverses a change once, replays its retry, and confirms a destructive reverse first', async (t) => {
  const { f, as, call, teamId } = await harness(t, 'undo');
  await createFixtureAgent(f, 'agent_research');
  const memory = structured(await call('get_agent_memory', { agentId: 'agent_research' }));
  const saved = structured(await call('update_agent_memory', {
    agentId: 'agent_research', version: memory.version, body: 'Cite two sources.', idempotencyKey: 'memory',
  }));
  assert.equal(saved.status, 'done');
  assert.equal(saved.version, structured(await call('get_agent_memory', { agentId: 'agent_research' })).version);
  // The token is bound to the app the change came from, like a confirmToken.
  errorOf(await as('owner', 'client_other_app')('undo_change', {
    undoToken: saved.undoToken, idempotencyKey: 'undo-elsewhere',
  }), 'nothing_to_undo');
  assert.equal(structured(await call('get_agent_memory', { agentId: 'agent_research' })).body, 'Cite two sources.');
  // And to the membership it was made under, as a confirmToken is.
  const stored = await f.management.getUndo(saved.undoToken);
  await f.management.putUndo({ ...stored!, operationId: 'mcp5_another_membership', actorMembershipId: 'membership_elsewhere' });
  errorOf(await call('undo_change', { undoToken: 'mcp5_another_membership', idempotencyKey: 'undo-membership' }), 'nothing_to_undo');
  const undone = structured(await call('undo_change', { undoToken: saved.undoToken, idempotencyKey: 'undo-memory' }));
  assert.deepEqual([undone.status, undone.summary], ['done', 'Undid the change.']);
  assert.equal(structured(await call('get_agent_memory', { agentId: 'agent_research' })).body, '');
  assert.deepEqual(structured(await call('undo_change', { undoToken: saved.undoToken, idempotencyKey: 'undo-memory' })), undone);
  errorOf(await call('undo_change', { undoToken: saved.undoToken, idempotencyKey: 'undo-twice' }), 'nothing_to_undo');
  errorOf(await call('undo_change', { undoToken: 'mcp5_unknown', idempotencyKey: 'undo-unknown' }), 'nothing_to_undo');

  // Undoing "turn on" turns off an Agent that answers in a Channel, which Admin asks about.
  await createFixtureAgent(f, 'agent_paused');
  await grantChannel(f, teamId, 'agent_paused');
  const off = structured(await call('update_agent', {
    agentId: 'agent_paused', version: await version(call, 'agent_paused'), on: false, idempotencyKey: 'off',
  }));
  assert.equal(structured(await call('confirm_change', { confirmToken: off.confirmation.confirmToken })).status, 'done');
  const on = structured(await call('update_agent', {
    agentId: 'agent_paused', version: await version(call, 'agent_paused'), on: true, idempotencyKey: 'on',
  }));
  assert.equal(on.status, 'done');
  const reverse = structured(await call('undo_change', { undoToken: on.undoToken, idempotencyKey: 'undo-on' }));
  assert.equal(reverse.status, 'needs_confirmation');
  assert.equal((await f.config.getAgent('agent_paused')).enabled, true);
  // Asking for the confirmation used the token: its retry replays, and another undo is refused.
  assert.deepEqual(structured(await call('undo_change', { undoToken: on.undoToken, idempotencyKey: 'undo-on' })), reverse);
  errorOf(await call('undo_change', { undoToken: on.undoToken, idempotencyKey: 'undo-on-again' }), 'nothing_to_undo');
  const reversed = structured(await call('confirm_change', { confirmToken: reverse.confirmation.confirmToken }));
  // A confirmed undo names what it did, as its confirmation asked it.
  assert.deepEqual([reversed.status, reversed.summary], ['done', 'Turned off Research.']);
  // The person just turned it off: nothing about trying it, or about turning it back on.
  assert.equal(reversed.nextStep, 'Research is off, so it answers no one in Slack. Don\'t suggest trying it.');
  assert.equal((await f.config.getAgent('agent_paused')).enabled, false);
  // Turned on again, the Agent is as the token's change left it, and the token stays used.
  assert.equal(structured(await call('update_agent', {
    agentId: 'agent_paused', version: reversed.version, on: true, idempotencyKey: 'on-again',
  })).status, 'done');
  errorOf(await call('undo_change', { undoToken: on.undoToken, idempotencyKey: 'undo-on-later' }), 'nothing_to_undo');
  assertNoInternalIds(JSON.stringify({ saved, undone, on, reverse, reversed }), f);
});

test('add_agent_to_channel refuses an off Agent and says to turn it on first; turned on, it adds, and undo leaves it on', async (t) => {
  const { f, call, teamId } = await harness(t, 'off-channel');
  const off = await createFixtureAgent(f, 'agent_research', { enabled: false });
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  const grants = async () => (await f.config.listAgentChannelGrants(teamId, 'C_SUPPORT')).map(({ status }) => status);

  const refused = errorOf(await call('add_agent_to_channel', {
    agentId: 'agent_research', channelId: 'C_SUPPORT', idempotencyKey: 'add-off',
  }), 'invalid_input');
  assert.deepEqual(refused, {
    code: 'invalid_input',
    message: 'Research is off. Turn it on first, then add it to the Channel.',
    retryable: false,
    nextStep: 'Ask the person whether to turn it on. If they agree, call update_agent with on: true, then call add_agent_to_channel again with a new idempotencyKey.',
  });
  assert.deepEqual(await f.config.getAgent('agent_research'), off, 'the refusal changed nothing');
  assert.deepEqual(await grants(), []);

  assert.equal(structured(await call('update_agent', {
    agentId: 'agent_research', version: await version(call, 'agent_research'), on: true, idempotencyKey: 'on',
  })).status, 'done');
  const added = structured(await call('add_agent_to_channel', {
    agentId: 'agent_research', channelId: 'C_SUPPORT', idempotencyKey: 'add-on',
  }));
  assert.deepEqual([added.status, added.agent.status, await grants()], ['done', 'on', ['active']]);

  // Adding never turns an Agent on, so undoing an add has no on or off to put back.
  assert.equal(structured(await call('undo_change', { undoToken: added.undoToken, idempotencyKey: 'undo-add' })).status, 'done');
  assert.deepEqual(await grants(), []);
  assert.equal((await f.config.getAgent('agent_research')).enabled, true);
});

test('a change saved to an Agent that is off says not to suggest trying it; one that is on says nothing of the kind', async (t) => {
  const { f, call } = await harness(t, 'off-save');
  await createFixtureAgent(f, 'agent_research', { enabled: false });
  const saved = structured(await call('update_agent', {
    agentId: 'agent_research', version: await version(call, 'agent_research'), description: 'Finds sources.', idempotencyKey: 'describe-off',
  }));
  assert.deepEqual([saved.status, saved.summary, saved.agent.status], ['done', 'Saved Research.', 'off']);
  assert.equal(saved.nextStep, 'Research is off, so it answers no one in Slack. Don\'t suggest trying it.');
  assert.equal((await f.config.getAgent('agent_research')).enabled, false, 'saving it never turns it on');

  const on = structured(await call('update_agent', {
    agentId: 'agent_research', version: saved.version, on: true, idempotencyKey: 'on',
  }));
  assert.deepEqual([on.summary, on.nextStep], ['Turned on Research.', undefined]);
  const again = structured(await call('update_agent', {
    agentId: 'agent_research', version: on.version, description: 'Finds two sources.', idempotencyKey: 'describe-on',
  }));
  assert.equal(again.nextStep, undefined);
});

test('a confirmed change is named as its confirmation asked it; several, or one it cannot name, read as the change confirmed', () => {
  const agent = { name: 'Research', handle: 'research' };
  const preview = (...changes: Array<Partial<ManagementChangeSetPreview['changes'][number]>>) => ({
    summary: '', missingSetup: [], changes: changes.map((change, index) => ({ itemId: `item_${index}`, operationKind: 'update_agent', target: 'agent:agent_research', ...change })),
  }) as ManagementChangeSetPreview;
  const named = (confirmed: ManagementChangeSetPreview | undefined) => {
    const summary = confirmedSummary(confirmed);
    return typeof summary === 'function' ? summary('Research') : summary;
  };
  assert.equal(named(preview({ before: { enabled: true }, after: { enabled: false } })), 'Turned off Research.');
  assert.equal(named(preview({ operationKind: 'revoke_agent_channel', statement: { kind: 'revoke_agent_channel', agent, channel: 'support' } })),
    'Research no longer answers in #support.');
  assert.equal(named(preview({ operationKind: 'update_member', statement: { kind: 'update_member', member: 'Dana', status: 'removed' } })),
    'Removed Dana from Chickpea.');
  assert.equal(named(preview({ operationKind: 'update_member', statement: { kind: 'update_member', member: 'Dana', role: 'owner' } })),
    'Made Dana an Owner.');
  for (const unnamed of [
    undefined,
    preview({ before: { enabled: false }, after: { enabled: true } }),
    preview({ operationKind: 'archive_agent', statement: { kind: 'archive_agent', agent, channelCount: 0 } }),
    preview({ operationKind: 'delete_agent', statement: { kind: 'delete_agent', agent } }, { before: { enabled: true }, after: { enabled: false } }),
  ]) assert.equal(named(unnamed), 'Made the change you confirmed.');
});

test('the immediate writes apply in the call, as policy.ts says for this door', async (t) => {
  const { f, call, teamId } = await harness(t, 'immediate');
  await createFixtureAgent(f, 'agent_research', {
    skills: [{ name: 'cite', description: 'Cite sources.', instructions: 'Cite two.', enabled: true }],
  });
  await grantChannel(f, teamId, 'agent_research', 'C_ROUTINE');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });

  const results: Record<string, Record<string, any>> = {};
  const run = async (name: string, args: Record<string, unknown>) => {
    const result = structured(await call(name, { idempotencyKey: name, ...args }));
    assert.notEqual(result.status, 'needs_confirmation', `${name} applies at once over MCP`);
    results[name] = result;
    return result;
  };
  await run('add_agent_to_channel', { agentId: 'agent_research', channelId: 'C_SUPPORT' });
  assert.ok((await f.config.listAgentChannelGrants(teamId, 'C_SUPPORT')).some(({ agentId }) => agentId === 'agent_research'));
  await run('save_channel_settings', { channelId: 'C_SUPPORT', label: 'help', on: true });
  assert.equal((await f.config.getChannel(teamId, 'C_SUPPORT'))?.label, 'help');
  await run('set_agent_skill', { agentId: 'agent_research', skill: 'cite', action: 'turn_off' });
  assert.equal((await f.config.getAgent('agent_research')).skills[0]?.enabled, false);
  assert.equal(structured(await call('set_agent_skill', {
    agentId: 'agent_research', skill: 'cite', action: 'turn_off', idempotencyKey: 'again',
  })).status, 'unchanged');
  const uploaded = await run('upload_skill_files', {
    agentId: 'agent_research',
    files: [{ name: 'SKILL.md', text: '---\nname: summarize\ndescription: Summarize a thread.\n---\nSummarize in three bullets.\n' }],
  });
  assert.deepEqual([uploaded.status, uploaded.added], ['done', ['summarize']]);

  const schedule = await run('save_schedule', {
    agentId: 'agent_research', channelId: 'C_ROUTINE', name: 'Morning digest', task: 'Summarize new papers.',
    when: { cron: '0 9 * * 1-5' }, timezone: 'UTC', post: 'always', requiredConnections: [],
  });
  const [listed] = structured(await call('list_schedules', { agentId: 'agent_research' })).schedules;
  assert.equal(schedule.version, listed.version);
  const paused = await run('pause_schedule', { scheduleId: listed.scheduleId, version: listed.version });
  const resumed = await run('resume_schedule', { scheduleId: listed.scheduleId, version: paused.version });
  // A run needs a served model, which this fixture has none of; the lookup still applies.
  errorOf(await call('run_schedule_now', { scheduleId: 'routine_unknown', idempotencyKey: 'run-unknown' }), 'not_found');
  await run('take_over_schedule', { scheduleId: listed.scheduleId, version: resumed.version });
  errorOf(await call('pause_schedule', { scheduleId: listed.scheduleId, version: listed.version, idempotencyKey: 'stale' }), 'changed_since_read');

  const archived = await run('archive_agent', { agentId: 'agent_research', version: await version(call, 'agent_research') });
  assert.equal((await f.config.getAgent('agent_research')).lifecycle, 'archived');
  await run('restore_agent', { agentId: 'agent_research', version: archived.version });
  assert.equal((await f.config.getAgent('agent_research')).lifecycle, 'active');

  // No idempotencyKey: each call makes a new link, as its idempotentHint false says.
  const provider = structured(await call('connect_model_provider', { provider: 'openai' }));
  assert.equal(provider.status, 'needs_setup');
  assert.match(provider.setup.url, /^http:\/\/localhost\//);
  assert.equal(structured(await call('get_setup_status', { setupToken: provider.setup.setupToken })).status, 'waiting');
  assertNoInternalIds(JSON.stringify({ results, provider }), f);
});

test('a member cannot turn Chickpea back on in a Channel an Owner turned off, and still renames one that is on', async (t) => {
  // A member sees a Channel when an Agent they can see is in it and Slack shows it to them.
  const { f, as, teamId } = await harness(t, 'channel-on', {
    member: true,
    slackFacts: async () => ({
      async lookupChannel(channelId: string) {
        return { id: channelId, name: channelId.slice(2).toLowerCase(), private: false, member: true, archived: false };
      },
      async listMemberChannels() {
        return new Set<string>();
      },
    }),
  });
  await createFixtureAgent(f, 'agent_shared', { editPolicy: 'all_workspace_members' });
  await grantChannel(f, teamId, 'agent_shared', 'C_SUPPORT');
  await grantChannel(f, teamId, 'agent_shared', 'C_HELP');
  const owner = as('owner');
  const member = as('admin');
  assert.equal(structured(await owner('save_channel_settings', {
    channelId: 'C_SUPPORT', on: false, idempotencyKey: 'owner-off',
  })).status, 'done');

  const refused = errorOf(await member('save_channel_settings', {
    channelId: 'C_SUPPORT', on: true, idempotencyKey: 'member-on',
  }), 'not_allowed');
  assert.equal(
    refused.message,
    'Chickpea is off in this Channel, and only a workspace Owner or Admin can turn it back on or change it. Ask one of them to do it.',
  );
  assert.equal(refused.fix, undefined, 'Admin has no on/off control for a Channel, so no link');
  assert.equal((await f.config.getChannel(teamId, 'C_SUPPORT'))?.lifecycle, 'archived');

  assert.equal(structured(await member('save_channel_settings', {
    channelId: 'C_HELP', label: 'helpdesk', on: true, idempotencyKey: 'member-rename',
  })).status, 'done');
  assert.equal((await f.config.getChannel(teamId, 'C_HELP'))?.label, 'helpdesk');

  assert.equal(structured(await owner('save_channel_settings', {
    channelId: 'C_SUPPORT', on: true, idempotencyKey: 'owner-on',
  })).status, 'done');
  assert.equal((await f.config.getChannel(teamId, 'C_SUPPORT'))?.lifecycle, 'active');
});

test('an Admin turns Chickpea back on in a Channel that is off', async (t) => {
  const { f, as, teamId } = await harness(t, 'channel-on-admin');
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'archived' });
  assert.equal(structured(await as('admin')('save_channel_settings', {
    channelId: 'C_SUPPORT', on: true, idempotencyKey: 'admin-on',
  })).status, 'done');
  assert.equal((await f.config.getChannel(teamId, 'C_SUPPORT'))?.lifecycle, 'active');
});

test('a member changes only the Agents they may edit, and never a workspace setting', async (t) => {
  const { f, as, teamId } = await harness(t, 'member', { member: true });
  await createFixtureAgent(f, 'agent_owner_only', {
    skills: [{ name: 'cite', description: 'Cite sources.', instructions: 'Cite two.', enabled: true }],
  });
  await grantChannel(f, teamId, 'agent_owner_only');
  const before = await f.config.getAgent('agent_owner_only');
  const member = as('admin');
  const someVersion = '0123456789abcdef';
  const refused = {
    update_agent: { agentId: before.id, version: someVersion, name: 'Mine now' },
    update_agent_memory: { agentId: before.id, version: someVersion, body: 'Mine.' },
    archive_agent: { agentId: before.id, version: someVersion },
    restore_agent: { agentId: before.id, version: someVersion },
    add_agent_to_channel: { agentId: before.id, channelId: 'C_SUPPORT' },
    set_agent_skill: { agentId: before.id, skill: 'cite', action: 'remove' },
    upload_skill_files: { agentId: before.id, files: [{ name: 'SKILL.md', text: '---\nname: x\ndescription: y\n---\nz\n' }] },
    import_skill_from_github: { agentId: before.id, source: 'owner/repo' },
  };
  for (const [name, args] of Object.entries(refused)) {
    errorOf(await member(name, { ...args, idempotencyKey: `member-${name}` }), 'not_found');
  }
  errorOf(await member('set_workspace_model', {
    role: 'chat', model: 'anthropic/claude-sonnet-4-5', version: someVersion, idempotencyKey: 'member-model',
  }), 'not_allowed');
  errorOf(await member('connect_model_provider', { provider: 'openai' }), 'not_allowed');
  errorOf(await member('save_channel_settings', { channelId: 'C_SUPPORT', on: false, idempotencyKey: 'member-off' }), 'not_allowed');
  assert.deepEqual(await f.config.getAgent('agent_owner_only'), before);
  assert.equal((await f.config.getChannel(teamId, 'C_SUPPORT'))?.lifecycle, 'active');

  // The Owner's undo is theirs alone.
  const ownerCall = as('owner');
  const memory = structured(await ownerCall('get_agent_memory', { agentId: before.id }));
  const saved = structured(await ownerCall('update_agent_memory', {
    agentId: before.id, version: memory.version, body: 'Owner notes.', idempotencyKey: 'owner-memory',
  }));
  errorOf(await member('undo_change', { undoToken: saved.undoToken, idempotencyKey: 'member-undo' }), 'nothing_to_undo');
  // The same call with the same key is another person's, so nothing replays.
  errorOf(await member('update_agent_memory', {
    agentId: before.id, version: memory.version, body: 'Owner notes.', idempotencyKey: 'owner-memory',
  }), 'not_found');

  // The Owner's agent_owner_only is hidden from the member, so a name that derives its ID takes the next one.
  const derived = { name: 'Owner Only', instructions: 'Track my notes.', idempotencyKey: 'member-derived' };
  const hiddenTaken = structured(await member('create_agent', derived));
  assert.equal(hiddenTaken.agent.agentId, 'agent_owner_only_2');
  assert.deepEqual(structured(await member('create_agent', derived)), hiddenTaken, 'a retry replays the same Agent');
  assert.equal((await f.config.getAgent('agent_owner_only')).name, before.name);
  // An agentId the caller chose is theirs to change.
  errorOf(await member('create_agent', {
    name: 'Private Notes', instructions: 'Keep notes.', agentId: 'agent_owner_only', idempotencyKey: 'member-explicit',
  }), 'invalid_input');
  assert.equal((await f.config.listUserAgents()).some(({ name }) => name === 'Private Notes'), false);

  const mine = structured(await member('create_agent', { name: 'Notes', instructions: 'Take notes.', idempotencyKey: 'member-create' }));
  const edited = structured(await member('update_agent', {
    agentId: mine.agent.agentId, version: mine.version, description: 'Takes notes.', idempotencyKey: 'member-edit',
  }));
  assert.equal(edited.status, 'done');
});

test('create_agent returns the version its Channel grants leave, and a confirm after a change says so with a next step', async (t) => {
  let published = 0;
  let fixture!: ManagementAdapterFixture;
  const overrides: Partial<WorkspaceManagementServiceInput> = {
    // As the live reconciler does, joining a Channel moves the Agent's Slack presence on.
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      published += 1;
      const grant = await fixture.config.putAgentChannelGrant({
        workspaceId, channelId, agentId, status: 'active', createdByMembershipId: actor.membershipId, channelLabel: 'support',
      });
      const agent = await fixture.config.updateAgent(agentId, { description: 'Joined.' });
      return { grant, agent };
    },
  };
  const { f, teamId, call } = await harness(t, 'create-version', { overrides });
  fixture = f;
  await f.config.putChannel({ workspaceId: teamId, channelId: 'C_SUPPORT', label: 'support', lifecycle: 'active' });
  const created = structured(await call('create_agent', {
    name: 'Support Desk', instructions: 'Answer support questions.', channels: ['C_SUPPORT'], idempotencyKey: 'create',
  }));
  assert.equal(published, 1);
  assert.equal(created.version, await version(call, created.agent.agentId), 'the version is current after the grants');
  structured(await call('update_agent', {
    agentId: created.agent.agentId, version: created.version, name: 'Support', idempotencyKey: 'rename',
  }));

  const off = structured(await call('update_agent', {
    agentId: created.agent.agentId, version: await version(call, created.agent.agentId), on: false, idempotencyKey: 'off',
  }));
  assert.equal(off.status, 'needs_confirmation');
  structured(await call('update_agent', {
    agentId: created.agent.agentId, version: await version(call, created.agent.agentId), description: 'Changed meanwhile.', idempotencyKey: 'meanwhile',
  }));
  const stale = errorOf(await call('confirm_change', { confirmToken: off.confirmation.confirmToken }), 'changed_since_read');
  assert.equal(stale.message, 'It changed since the preview, so nothing changed.');
  assert.match(String(stale.nextStep), /fresh preview and confirmToken/);
  assert.equal(stale.retryable, true);
  assert.equal((await f.config.getAgent(created.agent.agentId)).enabled, true);
});
