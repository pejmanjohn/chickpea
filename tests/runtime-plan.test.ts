import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  runtimePlanConversationKey,
  runtimePlanSandboxConversationKey,
  type RuntimePlanV2,
} from '../src/agents/runtime-plan.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import { sandboxThreadKey } from '../src/sandbox/thread-key.ts';
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

test('the sandbox conversation key stays a Slack coordinate instead of a Flue instance id', () => {
  const plan = compile();

  assert.equal(
    runtimePlanConversationKey(plan),
    'T_RUNTIME:C_RUNTIME:1783000000.000100',
  );
  assert.notEqual(runtimePlanConversationKey(plan), deriveRuntimePlanInstanceId(plan));
});

test('owner-bound sandbox keys converge for retries and isolate competing routine attempts', () => {
  const plan = compile();
  const first = runtimePlanSandboxConversationKey(plan, 'routineagent_first');
  const second = runtimePlanSandboxConversationKey(plan, 'routineagent_second');

  assert.equal(first, runtimePlanSandboxConversationKey(plan, 'routineagent_first'));
  assert.notEqual(first, second);
  assert.match(first, /^sandbox_[a-f0-9]{40}$/);
  assert.ok(first.length <= 63, 'Cloudflare Sandbox ids must not exceed 63 characters');
  assert.equal(sandboxThreadKey(first), first);
  assert.notEqual(sandboxThreadKey(first), sandboxThreadKey(second));
  assert.throws(() => runtimePlanSandboxConversationKey(plan, '   '), /owner identity is invalid/);
  assert.throws(() => runtimePlanSandboxConversationKey(plan, 'x'.repeat(201)), /owner identity is invalid/);
});

test('owner-bound sandbox keys stay provider-safe at maximum runtime-plan bounds', () => {
  const workspaceId = `T${'W'.repeat(79)}`;
  const channelId = `C${'H'.repeat(79)}`;
  const plan = compile({
    turn: turn({
      workspaceId,
      channelId,
      threadTs: '12345678901234567890.1234567890',
    }),
    assignment: assignment({ workspaceId, channelId }),
  });

  const key = runtimePlanSandboxConversationKey(plan, 'x'.repeat(200));
  assert.match(key, /^sandbox_[a-f0-9]{40}$/);
  assert.ok(key.length <= 63, 'Cloudflare Sandbox ids must not exceed 63 characters');
  assert.equal(sandboxThreadKey(key), key);
});

test('a complete first-turn plan contains policy descriptors but no auth material', () => {
  const plan = compile();

  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.agentId, 'agent_runtime');
  assert.equal(plan.slackIdentityId, 'slack_identity_default');
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
    authMode: 'oauth',
    headerNames: ['x-secret-header'],
    allowedTools: ['search'],
    optional: true,
  }]);
  assert.deepEqual(plan.apiConnections, [{
    id: 'crm',
    allowedHosts: ['api.example.com'],
    pathPrefixes: ['/v1/accounts'],
    allowedMethods: ['GET'],
    headerName: 'authorization',
    headerValuePrefix: 'Bearer ',
    authMode: 'credential',
  }]);
  assert.deepEqual(plan.repositories, [{ id: 'repo_acme', fullName: 'acme/product' }]);
  assert.equal(plan.sandbox.mode, 'cloudflare');
  assert.deepEqual(plan.artifactDestination, {
    kind: 'slack_conversation',
    channelId: 'C_RUNTIME',
  });
  assert.match(plan.harnessRevision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes('super-secret-token'), false);
  assert.equal(JSON.stringify(plan).includes('documents:read'), false);
  assert.equal(JSON.stringify(plan).includes('installationId'), false);
  assert.match(plan.instructions, /sk-live-looking-but-not-secret/);
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).harnessRevision, plan.harnessRevision);
});

test('Slack identity rotates new plans while legacy plans remain readable', () => {
  const baseline = compile();
  const dedicated = compile({
    assignment: assignment({ slackIdentityId: 'slack_identity_finance' }),
  });
  assert.equal(dedicated.slackIdentityId, 'slack_identity_finance');
  assert.notEqual(dedicated.harnessRevision, baseline.harnessRevision);

  const legacy = structuredClone(baseline);
  delete legacy.slackIdentityId;
  legacy.harnessRevision = legacyHarnessRevision(legacy);
  const parsed = parseRuntimePlanV2(legacy);
  assert.equal(parsed.slackIdentityId, undefined);
  assert.equal(parsed.harnessRevision, legacy.harnessRevision);
});

function legacyHarnessRevision(plan: RuntimePlanV2): string {
  return createHash('sha256')
    .update(canonicalJson({
      schemaVersion: plan.schemaVersion,
      continuityPolicy: plan.continuityPolicy,
      agentId: plan.agentId,
      model: plan.model,
      instructions: plan.instructions,
      memoryEpoch: plan.memoryEpoch,
      skills: plan.skills,
      mcpConnections: plan.mcpConnections,
      apiConnections: plan.apiConnections,
      repositories: plan.repositories,
      sandbox: plan.sandbox,
      artifactDestinationKind: plan.artifactDestination.kind,
    }))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

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
  assert.notEqual(liveResolverChange.harnessRevision, baseline.harnessRevision);
  assert.notEqual(deriveRuntimePlanInstanceId(liveResolverChange), deriveRuntimePlanInstanceId(baseline));
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
      mcpConnections: [{ ...plan.mcpConnections[0]!, authToken: 'secret' }],
    }),
    /unknown field.*authToken/i,
  );

  const legitimate = parseRuntimePlanV2(compile({
    instructions: 'Discuss sk-live-looking-example as untrusted user text.',
  }));
  assert.match(legitimate.instructions, /sk-live-looking-example/);
});

test('direct plans use stable coordinates and normalize persisted App Home surfaces', () => {
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
  assert.equal(dm.conversation.surface, 'direct_message');
  assert.equal(dm.conversation.threadTs, 'dm');
  const legacyAppHome = structuredClone(dm) as unknown as {
    conversation: { surface: string };
  };
  legacyAppHome.conversation.surface = 'app_home';
  assert.equal(
    parseRuntimePlanV2(legacyAppHome).conversation.surface,
    'direct_message',
  );
});
