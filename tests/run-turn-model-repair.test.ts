import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { activityStatus } from '../src/activity/status.ts';
import { RuntimeModelReadinessError } from '../src/config/runtime-model.ts';
import { PROVIDER_KEY_ENV_VARS, PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';
import { invalidateProviderModelCache } from '../src/config/provider-models.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import type { SlackPresentationStatePort } from '../src/slack/agent-view-presentation.ts';
import { presentAdmittedSlackActivity } from '../src/slack/admission-activity.ts';
import type { AgentDispatchResult } from '../src/slack/flue-dispatch.ts';
import { SlackRunPresentationStoreLogic, type SlackPresentationOwner } from '../src/slack/run-presentations.ts';
import { runTurn, WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';
import { withEnv } from './helpers/env.ts';

/**
 * A turn whose model cannot run until Model providers is repaired (its key was
 * removed, or the model is no longer offered) ends at once with the existing
 * Workspace-default repair reply, under the run's own sender, instead of
 * failing every attempt and posting the generic failure.
 */

const directory = mkdtempSync(join(tmpdir(), 'chickpea-model-repair-'));
const statePath = join(directory, 'state.sqlite');
let previousStatePath: string | undefined;

const agent: ResolvedAssignment['agent'] = {
  id: 'agent_model_repair',
  kind: 'user',
  revision: 1,
  name: 'Repair Analyst',
  instructions: 'Answer directly.',
  enabled: true,
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

function inheriting(model: string): ResolvedAssignment {
  return {
    workspaceId: 'T_MODEL_REPAIR',
    channelId: 'D_MODEL_REPAIR',
    agentId: agent.id,
    runtimeContract: 'chickpea-v1',
    model,
    modelAttribution: { source: 'workspace_default', workspaceDefaultRevision: 2, providerId: model.split('/')[0]! },
    agent,
  };
}

const PERSONA = {
  name: 'Repair Analyst',
  avatarUrl: 'https://chickpea.example/assets/agents/repair/avatar/1',
  avatarRevision: 1,
};

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = statePath;
  const store = new SqliteConfigStore(statePath, { agents: [] });
  await store.createAgent(agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: 'T_MODEL_REPAIR',
    transportMode: 'direct',
    defaultAgentId: agent.id,
    teamId: 'T_MODEL_REPAIR',
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation('T_MODEL_REPAIR', { health: 'healthy' }, installation.revision);
  store.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(directory, { recursive: true, force: true });
});

let turns = 0;

async function message(
  assignment: ResolvedAssignment,
  options: {
    owner?: SlackPresentationOwner;
    openRouterKey?: string;
    env?: Record<string, string | undefined>;
    /** Admission already showed the thread a "Thinking" status, as the relay does. */
    admitted?: boolean;
  } = {},
) {
  turns += 1;
  const messageTs = `1788100000.${String(turns).padStart(6, '0')}`;
  const turn: NormalizedSlackTurn = {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'im',
    eventId: `Ev_MODEL_REPAIR_${turns}`,
    messageTs,
    threadTs: messageTs,
    userId: 'U_MODEL_REPAIR',
    text: 'reply with the word amber',
    source: 'dm_message',
    contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  const runId = `run_model_repair_${turns}`;
  const db = openStateDb(':memory:');
  const presentations = new SlackRunPresentationStoreLogic(db);
  const sessionGeneration = Number(messageTs.replace('.', ''));
  const thinking = activityStatus('preparing', 'Thinking', '');
  presentations.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: `binding_${runId}`,
    workBindingGeneration: 1,
    runFencingToken: 0,
    owner: options.owner ?? { kind: 'chickpea' },
    sessionGeneration,
    root: {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      requesterUserId: turn.userId,
    },
    ...(options.admitted
      ? {
          currentActivity: {
            kind: thinking.kind,
            action: thinking.action,
            object: thinking.object,
            generation: sessionGeneration,
            sequence: 1,
            operation: { operationId: `activity_${runId}_1`, certainty: 'pending' as const },
          },
        }
      : {}),
  });
  const presentationState = {
    getRunPresentation: (id: string) => presentations.get(id),
    getLatestThreadSessionGeneration: (root: Parameters<SlackRunPresentationStoreLogic['getLatestThreadSessionGeneration']>[0]) =>
      presentations.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input: Parameters<SlackRunPresentationStoreLogic['transition']>[0]) =>
      presentations.transition(input),
    reserveSlackAppend: (workspaceId: string) => presentations.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId: string, retryAfterMs: number) =>
      presentations.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: () => undefined,
  } as unknown as SlackPresentationStatePort;
  const posts: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const ok = async () => ({ ok: true, ts: '1788100099.000100', channel: turn.channelId, messages: [] });
  const client = {
    apiCall: ok,
    assistant: {
      threads: {
        setStatus: async (input: { status: string }) => {
          statuses.push(input.status);
          return ok();
        },
      },
    },
    reactions: { add: ok, remove: ok },
    conversations: { replies: ok, history: ok },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: '1788100099.000200', channel: turn.channelId };
      },
      startStream: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: '1788100099.000300', channel: turn.channelId };
      },
      appendStream: ok,
      stopStream: ok,
      update: ok,
      delete: ok,
    },
  } as unknown as WebClient;
  const settings = new SqliteSettingsStore(':memory:');
  if (options.openRouterKey) {
    await settings.setSetting(PROVIDER_KEY_SETTING_KEYS.openrouter, options.openRouterKey);
  }
  const outcomes: Array<string | undefined> = [];
  let dispatched = 0;
  let presentation: ReturnType<SlackRunPresentationStoreLogic['get']>;
  try {
    if (options.admitted) {
      assert.equal(await presentAdmittedSlackActivity({
        client,
        state: presentationState,
        runId,
        runFencingToken: 0,
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        requesterUserId: turn.userId,
        owner: options.owner ?? { kind: 'chickpea' },
        agentId: agent.id,
        activity: thinking,
      }), true, 'the admitted status shows');
    }
    await withEnv({ OPENAI_API_KEY: undefined, OPENROUTER_API_KEY: undefined, ...options.env }, () => runTurn(turn, assignment, undefined, {
      client,
      runId,
      turnId: `turn_${runId}`,
      runAttempt: 1,
      presentationState,
      publicUrl: 'https://chickpea.example',
      settingsStore: settings,
      usageRecordingEnabled: false,
      onDelivered: (outcome) => { outcomes.push(outcome); },
      async agentPrompt(): Promise<AgentDispatchResult> {
        dispatched += 1;
        throw new Error('a model that needs repair must not dispatch');
      },
    }));
  } finally {
    presentation = presentations.get(runId);
    settings.close();
    db.close();
  }
  return { posts, outcomes, dispatched, statuses, presentation };
}

/** The text of a post, or of a stream's first chunks. */
function replyText(post: Record<string, unknown>): string {
  const chunks = Array.isArray(post.chunks) ? post.chunks as Array<{ text?: unknown }> : [];
  return [post.text, post.markdown_text, ...chunks.map((chunk) => chunk.text)]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

test('a Workspace default whose provider key was removed gets the repair reply once, as the installation\'s bot', async () => {
  const { posts, outcomes, dispatched } = await message(inheriting('openai/gpt-5.6-luna'));
  assert.equal(dispatched, 0, 'nothing dispatched');
  const replies = posts.filter((post) => replyText(post).includes(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT));
  assert.equal(replies.length, 1, 'one repair reply');
  assert.equal(replies[0]!.username, undefined, 'Chickpea\'s replies carry no custom sender');
  assert.equal(replies[0]!.icon_url, undefined);
  assert.doesNotMatch(posts.map(replyText).join('\n'), /failed before completion|needs setup/);
  assert.deepEqual(outcomes, ['failed'], 'the turn is settled, not retried');
});

test('a selected Agent\'s repair reply comes from that Agent', async () => {
  const { posts, outcomes } = await message(inheriting('openai/gpt-5.6-luna'), {
    owner: { kind: 'selected_agent', persona: PERSONA },
  });
  const reply = posts.find((post) => replyText(post).includes(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT));
  assert.ok(reply, 'the repair reply');
  assert.equal(reply.username, PERSONA.name);
  assert.equal(reply.icon_url, PERSONA.avatarUrl);
  assert.deepEqual(outcomes, ['failed']);
});

test('a Workspace default the provider no longer serves gets the same repair reply', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [] });
  invalidateProviderModelCache('openrouter');
  t.after(() => {
    globalThis.fetch = previousFetch;
    invalidateProviderModelCache('openrouter');
  });
  const { posts, dispatched } = await message(inheriting('openrouter/acme/retired-model'), {
    openRouterKey: 'openrouter-test-key',
  });
  assert.equal(dispatched, 0);
  assert.equal(posts.filter((post) => replyText(post).includes(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT)).length, 1);
});

test('a provider that could not be checked just now fails the attempt, to be retried', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 502 });
  invalidateProviderModelCache('openrouter');
  t.after(() => {
    globalThis.fetch = previousFetch;
    invalidateProviderModelCache('openrouter');
  });
  await assert.rejects(
    message(inheriting('openrouter/acme/cold-model'), { openRouterKey: 'openrouter-test-key' }),
    (error: unknown) => error instanceof RuntimeModelReadinessError && error.transient,
  );
});

test('a pinned model whose key was removed is not called a Workspace default problem', async () => {
  const pinned: ResolvedAssignment = {
    ...inheriting('openai/gpt-5.6-luna'),
    modelAttribution: { source: 'pinned', providerId: 'openai' },
  };
  await assert.rejects(
    message(pinned),
    (error: unknown) => error instanceof RuntimeModelReadinessError && error.status === 'provider_setup_required',
  );
});

test('a hosted installation whose Workspace default is still a Workers AI model gets the repair reply', async () => {
  // Hosted run 1: an installation seeded with Workers AI on a deployment
  // serving many installations, which offers only customer-keyed providers.
  const hostedEnv = {
    ...Object.fromEntries(Object.values(PROVIDER_KEY_ENV_VARS).map((name) => [name, undefined])),
    CHICKPEA_TENANCY: 'installation',
  };
  const workersAi = inheriting('cloudflare/@cf/zai-org/glm-4.7-flash');
  // The cause: the deployment does not offer the provider.
  await assert.rejects(
    message({ ...workersAi, modelAttribution: { source: 'pinned', providerId: 'cloudflare' } }, { env: hostedEnv }),
    (error: unknown) => error instanceof RuntimeModelReadinessError &&
      error.status === 'unsupported' && error.providerId === 'cloudflare',
  );
  const { posts, outcomes, dispatched, statuses, presentation } = await message(
    workersAi,
    { env: hostedEnv, admitted: true },
  );
  assert.equal(dispatched, 0, 'nothing dispatched');
  assert.equal(posts.filter((post) => replyText(post).includes(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT)).length, 1);
  assert.doesNotMatch(posts.map(replyText).join('\n'), /failed before completion|not offered/);
  assert.deepEqual(outcomes, ['failed']);
  assert.ok(statuses.length >= 2, 'the admitted status was shown');
  assert.equal(statuses.at(-1), '', 'the thread status is cleared');
  assert.ok(presentation?.schemaVersion === 3, 'the run presentation');
  assert.ok(
    presentation.lifecyclePhase === 'terminal_intended' || presentation.lifecyclePhase === 'settled',
    `the presentation is terminal (${presentation.lifecyclePhase})`,
  );
  assert.equal(presentation.terminalDelivery.state, 'intended');
  assert.equal(presentation.activityProjection.state, 'cleared', 'no status is left showing');
  assert.ok(
    presentation.cleanup.state === 'not_required' || presentation.cleanup.operation.certainty === 'acknowledged',
    'the status cleanup is acknowledged',
  );
});
