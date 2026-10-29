import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRuntimePlanActivityContext,
  compileRuntimePlanV2,
  parseRuntimePlanV2,
  type RuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import { runtimePlanSkills } from '../src/agents/slack-thread.ts';
import type {
  AgentConnectionBinding,
  ConnectionAccount,
  ConnectionAccountPolicy,
  CustomAgentConfig,
} from '../src/config/types.ts';
import { projectEffectiveConnectionAccounts } from '../src/connections/runtime.ts';

const KB_GUIDE = [
  'Knowledge Base beta API under /cms/knowledge-base/2027-03-beta.',
  'List articles with GET articles?includeBody=false; full bodies overflow the response.',
  'Edits go to articles/{id}/draft. POST articles/{id}/draft/push-live publishes and needs the publish scope.',
].join('\n');

const AGENT: CustomAgentConfig = {
  id: 'agent_scribe',
  kind: 'user',
  revision: 1,
  name: 'Scribe',
  instructions: 'Keep the help center current.',
  enabled: true,
  model: 'openai/gpt-5.4-mini',
  skills: [],
  mcpServers: [],
  apiConnections: [],
  repositories: [],
};

interface Seed {
  id: string;
  label: string;
  policy: ConnectionAccountPolicy;
  lifecycle?: ConnectionAccount['lifecycle'];
  bindingEnabled?: boolean;
}

function account({ id, label, policy, lifecycle = 'ready' }: Seed): ConnectionAccount {
  return {
    id, workspaceId: 'T_GUIDE', revision: 1, ownerKind: 'team', createdByMembershipId: 'membership_owner',
    providerId: id, label, policy, secretRefId: `secret_${id}`, lifecycle, createdAt: 1, updatedAt: 1,
  };
}

function binding({ id, policy, bindingEnabled = true }: Seed): AgentConnectionBinding {
  return {
    agentId: AGENT.id, connectionAccountId: id, providerId: id,
    allowedCapabilities: policy.kind === 'mcp' ? [...policy.allowedTools] : [], enabled: bindingEnabled,
    createdAt: 1, updatedAt: 1,
  };
}

function apiPolicy(host: string, overrides: Partial<Extract<ConnectionAccountPolicy, { kind: 'api' }>> = {}) {
  return {
    kind: 'api' as const, allowedHosts: [host], pathPrefixes: [], headerName: 'Authorization',
    headerValuePrefix: 'Bearer ', allowedMethods: ['GET'], authMode: 'credential' as const, ...overrides,
  };
}

const knowledgeBase: Seed = {
  id: 'connection_00000000000000000000000000000001',
  label: 'HubSpot Knowledge Base',
  policy: apiPolicy('api.hubapi.com', {
    pathPrefixes: ['/cms/knowledge-base/2027-03-beta'],
    allowedMethods: ['GET', 'HEAD', 'POST', 'PATCH'],
    guide: KB_GUIDE,
  }),
};

function compile(seeds: readonly Seed[]): RuntimePlanV2 {
  const effectiveConnections = projectEffectiveConnectionAccounts(
    seeds.map(account), seeds.map(binding), 'membership_owner',
  );
  return compileRuntimePlanV2({
    turn: {
      workspaceId: 'T_GUIDE', channelId: 'C_GUIDE', eventId: 'E_GUIDE', text: 'Update the refund article.',
      userId: 'U_GUIDE', messageTs: '1787000000.000200', threadTs: '1787000000.000100',
      source: 'app_mention', contextMode: 'thread',
    },
    assignment: {
      workspaceId: 'T_GUIDE', channelId: 'C_GUIDE', agentId: AGENT.id, agent: structuredClone(AGENT),
      model: AGENT.model!,
      modelAttribution: { source: 'workspace_default', providerId: 'openai', workspaceDefaultRevision: 1 },
    },
    instructions: AGENT.instructions,
    memoryEpoch: 1,
    effectiveConnections,
  });
}

function skillsOf(plan: RuntimePlanV2): Array<{ name: string; description: string; instructions: string }> {
  return runtimePlanSkills(plan) as unknown as Array<{ name: string; description: string; instructions: string }>;
}

test('an enabled, ready connection with a guide reaches its Agent as a skill with the connection scope', () => {
  const [skill, ...others] = skillsOf(compile([knowledgeBase]));
  assert.deepEqual(others, []);
  assert.equal(skill?.name, 'connection-00000000000000000000000000000001');
  assert.match(skill!.description, /HubSpot Knowledge Base/);
  const { instructions } = skill!;
  assert.ok(instructions.includes(KB_GUIDE), 'the guide is the body of the skill');
  assert.match(instructions, /`connection_request`/);
  assert.match(instructions, /never ask the user for a token/);
  const scope = instructions.split('## Your connection')[1] ?? '';
  assert.match(scope, /- Allowed hosts: `api\.hubapi\.com`/);
  assert.match(scope, /- Path scope: `\/cms\/knowledge-base\/2027-03-beta`/);
  assert.match(scope, /- Allowed methods: GET, HEAD, PATCH, POST/);
  assert.match(instructions, /`url_not_allowed`/, 'the request error guidance follows');
});

test('a pending connection, a turned-off binding and a connection without a guide add no guide skill', () => {
  const skills = skillsOf(compile([
    { ...knowledgeBase, lifecycle: 'pending' },
    { ...knowledgeBase, id: 'connection_00000000000000000000000000000002', bindingEnabled: false },
    { id: 'connection_00000000000000000000000000000003', label: 'Status', policy: apiPolicy('status.example.com') },
  ]));
  assert.deepEqual(skills.map(({ name }) => name), []);
});

test('a built-in recipe and a guide for the same host are both mounted', () => {
  const asana: Seed = {
    id: 'connection_00000000000000000000000000000004',
    label: 'Asana',
    policy: apiPolicy('app.asana.com', { guide: 'Our team keeps launch tasks in the Launch project.' }),
  };
  const skills = skillsOf(compile([asana]));
  assert.deepEqual(skills.map(({ name }) => name), ['asana-api', 'connection-00000000000000000000000000000004']);
  assert.match(skills[1]!.instructions, /Launch project/);
  assert.doesNotMatch(skills[0]!.instructions, /Launch project/);
});

test('an MCP connection guide names its server and tools', () => {
  const tracker: Seed = {
    id: 'connection_00000000000000000000000000000005',
    label: 'Tracker',
    policy: {
      kind: 'mcp', url: 'https://mcp.tracker.example/mcp', transport: 'streamable-http', authMode: 'bearer',
      headerNames: [], discoveredTools: [{ name: 'search_issues' }, { name: 'file_issue' }],
      allowedTools: ['search_issues'], guide: 'Search by project key, for example SCN.',
    },
  };
  const [skill] = skillsOf(compile([tracker]));
  assert.equal(skill?.name, 'connection-00000000000000000000000000000005');
  assert.match(skill!.description, /Tracker/);
  assert.match(skill!.instructions, /Search by project key, for example SCN\./);
  const scope = skill!.instructions.split('## Your connection')[1] ?? '';
  assert.match(scope, /https:\/\/mcp\.tracker\.example\/mcp/);
  assert.match(scope, /`search_issues`/);
  assert.doesNotMatch(scope, /file_issue/, 'only the tools this Agent may call');
  assert.doesNotMatch(skill!.instructions, /connection_request/);
});

test('the guide is frozen into the plan: it survives a reread and a changed guide is a new revision', () => {
  const plan = compile([knowledgeBase]);
  assert.equal(plan.apiConnections[0]?.guide, KB_GUIDE);
  assert.deepEqual(parseRuntimePlanV2(structuredClone(plan)), plan);

  const edited = compile([{
    ...knowledgeBase,
    policy: { ...knowledgeBase.policy, guide: `${KB_GUIDE}\nArchive with PATCH {"archived":true}.` } as ConnectionAccountPolicy,
  }]);
  assert.notEqual(edited.harnessRevision, plan.harnessRevision);

  const { guide: _guide, ...withoutGuide } = knowledgeBase.policy as Extract<ConnectionAccountPolicy, { kind: 'api' }>;
  const unguided = compile([{ ...knowledgeBase, policy: withoutGuide }]);
  assert.equal(Object.hasOwn(unguided.apiConnections[0]!, 'guide'), false, 'a connection without a guide plans as before');
});

test('the status line names a guide skill by its connection, never by its id', () => {
  const plan = compile([knowledgeBase]);
  const context = buildRuntimePlanActivityContext(plan, { mountedSkillNames: skillsOf(plan).map(({ name }) => name) });
  assert.deepEqual(context.skills, [
    { name: 'connection-00000000000000000000000000000001', displayName: 'HubSpot Knowledge Base' },
  ]);
});
