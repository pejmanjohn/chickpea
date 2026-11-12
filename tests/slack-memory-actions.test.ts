import { appliedMemoryReceipt, parseSlackMemoryUpdate } from '../src/slack/memory-update-terminal.ts';
import { resolveSlackManagementActor } from '../src/management/slack-tools.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { toJsonSchema } from '@valibot/to-json-schema';
import { validateToolArguments } from '@earendil-works/pi-ai';

import {
  executeSlackMemoryUpdate,
  slackMemoryUpdateArguments,
  slackUpdateAgentMemoryInputSchema,
  SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION,
} from '../src/management/slack-memory-actions.ts';
import { invokeSlackWorkspaceManagementTool } from '../src/management/slack-tools.ts';
import { resultFromAgentReply } from '../src/slack/flue-dispatch.ts';
import type { AgentReply } from '@flue/runtime';
import { createDemoStarterAgent } from '../src/config/seed.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';
import { slackTurnSignal } from './helpers/slack-turn-signal.ts';

test('memory tool input is portable and rejects model-selected authority', () => {
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

test('memory tool contract carries exact actionable references and their qualifiers', () => {
  const url = 'https://app.slack.com/client/T_WORKSPACE/unified-files/list/F_LIST';
  const body = `For channel C_CHANNEL, use ${url} unless another tool or List is explicitly named. Do not use it in DMs or other channels.`;
  const args = slackMemoryUpdateArguments({ agentId: 'a', turnJobId: 't' }, {
    expectedRevision: 3,
    body,
  });

  assert.equal(args.operations[0]?.kind, 'update_agent_memory');
  assert.equal(args.operations[0]?.kind === 'update_agent_memory' ? args.operations[0].body : undefined, body);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /copy that wording verbatim/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /do not paraphrase, compress, generalize, or change its exceptions/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /text following "Remember:" and a quoted note/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /only permitted change.+include the exact URL with the label/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /host always delivers your final reply/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /confirmation may paraphrase.+body remains verbatim/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /never quote or restate anything being forgotten/i);
  assert.doesNotMatch(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /summary|withhold/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /ordinary conversational facts.+may still be restated concisely/i);
  assert.match(SLACK_UPDATE_AGENT_MEMORY_DESCRIPTION, /exclude directions about the act of remembering or this turn only/i);
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
      messageTs: '400.1', turnJobId: 'turn_memory', requesterText: 'Remember that the warehouse opens at nine.',
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
    const legacyHint = { ...hint, summary: 'I updated my memory.', preservesContext: true, chainedFrom: 0 };
    assert.deepEqual(parseSlackMemoryUpdate([legacyHint]), hint, 'older receipts still read, without their legacy fields');
    assert.deepEqual(parseSlackMemoryUpdate([hint, hint]), hint);

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
    const forget = await invoke(signal, slackMemoryUpdateArguments({ ...signal, turnJobId: 'turn_forget' }, {
      expectedRevision: 1, body: '',
    }));
    assert.equal(forget.ok, true);
    assert.equal((await f.memory.getAgentMemory(agent.id)).body, '');
  } finally { f.close(); }
});

test('memory tool handler returns the applied receipt and nothing for a failed write', async () => {
  let applied = 0;
  const { receipt } = await executeSlackMemoryUpdate({
    signal: { agentId: 'a', turnJobId: 't' },
    data: { expectedRevision: 0, body: 'Use readable dates.' },
    apply: async () => {
      applied += 1;
      return { ok: true, result: { status: 'completed', operationId: 'op', outcomes: [{
        operationKind: 'update_agent_memory', disposition: 'applied', changed: [{ kind: 'memory', id: 'a', revision: 1 }],
      }] } };
    },
  });
  assert.equal(applied, 1);
  assert.deepEqual(receipt, { operationId: 'op', revision: 1 });
  const rejected = await executeSlackMemoryUpdate({
    signal: { agentId: 'a', turnJobId: 't' },
    data: { expectedRevision: 0, body: 'Use dates.' },
    apply: async () => ({ ok: false, error: { code: 'revision_conflict', message: 'Changed' } }),
  });
  assert.equal(rejected.receipt, undefined, 'a failed write never emits a receipt');
});

test('a reply with several memory receipts hands delivery the newest one', () => {
  const reply = (receipts: unknown[]): AgentReply => ({ text: 'ok', data: { slackMemoryUpdate: receipts }, submissionId: 's' });
  const first = { operationId: 'management_first', revision: 4 };
  const second = { operationId: 'management_second', revision: 5 };
  assert.deepEqual(resultFromAgentReply(reply([first, second]), null).memoryUpdate, second);
  assert.deepEqual(resultFromAgentReply(reply([second, first]), null).memoryUpdate, second);
  assert.deepEqual(resultFromAgentReply(reply([first, first]), null).memoryUpdate, first, 'a redriven call repeats its receipt');
  assert.equal(resultFromAgentReply(reply([first, { revision: 'x' }]), null).memoryUpdate, undefined);
  assert.equal(resultFromAgentReply(reply([]), null).memoryUpdate, undefined);
});

test('an ask turn proposes a memory write the person did not ask for; a person\'s turn writes it immediately', async () => {
  const f = await createManagementAdapterFixture('memory-ask');
  try {
    const save = async (name: 'person' | 'ask', turn: Pick<NormalizedSlackTurn, 'text' | 'agentAsk'>) => {
      const agent = await f.config.createAgent({
        ...createDemoStarterAgent(), id: `agent_memory_${name}`,
        creatorMembershipId: f.admin.membership.id, editPolicy: 'creator_and_admins',
      });
      const signal = slackTurnSignal({
        turn: { ...turn, eventId: `Ev_memory_${name}`, messageTs: '600.2' },
        agentId: agent.id,
        conversation: { workspaceId: f.admin.binding.slackTeamId, channelId: 'C_MEMORY_ASK', threadTs: '600.1' },
        conversationKind: 'channel',
        slackUserId: f.admin.binding.slackUserId,
      });
      const saved = await invokeSlackWorkspaceManagementTool({
        signal, identity: f.identity, service: f.service, name: 'apply_workspace_changes',
        args: slackMemoryUpdateArguments(signal, { expectedRevision: 0, body: 'The warehouse opens at nine.' }),
      });
      assert.ok(saved.ok);
      const actor = await resolveSlackManagementActor(signal, f.identity);
      const memory = await f.memory.getAgentMemory(agent.id);
      return { origin: actor.origin, hint: appliedMemoryReceipt(saved.result, agent.id), body: memory.body };
    };
    const words = 'Remember that the warehouse opens at nine.';
    const person = await save('person', { text: words });
    const ask = await save('ask', {
      text: words,
      agentAsk: { fromAgentId: 'agent_helper', fromAgentName: 'Helper', fromAgentHandle: 'helper', originMessageTs: '600.1' },
    });
    assert.equal(person.origin.kind === 'slack' && person.origin.requestText, words);
    assert.ok(person.hint, 'the person\'s own request writes immediately');
    assert.equal(person.body, 'The warehouse opens at nine.');
    assert.equal(ask.origin.kind === 'slack' && 'requestText' in ask.origin, false);
    assert.equal(ask.hint, undefined, 'an Agent\'s words write nothing');
    assert.equal(ask.body, '');
  } finally {
    f.close();
  }
});

