import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createFlueContext } from '@flue/runtime/internal';
import {
  ChickpeaSlack,
  runtimePlanConnectedServicesInstruction,
  runtimePlanSkills,
} from '../src/agents/slack-thread.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { compileRuntimePlanV2, parseRuntimePlanV2, type RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { parseRoutineExecutionInitialData } from '../src/agents/routine-execution-data.ts';
import legacyFixture from './fixtures/runtime-plan/v0.1.26-attached-container.json' with { type: 'json' };
import { getConfigStore, getSettingsStore } from '../src/config/state-backend.ts';
import { GITHUB_SETTING_KEYS } from '../src/config/github-app.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

const APP_PRIVATE_KEY = String(
  generateKeyPairSync('rsa', { modulusLength: 2_048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }),
);

const GRANT = {
  id: 'repo_rails',
  installationId: 50_001,
  accountLogin: 'acme',
  fullName: 'acme/acme-rails',
  enabled: true,
};

function supportAgent(skills: Array<{ name: string; description: string; instructions: string; enabled: boolean }> = []) {
  return {
    id: 'agent_support', kind: 'user', revision: 1, name: 'Support', instructions: 'Triage tickets.',
    enabled: true, model: 'local-stub/proof', mcpServers: [], apiConnections: [],
    skills: [
      { name: 'ticket-triage', description: 'Triage a ticket.', instructions: 'Label it.', enabled: true },
      ...skills,
    ],
    repositories: [{ ...GRANT }],
  };
}

function compilePlanInput(agent: ReturnType<typeof supportAgent>, eventSuffix = 'current') {
  return {
    turn: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: `E_REPO_${eventSuffix}`,
      text: 'Look at the repo', userId: 'U_TEST', messageTs: '1787000000.000200',
      threadTs: '1787000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model,
      modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 },
    },
    instructions: agent.instructions,
    memoryEpoch: 1,
    effectiveConnections: [],
  };
}

function compilePlan(agent: ReturnType<typeof supportAgent>) {
  return compileRuntimePlanV2({
    turn: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', eventId: 'E_REPO_bash',
      text: 'Look at the repo', userId: 'U_TEST', messageTs: '1787000000.000200',
      threadTs: '1787000000.000100', source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: agent.id, agent, model: agent.model,
      modelAttribution: { source: 'workspace_default', providerId: 'local-stub', workspaceDefaultRevision: 1 },
    },
    instructions: agent.instructions,
    memoryEpoch: 1,
    effectiveConnections: [],
  } as any);
}

function slackSignal(plan: RuntimePlanV2) {
  return {
    kind: 'signal', type: 'slack.message', tagName: 'slack_message',
    body: serializeCurrentRequestEnvelope(
      'Look at the repo', false, 'U_TEST', '1787000000.000200',
      { schemaVersion: 2, progressiveStreamingOffered: true },
    ),
    attributes: {
      workspaceId: plan.conversation.workspaceId, channelId: plan.conversation.channelId,
      threadTs: plan.conversation.threadTs,
      slackUserId: 'U_TEST', eventId: plan.conversation.threadTs, messageTs: '1787000000.000200',
      turnJobId: `repo_${randomUUID()}`,
    },
  } as any;
}

function skillNames(harness: unknown): string[] {
  return Object.keys((harness as any).config.skills ?? {}).sort();
}

test('a v0.1.26 plan admitted with an attached container renders as the virtual-sandbox coordinator', async (t) => {
  // Skip-upgrade: the Flue instance was created from the stored v0.1.26
  // plan, so the render reads exactly that creation data.
  const admitted = legacyFixture.slackTurnPlan;
  assert.equal(admitted.sandbox.mode, 'cloudflare');
  t.mock.method(getConfigStore(), 'getAgent', async () => legacyFixture.agent);
  const context = createFlueContext({
    id: 'repo-legacy-test', agentName: 'chickpea-slack-v2', env: {},
    agentConfig: { resolveModel: () => ({}) } as any,
  });
  const plan = parseRuntimePlanV2(admitted);
  const harness = await context.initializeRootHarness(ChickpeaSlack, slackSignal(plan), admitted as any);
  try {
    const skills = (harness as any).config.skills;
    assert.deepEqual(skillNames(harness), ['agent-authoring', 'repositories', 'workspace']);
    assert.match(skills.workspace.instructions, /workspace_exec/);
    assert.doesNotMatch(skills.workspace.instructions, /Use the write tool to create/);
    const instructions = String((harness as any).config.instructions);
    assert.match(instructions, /Your own shell cannot clone them; for a real checkout, use the coding workspace tools/);
    assert.doesNotMatch(instructions, /clone a granted repository with a plain HTTPS URL/);
  } finally {
    await harness.close();
  }
});

test('a current plan keeps the Agent in its virtual sandbox and teaches the workspace through tools', async (t) => {
  const agent = supportAgent();
  t.mock.method(getConfigStore(), 'getAgent', async () => agent);
  const plan = compileRuntimePlanV2({
    ...(compilePlanInput(agent)),
    codingWorkspace: true,
  } as any);
  assert.equal(plan.sandbox.mode, 'bash');
  assert.deepEqual(plan.codingWorkspace, { available: true });

  const context = createFlueContext({
    id: 'repo-coordinator-test', agentName: 'chickpea-slack-v2', env: {},
    agentConfig: { resolveModel: () => ({}) } as any,
  });
  const harness = await context.initializeRootHarness(ChickpeaSlack, slackSignal(plan), plan);
  try {
    const skills = (harness as any).config.skills;
    assert.deepEqual(skillNames(harness), ['agent-authoring', 'repositories', 'ticket-triage', 'workspace']);
    assert.match(skills.workspace.instructions, /workspace_exec/);
    assert.match(skills.workspace.instructions, /never in the workspace, and cannot clone a repository/);
    assert.match(skills.workspace.instructions, /`workspace_close` with `discard: true`/);
    assert.doesNotMatch(skills.workspace.instructions, /Use the write tool to create/);
    const instructions = String((harness as any).config.instructions);
    assert.match(instructions, /Your own shell cannot clone them; for a real checkout, use the coding workspace tools/);
    assert.doesNotMatch(instructions, /clone a granted repository with a plain HTTPS URL/);
  } finally {
    await harness.close();
  }
});

test('a v0.1.26 routine admitted with an attached container mounts the workspace through tools', async (t) => {
  const admitted = legacyFixture.routineInitialData;
  assert.equal(admitted.runtimePlan.sandbox.mode, 'cloudflare');
  t.mock.method(getConfigStore(), 'getAgent', async () => legacyFixture.agent);
  const { runtimePlan: plan } = parseRoutineExecutionInitialData(admitted);
  assert.equal(plan.sandbox.mode, 'bash');
  assert.deepEqual(plan.codingWorkspace, { available: true });
  const context = createFlueContext({
    id: 'repo-routine-test', agentName: 'chickpea-routine-execution-v2', env: {},
    agentConfig: { resolveModel: () => ({}) } as any,
  });
  const harness = await context.initializeRootHarness(
    ChickpeaRoutineExecution,
    slackSignal(plan),
    admitted as any,
  );
  try {
    assert.deepEqual(skillNames(harness), ['repositories', 'workspace']);
    assert.match((harness as any).config.skills.workspace.instructions, /workspace_exec/);
  } finally {
    await harness.close();
  }
});

test('RuntimePlanV2 bash turn with repository grants mounts Repositories and credentialed GitHub REST', async (t) => {
  const agent = supportAgent();
  t.mock.method(getConfigStore(), 'getAgent', async () => agent);
  const settings = getSettingsStore();
  await settings.setSetting(GITHUB_SETTING_KEYS.appId, 'runtime-plan-repo-app');
  await settings.setSetting(GITHUB_SETTING_KEYS.privateKey, APP_PRIVATE_KEY);
  t.after(async () => {
    await settings.deleteSetting(GITHUB_SETTING_KEYS.appId);
    await settings.deleteSetting(GITHUB_SETTING_KEYS.privateKey);
  });
  const calls: Array<{ url: string; authorization: string | null; nonce: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit = {}) => {
    const nonce = randomUUID();
    calls.push({ url: String(url), authorization: new Headers(options.headers).get('authorization'), nonce });
    if (/\/app\/installations\/50001\/access_tokens$/.test(String(url))) {
      return Response.json({
        token: 'fixture-installation-token',
        expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      });
    }
    return Response.json({ full_name: 'acme/acme-rails', nonce });
  });

  const plan = compilePlan(agent);
  assert.equal(plan.sandbox.mode, 'bash');
  const context = createFlueContext({
    id: 'repo-bash-test', agentName: 'chickpea-slack-v2', env: {},
    agentConfig: { resolveModel: () => ({}) } as any,
  });
  const harness = await context.initializeRootHarness(ChickpeaSlack, slackSignal(plan), plan);
  try {
    // No workspace skill without a Cloudflare workspace; Repositories still mounts.
    assert.deepEqual(skillNames(harness), ['agent-authoring', 'repositories', 'ticket-triage']);
    const instructions = String((harness as any).config.instructions);
    assert.match(instructions, /Granted GitHub repositories for this turn: \["acme\/acme-rails"\]/);
    assert.match(instructions, /GitHub REST recipes in the Repositories skill/);
    assert.doesNotMatch(instructions, /fixture-installation-token/);

    const read = await harness.sandbox.exec(
      'curl -sS https://api.github.com/repos/acme/acme-rails',
    );
    assert.equal(read.exitCode, 0, JSON.stringify(read));
    const apiCall = calls.find(({ url }) => url === 'https://api.github.com/repos/acme/acme-rails');
    assert.ok(apiCall, JSON.stringify(calls.map(({ url }) => url)));
    assert.equal(JSON.parse(read.stdout).nonce, apiCall.nonce);
    assert.equal(apiCall.authorization, 'Bearer fixture-installation-token');
    assert.doesNotMatch(read.stdout, /fixture-installation-token/);

    const ungranted = await harness.sandbox.exec('curl -sS https://api.github.com/repos/acme/other');
    assert.notEqual(ungranted.exitCode, 0);
  } finally {
    await harness.close();
  }
});

test('runtime plan skills keep connector precedence and the reserved authoring name', () => {
  const plan = {
    apiConnections: [],
    repositories: [{ id: 'repo_rails', fullName: 'acme/acme-rails' }],
    sandbox: { mode: 'bash' as const },
    codingWorkspace: { available: true as const },
    skills: [
      // Agent-authored Repositories deliberately overrides the built-in one.
      { name: 'repositories', description: 'Custom repos.', instructions: 'Custom.' },
      { name: 'agent-authoring', description: 'Shadow.', instructions: 'Shadow.' },
    ],
  };
  const skills = runtimePlanSkills(plan as any);
  assert.deepEqual(skills.map(({ name }) => name), ['repositories', 'workspace']);
  assert.equal((skills[0] as any).instructions, 'Custom.');

  const bash = runtimePlanSkills({ ...plan, skills: [], codingWorkspace: undefined } as any);
  assert.deepEqual(bash.map(({ name }) => name), ['repositories']);
  const none = runtimePlanSkills({ ...plan, skills: [], repositories: [], codingWorkspace: undefined } as any);
  assert.deepEqual(none, []);
});

test('an all-repositories grant names its org in the Repositories skill and the turn instruction', () => {
  const agent = {
    ...supportAgent(),
    repositories: [{
      id: 'all', installationId: 1, accountLogin: 'acme', fullName: '', allRepos: true, enabled: true,
    }],
  };
  const plan = compilePlan(agent);
  assert.deepEqual(plan.repositories, [
    { id: 'all', fullName: '', allRepos: true, accountLogin: 'acme' },
  ]);

  const repositories = runtimePlanSkills(plan).find(({ name }) => name === 'repositories');
  assert.match((repositories as any).instructions, /- all repositories in `acme`/);

  const instruction = runtimePlanConnectedServicesInstruction(plan);
  assert.match(instruction, /Granted GitHub repositories for this turn: \["all repositories in acme"\]/);
});
