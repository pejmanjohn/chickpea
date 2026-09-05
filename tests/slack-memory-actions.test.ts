import { appliedMemoryReceipt, parseSlackMemoryUpdate, verifyMemoryUpdateAcknowledgement } from '../src/slack/memory-update-terminal.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { validateToolArguments } from '@earendil-works/pi-ai';

import { slackMemoryUpdateArguments, slackUpdateAgentMemoryInputSchema } from '../src/management/slack-memory-actions.ts';
import { createSlackManagementTurnGuard, invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

test('memory tool has a portable two-field schema and rejects model-selected authority', () => {
  const input = { expectedRevision: 0, body: 'The warehouse opens at nine.' };
  const parameters = toJsonSchema(slackUpdateAgentMemoryInputSchema, { errorMode: 'ignore' });
  assert.deepEqual(Object.keys(parameters.properties!), ['expectedRevision', 'body']);
  assert.deepEqual(validateToolArguments({ name: 'update_agent_memory', description: '', parameters }, {
    type: 'toolCall', id: 'memory', name: 'update_agent_memory', arguments: input,
  }), input);
  assert.throws(() => v.parse(slackUpdateAgentMemoryInputSchema, { ...input, agentId: 'other' }));
  assert.throws(() => v.parse(slackUpdateAgentMemoryInputSchema, { ...input, expectedRevision: -1 }));
  assert.throws(() => v.parse(slackUpdateAgentMemoryInputSchema, { ...input, expectedRevision: 1.5 }));
});

test('memory tool delegates scoped, idempotent writes and forget to existing management authority', async () => {
  const f = await createManagementAdapterFixture('memory-tool');
  try {
    const agent = await f.config.createAgent({
      ...createDemoStarterAgent(), id: 'agent_memory_tool',
      creatorMembershipId: f.admin.membership.id, editPolicy: 'creator_and_admins',
    });
    const signal = {
      agentId: agent.id, workspaceId: f.admin.binding.slackTeamId,
      channelId: 'D_MEMORY_TOOL', threadTs: '400.1',
      slackUserId: f.admin.binding.slackUserId, eventId: 'Ev_memory',
      messageTs: '400.1', turnJobId: 'turn_memory',
    };
    const args = slackMemoryUpdateArguments(signal, { expectedRevision: 0, body: 'The warehouse opens at nine.' });
    assert.equal(args.operations[0]?.kind, 'update_agent_memory');
    const invoke = (nextSignal = signal, nextArgs = args) => invokeSlackWorkspaceManagementTool({
      signal: nextSignal, identity: f.identity, service: f.service,
      name: 'apply_workspace_changes', args: nextArgs,
    });
    const saved = await invoke();
    assert.equal(saved.ok, true);
    assert.ok(saved.ok);
    const hint = appliedMemoryReceipt(saved.result, agent.id)!;
    assert.ok(hint);
    assert.deepEqual(parseSlackMemoryUpdate([hint]), hint);
    assert.equal(parseSlackMemoryUpdate([{ ...hint, body: 'untrusted' }]), undefined);
    assert.equal(parseSlackMemoryUpdate([hint, hint]), undefined);
    const actor = await resolveSlackManagementActor(signal, f.identity);
    const verify = (turnJobId = signal.turnJobId, live = true, nextHint = hint) =>
      verifyMemoryUpdateAcknowledgement({
        hint: nextHint, agentId: agent.id, turnJobId,
        getOperation: (id) => f.service.getOperation(actor, id),
        validateReceiptLease: async (revision) => live && revision === (await f.memory.getAgentMemory(agent.id)).revision,
      });
    assert.equal(await verify(), true, 'durable own-turn receipt authorizes a host acknowledgement');
    assert.equal(await verify('other-turn'), false, 'another turn cannot reuse a receipt');
    assert.equal(await verify(signal.turnJobId, false), false, 'revoked visibility fails closed');
    assert.equal(await verify(signal.turnJobId, true, { ...hint, revision: 99 }), false);

    assert.deepEqual(await invoke(), saved, 'retry returns the same receipt');
    assert.equal((await f.memory.getAgentMemory(agent.id)).revision, 1);
    const recalled = await invokeSlackWorkspaceManagementTool({
      signal: { ...signal, threadTs: '500.1' }, identity: f.identity, service: f.service,
      name: 'inspect_memory', args: { agentId: agent.id },
    });
    assert.deepEqual(recalled, { ok: true, result: {
      agentId: agent.id, body: 'The warehouse opens at nine.', revision: 1,
    } });
    const blocked = await invoke({ ...signal, slackUserId: 'U_UNKNOWN' });
    assert.equal(blocked.ok, false);
    const stale = await invoke(signal, slackMemoryUpdateArguments({ ...signal, turnJobId: 'turn_stale' }, {
      expectedRevision: 0, body: 'Overwrite stale memory.',
    }));
    assert.match(JSON.stringify(stale), /revision_conflict/);
    assert.equal((await f.memory.getAgentMemory(agent.id)).body, 'The warehouse opens at nine.');
    const guard = createSlackManagementTurnGuard('turn_guard', { turnJobId: 'turn_guard' });
    guard.recordConfirmationFailure({ code: 'revision_conflict', proposalId: 'proposal_old' });
    const guarded = await invokeSlackWorkspaceManagementTool({
      signal, identity: f.identity, service: f.service, name: 'apply_workspace_changes', args,
      turnGuard: guard,
    });
    assert.match(JSON.stringify(guarded), /fresh_approval_required/);
    const forget = await invoke(signal, slackMemoryUpdateArguments({ ...signal, turnJobId: 'turn_forget' }, {
      expectedRevision: 1, body: '',
    }));
    assert.equal(forget.ok, true);
    assert.equal((await f.memory.getAgentMemory(agent.id)).body, '');
    assert.equal(await verify(), false, 'a later forget invalidates an earlier acknowledgement');
  } finally { f.close(); }
});
