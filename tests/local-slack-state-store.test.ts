import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openStateDb } from '../src/state/node-state-db.ts';
import {
  ACTIVE_WORK_TTL_MS,
  CODING_ACTIVE_WORK_TTL_MS,
  SlackStateLogic,
  SqliteSlackStateStore,
  selectSlackPresentationOwner,
  slackSessionGenerationFromTimestamp,
} from '../src/slack/claim-store.ts';
import { localSlackStateStore } from '../src/slack/local-state-store.ts';
import { prepareSlackShadowAdmission } from '../src/slack/work-admission.ts';
import { SqliteWorkStore } from '../src/work/store.ts';

test('local Slack admission injects every transactional state owner', async () => {
  const work = { owner: 'work' };
  const turnJobs = { owner: 'turn-jobs' };
  const presentations = { owner: 'presentations' };
  const admission = { evtKey: 'evt' };
  let received: unknown[] | undefined;
  const slack = {
    admitCanonical(...args: unknown[]) {
      received = args;
      return { claimed: false as const };
    },
  };

  const store = localSlackStateStore({
    slack: slack as never,
    work: work as never,
    turnJobs: turnJobs as never,
    presentations: presentations as never,
  });

  assert.deepEqual(await store.admitCanonical(admission as never), { claimed: false });
  assert.deepEqual(received, [admission, work, turnJobs, presentations]);
});

test('canonical Slack admission creates V3 owner and activity state in the same transaction', () => {
  const db = openStateDb(':memory:');
  try {
    const slack = new SlackStateLogic(db, () => 1_800_000_000_000);
    const canonical = {
      binding: { id: 'binding_v3_admission', generation: 1 },
      run: { id: 'run_v3_admission', fencingToken: 0, executionAuthority: 'legacy' },
    };
    let presentationInput: unknown;
    const input = {
      evtKey: 'evt:v3-admission',
      msgKey: 'msg:v3-admission',
      threadKey: 'T_V3:D_V3:1785700000.000100',
      admission: { scope: 'captured by fake work store' },
      turnJob: {
        id: 'turn_v3_admission',
        runId: canonical.run.id,
        executionAuthority: canonical.run.executionAuthority,
      },
      presentation: {
        schemaVersion: 3 as const,
        root: {
          workspaceId: 'T_V3',
          channelId: 'D_V3',
          threadTs: '1785700000.000100',
          requesterUserId: 'U_V3',
        },
        owner: {
          kind: 'selected_agent' as const,
          persona: {
            name: 'Frozen Agent',
            avatarUrl: 'https://chickpea.example/assets/agents/frozen/avatar/4',
            avatarRevision: 4,
          },
        },
        sessionGeneration: 1785700000000100,
        currentActivity: {
          kind: 'preparing' as const,
          action: 'Preparing',
          object: 'your request',
          generation: 1785700000000100,
          sequence: 1,
          operation: { operationId: 'activity_run_v3_admission_1', certainty: 'pending' as const },
        },
        taskLabels: ['Prepare the answer'],
      },
    };

    const result = slack.admitCanonical(
      input as never,
      { admitShadowRunInTransaction: () => canonical } as never,
      { enqueueInTransaction: () => true } as never,
      {
        createInTransaction(value: unknown) {
          presentationInput = structuredClone(value);
        },
      } as never,
    );

    assert.equal(result.claimed, true);
    assert.deepEqual(presentationInput, {
      runId: canonical.run.id,
      turnJobId: input.turnJob.id,
      bindingId: canonical.binding.id,
      workBindingGeneration: canonical.binding.generation,
      runFencingToken: canonical.run.fencingToken,
      ...input.presentation,
    });
  } finally {
    db.close();
  }
});

test('SQLite canonical Slack admission composes TurnJob cleanup inside its transaction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-slack-admission-'));
  const path = join(directory, 'state.sqlite');
  const now = 1_800_000_000_000;
  const state = new SqliteSlackStateStore(path, () => now);
  let work: SqliteWorkStore | undefined;
  try {
    const turn = {
      workspaceId: 'T_NODE_ADMISSION',
      channelId: 'D_NODE_ADMISSION',
      eventId: 'Ev_NODE_ADMISSION',
      text: 'Complete the local verification.',
      userId: 'U_NODE_ADMISSION',
      messageTs: '1800000000.000100',
      threadTs: '1800000000.000100',
      source: 'dm_message' as const,
      channelType: 'im' as const,
      contextMode: 'dm_history' as const,
    };
    const assignment = {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      agentId: 'agent_node_admission',
      model: 'openai/gpt-5.6-terra',
      modelAttribution: { source: 'pinned' as const, providerId: 'openai' },
      agent: {
        id: 'agent_node_admission',
        kind: 'user' as const,
        revision: 1,
        name: 'Node Admission',
        instructions: 'Answer directly.',
        enabled: true,
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      },
    };
    const admission = prepareSlackShadowAdmission({
      turn,
      assignment,
      sourceVisibility: 'private',
      admittedAt: now,
    });
    const input = {
      evtKey: 'evt:node-admission',
      msgKey: 'msg:node-admission',
      threadKey: `${turn.workspaceId}:${turn.channelId}:${turn.threadTs}`,
      admission,
      turnJob: {
        id: 'turn_node_admission',
        evtKey: 'evt:node-admission',
        msgKey: 'msg:node-admission',
        turn,
        assignment,
        runId: admission.run.id,
        executionAuthority: admission.run.executionAuthority,
      },
      presentation: {
        schemaVersion: 3 as const,
        root: {
          workspaceId: turn.workspaceId,
          channelId: turn.channelId,
          threadTs: turn.threadTs,
          requesterUserId: turn.userId,
        },
        owner: { kind: 'chickpea' as const },
        sessionGeneration: 1800000000000100,
      },
    };

    const result = await state.admitCanonical(input);

    assert.equal(result.claimed, true);
    assert.equal((await state.listPendingTurns!())[0]?.id, input.turnJob.id);
    assert.equal((await state.getRunPresentation!(admission.run.id))?.runId, admission.run.id);
    work = new SqliteWorkStore(path);
    assert.equal((await work.getRun(admission.run.id))?.id, admission.run.id);
  } finally {
    work?.close();
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Slack admission derives a safe monotonic generation from the admitted message timestamp', () => {
  assert.equal(
    slackSessionGenerationFromTimestamp('1785700000.000100'),
    1785700000000100,
  );
  assert.ok(
    slackSessionGenerationFromTimestamp('1785700000.000101') >
      slackSessionGenerationFromTimestamp('1785700000.000100'),
  );
  assert.throws(() => slackSessionGenerationFromTimestamp('1785700000.1'));
  assert.throws(() => slackSessionGenerationFromTimestamp('99999999999.999999'));
});

test('Slack admission freezes selected ownership only from a healthy complete persona', () => {
  const complete = {
    installationHealth: 'healthy' as const,
    agentId: 'agent_support',
    agentName: 'Support',
    avatarUrl: 'https://chickpea.example/assets/agents/support/avatar/2',
    slackPresence: {
      desiredState: 'active' as const,
      health: 'healthy' as const,
      avatar: { revision: 2 },
    },
  };
  assert.deepEqual(selectSlackPresentationOwner(complete), {
    kind: 'selected_agent',
    persona: {
      name: 'Support',
      avatarUrl: complete.avatarUrl,
      avatarRevision: 2,
    },
  });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    installationHealth: 'needs_attention',
  }), { kind: 'chickpea' });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    slackPresence: { ...complete.slackPresence, health: 'pending' },
  }), { kind: 'chickpea' });
  const { avatarUrl: _avatarUrl, ...withoutAvatar } = complete;
  assert.deepEqual(selectSlackPresentationOwner(withoutAvatar), { kind: 'chickpea' });
  assert.deepEqual(selectSlackPresentationOwner({
    ...complete,
    agentId: 'agent_chickpea',
  }), { kind: 'chickpea' });
});

test('creator-private DM admission freezes the unpublished Agent name and current avatar', () => {
  const privateAgent = {
    installationHealth: 'healthy' as const,
    agentId: 'agent_private', agentName: 'Private Helper',
    conversationKind: 'im' as const,
    avatarUrl: 'https://chickpea.example/assets/agents/agent_private/avatar/2',
    slackPresence: { desiredState: 'unpublished' as const, health: 'unpublished' as const, avatar: { revision: 2 } },
  };
  assert.deepEqual(selectSlackPresentationOwner(privateAgent), {
    kind: 'selected_agent', persona: {
      name: privateAgent.agentName, avatarUrl: privateAgent.avatarUrl, avatarRevision: 2,
    },
  });
  for (const conversationKind of ['channel', 'mpim'] as const) {
    assert.deepEqual(selectSlackPresentationOwner({ ...privateAgent, conversationKind }), { kind: 'chickpea' });
  }
  assert.deepEqual(selectSlackPresentationOwner({ ...privateAgent, installationHealth: 'revoked' }), { kind: 'chickpea' });
  const { avatarUrl: _avatarUrl, ...withoutAvatar } = privateAgent;
  assert.deepEqual(selectSlackPresentationOwner(withoutAvatar), { kind: 'chickpea' });
  assert.deepEqual(selectSlackPresentationOwner({ ...privateAgent,
    slackPresence: { ...privateAgent.slackPresence, desiredState: 'disabled' },
  }), { kind: 'chickpea' });
});

test('local Slack adapter exposes Promise-shaped turn-job delegation', async () => {
  const expected = { continuityKey: 'thread', agentId: 'sprout' };
  const turnJobs = {
    pinAgentBinding(binding: unknown, expectation: unknown) {
      assert.equal(binding, expected);
      assert.deepEqual(expectation, { instanceId: 'instance-1', uid: 'uid-1' });
      return expected;
    },
  };
  const store = localSlackStateStore({
    slack: {} as never,
    work: {} as never,
    turnJobs: turnJobs as never,
    presentations: {} as never,
  });

  const pending = store.pinAgentBinding(expected as never, {
    instanceId: 'instance-1',
    uid: 'uid-1',
  });
  assert.equal(typeof pending.then, 'function');
  assert.equal(await pending, expected);
});

test('the long active-work hint applies only to a turn that delegated a coding task', () => {
  const db = openStateDb(':memory:');
  try {
    let now = 1_800_000_000_000;
    const slack = new SlackStateLogic(db, () => now);
    slack.setActiveWork('thread:ordinary', 'job-ordinary', true);
    slack.setActiveWork('thread:coding', 'job-coding', true);
    now += 5 * 60_000;
    slack.markCodingActiveWork('thread:coding', 'job-coding');
    // Marking a marker that was never set (or already cleared) revives nothing.
    slack.markCodingActiveWork('thread:idle', 'job-idle');

    now += ACTIVE_WORK_TTL_MS;
    assert.equal(slack.isActiveWork('thread:ordinary'), false, 'an ordinary turn keeps the short hint');
    assert.equal(slack.isActiveWork('thread:coding'), true);
    assert.equal(slack.isActiveWork('thread:idle'), false);

    now += CODING_ACTIVE_WORK_TTL_MS - ACTIVE_WORK_TTL_MS - 1;
    assert.equal(slack.isActiveWork('thread:coding'), true, 'held for the coding budget from the task start');
    now += 2;
    assert.equal(slack.isActiveWork('thread:coding'), false, 'and still self-heals after it');

    // The turn's own clear still ends the hint at once.
    slack.setActiveWork('thread:done', 'job-done', true);
    slack.markCodingActiveWork('thread:done', 'job-done');
    slack.setActiveWork('thread:done', 'job-done', false);
    slack.markCodingActiveWork('thread:done', 'job-done');
    assert.equal(slack.isActiveWork('thread:done'), false);
    assert.equal(slack.isCodingActiveWork('thread:done', 'job-done'), false);
    assert.equal(slack.isCodingActiveWork('thread:coding', 'job-coding'), false, 'an expired coding marker no longer counts');
    slack.setActiveWork('thread:plain', 'job-plain', true);
    assert.equal(slack.isCodingActiveWork('thread:plain', 'job-plain'), false, 'a plain work marker is not coding');

    // An expired coding marker is purged with the rest; a live one is kept.
    slack.setActiveWork('thread:live', 'job-live', true);
    slack.markCodingActiveWork('thread:live', 'job-live');
    assert.equal(slack.isCodingActiveWork('thread:live', 'job-live'), true);
    assert.equal(slack.isCodingActiveWork('thread:live', 'job-other'), false, 'only this turn\'s marker counts');
    now += ACTIVE_WORK_TTL_MS + 1;
    slack.claim('evt:purge');
    const rows = db.all('SELECT key FROM slack_active_work ORDER BY key').map((row) => row.key);
    assert.deepEqual(rows, ['thread:live']);
  } finally {
    db.close();
  }
});

test('an active-work table from before the coding hint gains its column in place', () => {
  const db = openStateDb(':memory:');
  try {
    db.exec('CREATE TABLE slack_active_work (key TEXT NOT NULL, generation TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, generation))');
    const now = 1_800_000_000_000;
    db.run('INSERT INTO slack_active_work (key, generation, updated_at) VALUES (?, ?, ?)', 'thread:old', 'job-old', now);
    const slack = new SlackStateLogic(db, () => now);
    assert.equal(slack.isActiveWork('thread:old'), true);
    slack.markCodingActiveWork('thread:old', 'job-old');
    assert.equal(db.get('SELECT ttl_ms FROM slack_active_work')?.ttl_ms, CODING_ACTIVE_WORK_TTL_MS);
  } finally {
    db.close();
  }
});

test('a frozen Channel thread keeps its pinned config revision when a follow-up resolves changed config', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-frozen-binding-'));
  const work = new SqliteWorkStore(join(directory, 'state.sqlite'));
  try {
    const opening = {
      workspaceId: 'T_FROZEN',
      channelId: 'C_FROZEN',
      eventId: 'Ev_FROZEN_OPEN',
      text: 'Start the investigation.',
      userId: 'U_FROZEN',
      messageTs: '1800000000.000100',
      threadTs: '1800000000.000100',
      source: 'app_mention' as const,
      channelType: 'channel' as const,
      contextMode: 'thread' as const,
    };
    const followUp = {
      ...opening,
      eventId: 'Ev_FROZEN_FOLLOW',
      text: 'And the second part?',
      messageTs: '1800000000.000200',
      source: 'implicit_thread_reply' as const,
    };
    const agent = {
      id: 'agent_frozen',
      kind: 'user' as const,
      revision: 1,
      name: 'Frozen',
      instructions: 'Answer directly.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    };
    const assignmentA = {
      workspaceId: opening.workspaceId,
      channelId: opening.channelId,
      agentId: agent.id,
      model: 'openai/gpt-5.6-terra',
      modelAttribution: { source: 'pinned' as const, providerId: 'openai' },
      agent,
    };
    // The Agent is edited (or the thread changes owner) between the thread's
    // first turn and a follow-up, so the follow-up resolves a different thread
    // snapshot and therefore a different safe-config digest.
    const assignmentB = {
      ...assignmentA,
      agent: { ...agent, revision: 2, instructions: 'Answer in one line.' },
    };
    const open = prepareSlackShadowAdmission({
      turn: opening,
      assignment: assignmentA,
      sourceVisibility: 'public',
      admittedAt: 1_800_000_000_000,
    });
    const next = prepareSlackShadowAdmission({
      turn: followUp,
      assignment: assignmentB,
      sourceVisibility: 'public',
      admittedAt: 1_800_000_060_000,
    });
    assert.equal(next.binding.id, open.binding.id);
    assert.equal(next.binding.configMode, 'frozen_on_open');
    assert.notDeepEqual(next.safeConfig, open.safeConfig);

    const first = await work.admitShadowRun(open);
    const second = await work.admitShadowRun(next);

    assert.equal(second.replayed, false);
    assert.equal(second.binding.id, first.binding.id);
    assert.equal(second.binding.pinnedConfigRevisionId, first.binding.pinnedConfigRevisionId);
    assert.equal(second.run.configRevisionId, first.run.configRevisionId);
    assert.equal(second.run.admissionSequence, 2);
    assert.equal(
      (await work.getBinding(open.binding.id))?.pinnedConfigRevisionId,
      first.binding.pinnedConfigRevisionId,
    );
    // A Slack retry of the follow-up replays the same Run.
    assert.equal((await work.admitShadowRun(next)).replayed, true);

    // Frozen-on-open relaxes only the config pin; every thread-derived
    // identity field still has to match the open Binding.
    const identityFields = [
      ['externalAccountId', 'account_other'],
      ['externalConversationId', 'conversation_other'],
      ['orderingKey', 'ordering_other'],
      ['configMode', 'resolve_each_run'],
    ] as const;
    for (const [index, [field, value]] of identityFields.entries()) {
      const conflicting = prepareSlackShadowAdmission({
        turn: {
          ...followUp,
          eventId: `Ev_FROZEN_${index}`,
          messageTs: `1800000000.00030${index}`,
        },
        assignment: assignmentB,
        sourceVisibility: 'public',
        admittedAt: 1_800_000_120_000,
      });
      conflicting.binding = { ...conflicting.binding, [field]: value };
      await assert.rejects(
        work.admitShadowRun(conflicting),
        (error: Error & { code?: string }) => error.code === 'work_binding_conflict',
        field,
      );
    }
  } finally {
    work.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
