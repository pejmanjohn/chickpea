import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createFlueContext } from '@flue/runtime/internal';

import { ChickpeaSlack, CURRENT_SLACK_TURN_STATE_NAME } from '../src/agents/slack-thread.ts';
import {
  compileRuntimePlanV2,
  deriveLegacyRuntimePlanInstanceId,
  deriveRuntimePlanInstanceId,
  type RuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import { FLUE_CLOUDFLARE_EXTENSION_BRAND } from '../src/agents/cloudflare-extension.ts';
import {
  MAX_STAGED_TURN_INPUTS,
  createSlackTurnInput,
  parseSlackTurnInput,
  readStagedTurnInputJson,
  rememberInProcessTurnInput,
  resolveSlackTurnRenderInput,
  serializeSlackTurnInput,
  slackThreadCloudflareExtension,
  stageSlackTurnInputOnAgentObject,
  writeStagedTurnInput,
  type TurnInputSql,
} from '../src/agents/turn-input.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { slackContextSinceWatermark, threadContinuityNote } from '../src/slack/thread-continuity.ts';
import type { SlackTurnContext } from '../src/slack/thread-context.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

const AGENT: CustomAgentConfig = {
  id: 'agent_thread_continuity',
  kind: 'user',
  revision: 1,
  name: 'Continuity',
  instructions: 'Answer the thread.',
  enabled: true,
  model: 'openai/gpt-5.4-mini',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_CONT',
    channelId: 'C_CONT',
    eventId: 'E_CONT',
    text: 'What did we decide?',
    userId: 'U_ALICE',
    actorMembershipId: 'membership_alice',
    messageTs: '1788000000.000200',
    threadTs: '1788000000.000100',
    source: 'app_mention',
    contextMode: 'thread',
    ...overrides,
  };
}

function assignment(overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  return {
    workspaceId: 'T_CONT',
    channelId: 'C_CONT',
    agentId: AGENT.id,
    agent: structuredClone(AGENT),
    runtimeContract: 'chickpea-v1',
    ownerIncarnation: 1,
    model: 'openai/gpt-5.4-mini',
    modelAttribution: { source: 'pinned', providerId: 'openai' },
    ...overrides,
  };
}

function plan(overrides: {
  turn?: Partial<NormalizedSlackTurn>;
  assignment?: Partial<ResolvedAssignment>;
  memoryEpoch?: number;
  instructions?: string;
} = {}): RuntimePlanV2 {
  return compileRuntimePlanV2({
    turn: turn(overrides.turn),
    assignment: assignment(overrides.assignment),
    instructions: overrides.instructions ?? AGENT.instructions,
    memoryEpoch: overrides.memoryEpoch ?? 1,
  });
}

function sqlStorage(): TurnInputSql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      statement.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}

test('the thread instance id is the same for another speaker, a memory write, and an Agent edit', () => {
  const first = plan();
  const otherSpeaker = plan({ turn: { userId: 'U_BOB', actorMembershipId: 'membership_bob', messageTs: '1788000000.000300' } });
  const memoryWritten = plan({ memoryEpoch: 2 });
  const edited = plan({
    assignment: { agent: { ...structuredClone(AGENT), revision: 2, instructions: 'Changed.' } },
    instructions: 'Changed.',
  });
  for (const later of [otherSpeaker, memoryWritten, edited]) {
    assert.notEqual(later.harnessRevision, first.harnessRevision);
    assert.equal(deriveRuntimePlanInstanceId(later), deriveRuntimePlanInstanceId(first));
  }
  const transferred = plan({ assignment: { ownerIncarnation: 2 } });
  assert.notEqual(deriveRuntimePlanInstanceId(transferred), deriveRuntimePlanInstanceId(first));
});

test('a turn input round-trips, binds its plan to its instance, and accepts a legacy instance', () => {
  const current = plan();
  const instanceId = deriveRuntimePlanInstanceId(current);
  const input = createSlackTurnInput({ turnJobId: 'turn_1', instanceId, runtimePlan: current, memoryBlock: '<agent_memory>\nx\n</agent_memory>' });
  const parsed = parseSlackTurnInput(serializeSlackTurnInput(input));
  assert.equal(parsed.turnJobId, 'turn_1');
  assert.equal(parsed.runtimePlan.harnessRevision, current.harnessRevision);
  assert.equal(parsed.memoryBlock, '<agent_memory>\nx\n</agent_memory>');

  const legacy = createSlackTurnInput({
    turnJobId: 'turn_legacy', instanceId: deriveLegacyRuntimePlanInstanceId(current), runtimePlan: current,
  });
  assert.equal(parseSlackTurnInput(legacy).instanceId, deriveLegacyRuntimePlanInstanceId(current));

  const otherThread = plan({ turn: { threadTs: '1788000000.000900', messageTs: '1788000000.000901' } });
  assert.throws(
    () => createSlackTurnInput({ turnJobId: 'turn_x', instanceId, runtimePlan: otherThread }),
    /belongs to another instance/,
  );
  assert.throws(() => parseSlackTurnInput({ ...input, extra: true }), /unknown field/);
});

test('the agent object keeps the first staged input per turn and a bounded window', () => {
  const sql = sqlStorage();
  const current = plan();
  const instanceId = deriveRuntimePlanInstanceId(current);
  const first = serializeSlackTurnInput(createSlackTurnInput({ turnJobId: 'turn_1', instanceId, runtimePlan: current, memoryBlock: 'first' }));
  const retry = serializeSlackTurnInput(createSlackTurnInput({ turnJobId: 'turn_1', instanceId, runtimePlan: current, memoryBlock: 'second' }));
  writeStagedTurnInput(sql, first, 1);
  writeStagedTurnInput(sql, retry, 2);
  assert.equal(parseSlackTurnInput(readStagedTurnInputJson(sql, 'turn_1')).memoryBlock, 'first');
  assert.equal(readStagedTurnInputJson(sql, 'turn_missing'), undefined);

  for (let index = 0; index < MAX_STAGED_TURN_INPUTS + 5; index += 1) {
    writeStagedTurnInput(
      sql,
      serializeSlackTurnInput(createSlackTurnInput({ turnJobId: `turn_n${index}`, instanceId, runtimePlan: current })),
      10 + index,
    );
  }
  const count = sql.db.prepare('SELECT COUNT(*) AS n FROM chickpea_turn_inputs').get() as { n: number };
  assert.equal(count.n, MAX_STAGED_TURN_INPUTS);
  assert.equal(readStagedTurnInputJson(sql, 'turn_1'), undefined, 'the oldest input is pruned');
});

test('the render uses the staged plan, fails closed for a thread instance without one, and keeps legacy instances on their creation data', () => {
  const creation = plan();
  const instanceId = deriveRuntimePlanInstanceId(creation);
  const later = plan({ turn: { userId: 'U_BOB', actorMembershipId: 'membership_bob' }, memoryEpoch: 3 });
  const staged = parseSlackTurnInput(createSlackTurnInput({ turnJobId: 'turn_2', instanceId, runtimePlan: later, memoryBlock: 'memory' }));
  const read = (turnJobId: string) => (turnJobId === 'turn_2' ? staged : undefined);

  const resolved = resolveSlackTurnRenderInput({ instanceId, initialData: creation, turnJobId: 'turn_2', read });
  assert.equal(resolved.runtimePlan.actorMembershipId, 'membership_bob');
  assert.equal(resolved.memoryBlock, 'memory');

  assert.throws(
    () => resolveSlackTurnRenderInput({ instanceId, initialData: creation, turnJobId: 'turn_3', read }),
    /no staged input/,
  );
  assert.throws(
    () => resolveSlackTurnRenderInput({ instanceId: `agent_${'b'.repeat(40)}`, initialData: creation, turnJobId: 'turn_2', read }),
    /another instance/,
  );
  const legacyId = deriveLegacyRuntimePlanInstanceId(creation);
  assert.equal(
    resolveSlackTurnRenderInput({ instanceId: legacyId, initialData: creation, turnJobId: 'turn_3', read }).runtimePlan,
    creation,
  );
  assert.equal(
    resolveSlackTurnRenderInput({ instanceId, initialData: creation, turnJobId: undefined, read }).runtimePlan,
    creation,
  );
  let durableAsked: boolean | undefined;
  resolveSlackTurnRenderInput({
    instanceId: legacyId,
    initialData: creation,
    turnJobId: 'turn_2',
    read: (_id, durable) => { durableAsked = durable; return undefined; },
  });
  assert.equal(durableAsked, false, 'only a thread instance consults the host state DB');
});

function slackDelivery(current: RuntimePlanV2, turnJobId: string) {
  return {
    kind: 'signal' as const,
    type: 'slack.message',
    tagName: 'slack_message',
    body: serializeCurrentRequestEnvelope('What did we decide?', false, 'U_BOB', '1788000000.000300', {
      schemaVersion: 2,
      progressiveStreamingOffered: false,
    }),
    attributes: {
      workspaceId: current.conversation.workspaceId,
      channelId: current.conversation.channelId,
      threadTs: current.conversation.threadTs,
      slackUserId: 'U_BOB',
      eventId: 'E_CONT_2',
      messageTs: '1788000000.000300',
      turnJobId,
    },
  };
}

async function renderRejection(id: string, creation: RuntimePlanV2, turnJobId: string): Promise<Error> {
  const context = createFlueContext({
    id,
    agentName: 'chickpea-slack-v2',
    env: {},
    agentConfig: { resolveModel: () => undefined } as never,
  });
  try {
    await context.initializeRootHarness(ChickpeaSlack, slackDelivery(creation, turnJobId), creation);
  } catch (error) {
    return error as Error;
  }
  throw new Error('render unexpectedly succeeded');
}

test('the real ChickpeaSlack render runs the staged turn plan, not its creation data', async () => {
  const creation = plan();
  const instanceId = deriveRuntimePlanInstanceId(creation);
  const later = plan({
    turn: { userId: 'U_BOB', actorMembershipId: 'membership_bob', messageTs: '1788000000.000300' },
    assignment: { model: 'openai/gpt-5.4', agent: { ...structuredClone(AGENT), revision: 2, model: 'openai/gpt-5.4' } },
  });
  rememberInProcessTurnInput(createSlackTurnInput({ turnJobId: 'turn_render_staged', instanceId, runtimePlan: later }));

  const staged = await renderRejection(instanceId, creation, 'turn_render_staged');
  assert.match(staged.message, /openai\/gpt-5\.4" could not be resolved/, 'the model comes from the staged plan');

  const missing = await renderRejection(instanceId, creation, 'turn_render_missing');
  assert.match(missing.message, /no staged input/);
  assert.equal(CURRENT_SLACK_TURN_STATE_NAME, 'chickpeaSlackTurn');
});

test('the Cloudflare extension is branded as Flue expects and stages into the object storage', async () => {
  assert.equal(FLUE_CLOUDFLARE_EXTENSION_BRAND, Symbol.for('@flue/runtime/cloudflare-extension'));
  // The installed Flue must still recognize extensions by this registry key.
  const dist = fileURLToPath(new URL('../node_modules/@flue/runtime/dist/', import.meta.url));
  const branded = readdirSync(dist).filter((name) => name.endsWith('.mjs'))
    .some((name) => readFileSync(`${dist}${name}`, 'utf8').includes('Symbol.for("@flue/runtime/cloudflare-extension")'));
  assert.ok(branded, 'Flue changed its Cloudflare extension brand');
  assert.equal((slackThreadCloudflareExtension as Record<symbol, unknown>)[FLUE_CLOUDFLARE_EXTENSION_BRAND], true);

  const sql = sqlStorage();
  class Base { ctx = { storage: { sql } }; }
  const Extended = slackThreadCloudflareExtension.base(Base as never) as unknown as new (
    ctx: { id: { name?: string } },
    env: unknown,
  ) => {
    chickpeaStageTurnInput(json: string): void;
  };
  const current = plan();
  const instanceId = deriveRuntimePlanInstanceId(current);
  const input = createSlackTurnInput({ turnJobId: 'turn_do', instanceId, runtimePlan: current });
  new Extended({ id: { name: instanceId } }, {}).chickpeaStageTurnInput(serializeSlackTurnInput(input));
  assert.equal(parseSlackTurnInput(readStagedTurnInputJson(sql, 'turn_do')).instanceId, instanceId);

  const calls: string[] = [];
  const binding = {
    idFromName: (name: string) => `id:${name}`,
    get: (id: string) => ({
      async setName(name: string) { calls.push(`setName:${id}:${name}`); },
      async chickpeaStageTurnInput(json: string) { calls.push(`stage:${parseSlackTurnInput(json).turnJobId}`); },
    }),
  };
  await stageSlackTurnInputOnAgentObject({ FLUE_AGENT: binding }, 'FLUE_AGENT', input);
  assert.deepEqual(calls, [`setName:id:${instanceId}:${instanceId}`, 'stage:turn_do']);
  await assert.rejects(stageSlackTurnInputOnAgentObject({}, 'FLUE_AGENT', input), /unavailable/);
});

test('a continuing turn sends only rows after the watermark, edits since, and never its own replies', () => {
  const context: SlackTurnContext = {
    mode: 'thread',
    truncated: false,
    degradations: [],
    messages: [
      { ts: '1788000000.000100', userId: 'U_ALICE', text: 'Root question', isTrigger: false, role: 'human' },
      { ts: '1788000000.000150', userId: 'Agent a', text: 'Earlier answer', isTrigger: false, role: 'agent' },
      { ts: '1788000000.000180', userId: 'U_CAROL', text: 'Edited later', isTrigger: false, role: 'human', contentVersionTs: '1788000000.000250' },
      { ts: '1788000000.000220', userId: 'U_CAROL', text: 'Carol chimes in', isTrigger: false, role: 'human' },
      { ts: '1788000000.000230', userId: 'Agent a', text: 'Newer reply', isTrigger: false, role: 'agent' },
      { ts: '1788000000.000300', userId: 'U_BOB', text: 'What did we decide?', isTrigger: true, role: 'human' },
    ],
  };
  const since = slackContextSinceWatermark(context, '1788000000.000200');
  assert.deepEqual(since.messages.map(({ text }) => text), ['Edited later', 'Carol chimes in', 'What did we decide?']);
});

test('the continuity note names a new speaker, guards personal results in shared threads, and narrates memory and configuration changes', () => {
  const before = plan();
  const now = plan({
    turn: { userId: 'U_BOB', actorMembershipId: 'membership_bob' },
    memoryEpoch: 2,
    assignment: { agent: { ...structuredClone(AGENT), revision: 2 } },
  });
  const note = threadContinuityNote({
    previous: { messageTs: '1788000000.000200', slackUserId: 'U_ALICE', runtimePlan: before },
    plan: now,
    turn: { userId: 'U_BOB' },
    sharedThread: true,
  });
  assert.ok(note);
  assert.match(note, /from <@U_BOB>.*answered <@U_ALICE>/);
  assert.match(note, /personal connected accounts/);
  assert.match(note, /configuration was changed/);
  assert.match(note, /memory was updated/);

  const direct = threadContinuityNote({
    previous: { messageTs: '1788000000.000200', slackUserId: 'U_ALICE', runtimePlan: before },
    plan: before,
    turn: { userId: 'U_ALICE' },
    sharedThread: false,
  });
  assert.equal(direct, undefined, 'nothing changed, nothing is said');
  const dmSpeaker = threadContinuityNote({
    previous: { messageTs: '1788000000.000200', slackUserId: 'U_ALICE' },
    plan: before,
    turn: { userId: 'U_BOB' },
    sharedThread: false,
  });
  assert.doesNotMatch(dmSpeaker ?? '', /personal connected accounts/);
});

test('a turn frozen before thread continuity still dispatches to its plan-addressed instance, then the thread rotates once', async () => {
  const { openStateDb } = await import('../src/state/node-state-db.ts');
  const { TurnJobStoreLogic } = await import('../src/slack/turn-jobs.ts');
  const db = openStateDb(':memory:');
  try {
    const jobs = new TurnJobStoreLogic(db, () => 1_900_000_000_000);
    const legacyTurn = turn();
    const current = plan();
    const legacyId = deriveLegacyRuntimePlanInstanceId(current);
    jobs.enqueue({ id: 'turn_old', evtKey: 'evt_old', msgKey: 'msg_old', turn: legacyTurn, assignment: assignment() });
    db.run('UPDATE turn_jobs SET runtime_plan_json = ?, agent_instance_id = ? WHERE id = ?',
      JSON.stringify(current), legacyId, 'turn_old');
    const envelope = jobs.prepareFlueDispatch('turn_old', 'Old prompt', { generation: 'turn_old' });
    assert.equal(envelope.instanceId, legacyId);
    assert.ok(envelope.initialData);
    const uid = `inst_${'0'.repeat(25)}1`;
    jobs.recordFlueReceipt('turn_old', { uid, submissionId: 'submission_old', acceptedAt: new Date(0).toISOString() });
    jobs.markDelivered('turn_old');

    // The next turn derives the thread instance: no continuation into the
    // legacy transcript, and its dispatch rotates the binding.
    const nextTurn = turn({ messageTs: '1788000000.000300', eventId: 'E_NEXT' });
    jobs.enqueue({ id: 'turn_new', evtKey: 'evt_new', msgKey: 'msg_new', turn: nextTurn, assignment: assignment() });
    const decision = jobs.freezeRuntimePlan('turn_new', plan({ turn: { messageTs: '1788000000.000300' } }));
    assert.equal(decision.instanceId, deriveRuntimePlanInstanceId(current));
    assert.equal(
      jobs.getThreadContinuation(current.conversation.continuityKey, decision.instanceId, '1788000000.000300'),
      undefined,
    );
    const next = jobs.prepareFlueDispatch('turn_new', 'New prompt', { generation: 'turn_new' });
    assert.ok(next.initialData, 'the thread instance is created');
    assert.deepEqual(next.previousBinding, { instanceId: legacyId, uid });
    jobs.recordFlueReceipt('turn_new', { uid: `inst_${'0'.repeat(25)}2`, submissionId: 'submission_new', acceptedAt: new Date(0).toISOString() });
    jobs.markDelivered('turn_new');

    const continuation = jobs.getThreadContinuation(current.conversation.continuityKey, decision.instanceId, '1788000000.000400');
    assert.equal(continuation?.messageTs, '1788000000.000300');
    assert.equal(continuation?.slackUserId, 'U_ALICE');
    assert.equal(continuation?.runtimePlan?.conversation.continuityKey, current.conversation.continuityKey);
  } finally {
    db.close();
  }
});
