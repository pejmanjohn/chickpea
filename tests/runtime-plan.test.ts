import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const AGENT: CustomAgentConfig = {
  id: 'agent_runtime',
  name: 'Runtime',
  instructions: 'Use the available evidence. A legitimate value is sk-live-looking-but-not-secret.',
  enabled: true,
  model: 'openai/gpt-5.4-mini',
  skills: [
    {
      name: 'research',
      description: 'Research trusted sources.',
      instructions: 'Prefer primary sources.',
      enabled: true,
    },
    {
      name: 'disabled',
      description: 'Disabled.',
      instructions: 'Never loaded.',
      enabled: false,
    },
  ],
  mcpServers: [
    {
      id: 'notion',
      displayName: 'Notion',
      url: 'https://mcp.example.com/notion',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: ['x-secret-header'],
      enabled: true,
      lifecycleStatus: 'ready',
      statusText: 'Connected',
      discoveredTools: [{ name: 'search' }, { name: 'read' }],
      allowedTools: ['search'],
      oauthScope: 'documents:read',
    },
  ],
  apiConnections: [
    {
      id: 'crm',
      displayName: 'CRM',
      allowedHosts: ['api.example.com'],
      pathPrefixes: ['/v1/accounts'],
      headerName: 'authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: ['GET'],
      enabled: true,
      authMode: 'credential',
      lifecycleStatus: 'ready',
    },
  ],
  repositories: [
    {
      id: 'repo_acme',
      installationId: 42,
      accountLogin: 'acme',
      fullName: 'acme/product',
      enabled: true,
    },
  ],
};

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T_RUNTIME',
    channelId: 'C_RUNTIME',
    eventId: 'E_RUNTIME',
    text: 'Investigate this.',
    userId: 'U_RUNTIME',
    messageTs: '1783000000.000200',
    threadTs: '1783000000.000100',
    source: 'app_mention',
    contextMode: 'thread',
    ...overrides,
  };
}

function assignment(overrides: Partial<ResolvedAssignment> = {}): ResolvedAssignment {
  return {
    workspaceId: 'T_RUNTIME',
    channelId: 'C_RUNTIME',
    agentId: AGENT.id,
    agent: structuredClone(AGENT),
    model: 'openai/gpt-5.4-mini',
    ...overrides,
  };
}

function compile(overrides: Partial<Parameters<typeof compileRuntimePlanV2>[0]> = {}) {
  return compileRuntimePlanV2({
    turn: turn(),
    assignment: assignment(),
    instructions: 'Complete instructions. A legitimate value is sk-live-looking-but-not-secret.',
    memoryEpoch: 3,
    sandboxMode: 'cloudflare',
    ...overrides,
  });
}

test('a complete first-turn plan contains policy descriptors but no auth material', () => {
  const plan = compile();

  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.conversation.workspaceId, 'T_RUNTIME');
  assert.equal(plan.conversation.threadTs, '1783000000.000100');
  assert.equal(plan.conversation.surface, 'channel_thread');
  assert.match(plan.conversation.continuityKey, /^agent_[a-f0-9]{40}$/);
  assert.equal(plan.model, 'openai/gpt-5.4-mini');
  assert.equal(plan.memoryEpoch, 3);
  assert.deepEqual(plan.skills.map(({ name }) => name), ['research']);
  assert.deepEqual(plan.mcpConnections, [{
    id: 'notion',
    url: 'https://mcp.example.com/notion',
    transport: 'streamable-http',
    allowedTools: ['search'],
    optional: true,
  }]);
  assert.deepEqual(plan.apiConnections, [{
    id: 'crm',
    allowedHosts: ['api.example.com'],
    pathPrefixes: ['/v1/accounts'],
    allowedMethods: ['GET'],
  }]);
  assert.deepEqual(plan.repositories, [{ id: 'repo_acme', fullName: 'acme/product' }]);
  assert.equal(plan.sandbox.mode, 'cloudflare');
  assert.deepEqual(plan.artifactDestination, {
    kind: 'slack_conversation',
    channelId: 'C_RUNTIME',
  });
  assert.match(plan.harnessRevision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes('authorization'), false);
  assert.equal(JSON.stringify(plan).includes('documents:read'), false);
  assert.equal(JSON.stringify(plan).includes('installationId'), false);
  assert.match(plan.instructions, /sk-live-looking-but-not-secret/);
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).harnessRevision, plan.harnessRevision);
});

test('equivalent key and set ordering produces one revision and instance id', () => {
  const first = compile();
  const reorderedAgent = structuredClone(AGENT);
  reorderedAgent.mcpServers[0]!.allowedTools = ['search'];
  reorderedAgent.apiConnections[0]!.allowedHosts = ['api.example.com'];
  const reorderedInput = {
    sandboxMode: 'cloudflare' as const,
    memoryEpoch: 3,
    instructions: first.instructions,
    assignment: assignment({ agent: reorderedAgent }),
    turn: turn(),
  };
  const reordered = compileRuntimePlanV2(reorderedInput);

  assert.equal(reordered.harnessRevision, first.harnessRevision);
  assert.equal(deriveRuntimePlanInstanceId(reordered), deriveRuntimePlanInstanceId(first));
});

test('harness policy changes rotate while credential attribution does not', () => {
  const baseline = compile();
  const cases = [
    compile({ assignment: assignment({ model: 'anthropic/claude-haiku-4-5' }) }),
    compile({ instructions: 'Changed instructions.' }),
    compile({
      assignment: assignment({
        agent: { ...structuredClone(AGENT), skills: [{ ...AGENT.skills[0]!, instructions: 'Changed.' }] },
      }),
    }),
    compile({
      assignment: assignment({
        agent: {
          ...structuredClone(AGENT),
          mcpServers: [{ ...AGENT.mcpServers[0]!, allowedTools: ['read'] }],
        },
      }),
    }),
    compile({ sandboxMode: 'bash' }),
    compile({ memoryEpoch: 4 }),
    compile({ continuityPolicy: 'slack-runtime-v3' }),
  ];
  for (const changed of cases) {
    assert.notEqual(changed.harnessRevision, baseline.harnessRevision);
    assert.notEqual(deriveRuntimePlanInstanceId(changed), deriveRuntimePlanInstanceId(baseline));
  }

  const credentialRotated = compile({
    assignment: assignment({
      modelCredential: {
        credentialRefId: 'credential_new',
        version: 99,
        providerId: 'openai',
        sourceKind: 'stored',
        label: 'Rotated key',
        scopeLabel: null,
        unknownRotation: false,
      },
    }),
  });
  assert.equal(credentialRotated.harnessRevision, baseline.harnessRevision);
  assert.equal(deriveRuntimePlanInstanceId(credentialRotated), deriveRuntimePlanInstanceId(baseline));

  const mcpCredentialPolicyRotated = structuredClone(AGENT);
  mcpCredentialPolicyRotated.mcpServers[0] = {
    ...mcpCredentialPolicyRotated.mcpServers[0]!,
    authMode: 'bearer',
    headerNames: ['x-new-secret-reference'],
    statusText: 'Credential rotated',
  };
  const liveResolverChange = compile({
    assignment: assignment({ agent: mcpCredentialPolicyRotated }),
  });
  assert.equal(liveResolverChange.harnessRevision, baseline.harnessRevision);
  assert.equal(deriveRuntimePlanInstanceId(liveResolverChange), deriveRuntimePlanInstanceId(baseline));
});

test('strict parsing rejects unknown and explicit auth fields without token heuristics', () => {
  const plan = compile();
  assert.throws(
    () => parseRuntimePlanV2({ ...plan, surprise: true }),
    /unknown field.*surprise/i,
  );
  assert.throws(
    () => parseRuntimePlanV2({ ...plan, authToken: 'secret' }),
    /unknown field.*authToken/i,
  );
  assert.throws(
    () => parseRuntimePlanV2({
      ...plan,
      mcpConnections: [{ ...plan.mcpConnections[0]!, authMode: 'oauth' }],
    }),
    /unknown field.*authMode/i,
  );

  const legitimate = parseRuntimePlanV2(compile({
    instructions: 'Discuss sk-live-looking-example as untrusted user text.',
  }));
  assert.match(legitimate.instructions, /sk-live-looking-example/);
});

test('direct and App Home plans use stable conversation coordinates', () => {
  const dm = compile({
    turn: turn({
      channelId: 'D_RUNTIME',
      threadTs: '1783000000.000200',
      sessionThreadTs: 'dm',
      source: 'dm_message',
      channelType: 'im',
      contextMode: 'dm_history',
    }),
    assignment: assignment({ channelId: 'D_RUNTIME' }),
  });
  const appHome = compile({
    turn: turn({
      channelId: 'D_HOME',
      threadTs: '1783000000.000300',
      sessionThreadTs: 'dm',
      source: 'dm_message',
      channelType: 'app_home',
      contextMode: 'dm_history',
    }),
    assignment: assignment({ channelId: 'D_HOME' }),
  });

  assert.equal(dm.conversation.surface, 'direct_message');
  assert.equal(dm.conversation.threadTs, 'dm');
  assert.equal(appHome.conversation.surface, 'app_home');
  assert.equal(appHome.conversation.threadTs, 'dm');
});
