import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { SqliteConfigStore } from '../src/config/store.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { ResolvedAssignment } from '../src/config/types.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const assignment: ResolvedAssignment = {
  workspaceId: 'T_FOOTER_EFFORT',
  channelId: 'D_FOOTER_EFFORT',
  agentId: 'agent_footer_effort',
  model: 'anthropic/claude-opus-5-5',
  effort: 'max',
  modelAttribution: { source: 'pinned', providerId: 'anthropic' },
  agent: {
    id: 'agent_footer_effort',
    kind: 'user',
    revision: 1,
    name: 'Footer Effort',
    instructions: 'Answer directly.',
    enabled: true,
    model: 'anthropic/claude-opus-5-5',
    modelEffort: 'max',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  },
};

const stateDirectory = mkdtempSync(join(tmpdir(), 'chickpea-footer-effort-'));
let previousStatePath: string | undefined;

before(async () => {
  previousStatePath = process.env.SLACK_STATE_DB_PATH;
  process.env.SLACK_STATE_DB_PATH = join(stateDirectory, 'state.sqlite');
  const store = new SqliteConfigStore(process.env.SLACK_STATE_DB_PATH, agentRoutineDeletion, { agents: [] });
  await store.createAgent(assignment.agent);
  const installation = await store.ensureWorkspaceInstallation({
    workspaceId: assignment.workspaceId,
    transportMode: 'direct',
    defaultAgentId: assignment.agentId,
    teamId: assignment.workspaceId,
    botUserId: 'U_CHICKPEA',
  });
  await store.updateWorkspaceInstallation(assignment.workspaceId, { health: 'healthy' }, installation.revision);
  store.close();
});

after(() => {
  if (previousStatePath === undefined) delete process.env.SLACK_STATE_DB_PATH;
  else process.env.SLACK_STATE_DB_PATH = previousStatePath;
  rmSync(stateDirectory, { recursive: true, force: true });
});

test('a reply run at a chosen effort names the model in its footer, never the effort', async () => {
  const sent: unknown[] = [];
  const ok = async (input: unknown) => {
    sent.push(input);
    return { ok: true, ts: '1790000200.000100', channel: assignment.channelId, messages: [] };
  };
  const client = {
    apiCall: ok,
    assistant: { threads: { setStatus: ok } },
    reactions: { add: ok, remove: ok },
    conversations: { replies: ok, history: ok },
    chat: { postMessage: ok, startStream: ok, appendStream: ok, stopStream: ok, update: ok, delete: ok },
  } as unknown as WebClient;
  const turn: NormalizedSlackTurn = {
    workspaceId: assignment.workspaceId,
    channelId: assignment.channelId,
    channelType: 'im',
    eventId: 'Ev_FOOTER_EFFORT',
    text: 'Summarize the release notes.',
    userId: 'U_FOOTER_EFFORT',
    messageTs: '1790000200.000001',
    threadTs: '1790000200.000001',
    source: 'dm_message',
    contextMode: 'dm_history',
    interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
  };
  await runTurn(turn, assignment, undefined, {
    client,
    replayText: 'Release notes summarized.',
    publicUrl: 'https://chickpea.example',
    usageRecordingEnabled: false,
  });
  const footers = JSON.stringify(sent).match(/Footer Effort \| [^"|]+ \|/g) ?? [];
  assert.ok(footers.length > 0, 'the reply carries a footer');
  for (const footer of footers) assert.equal(footer, 'Footer Effort | anthropic/claude-opus-5-5 |');
  assert.doesNotMatch(JSON.stringify(sent), /\bmax\b/i);
});
