import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  parseRuntimePlanV2,
  runtimePlanConversationKey,
  runtimePlanSandboxConversationKey,
} from '../src/agents/runtime-plan.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../src/config/types.ts';
import type { EffectiveConnectionAccount } from '../src/connections/types.ts';
import { sandboxThreadKey } from '../src/sandbox/thread-key.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { revisionedAlias } from '../src/model-catalog/provider-alias.ts';

const AGENT: CustomAgentConfig = {
  id: 'agent_runtime',
  kind: 'user',
  revision: 1,
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

const EFFECTIVE_CONNECTIONS: EffectiveConnectionAccount[] = [
  {
    account: {
      id: 'notion', workspaceId: 'T_RUNTIME', revision: 1, ownerKind: 'team',
      createdByMembershipId: 'membership_owner', providerId: 'notion', label: 'Notion',
      policy: {
        kind: 'mcp', url: 'https://mcp.example.com/notion', transport: 'streamable-http',
        authMode: 'oauth', headerNames: ['x-secret-header'],
        discoveredTools: [{ name: 'search' }, { name: 'read' }], allowedTools: ['search'],
      },
      secretRefId: 'secret_notion', lifecycle: 'ready', createdAt: 1, updatedAt: 1,
    },
    binding: {
      agentId: 'agent_runtime', connectionAccountId: 'notion', providerId: 'notion',
      allowedCapabilities: ['search'], enabled: true, createdAt: 1, updatedAt: 1,
    },
    policy: {
      kind: 'mcp', url: 'https://mcp.example.com/notion', transport: 'streamable-http',
      authMode: 'oauth', headerNames: ['x-secret-header'],
      discoveredTools: [{ name: 'search' }, { name: 'read' }], allowedTools: ['search'],
    },
    scope: 'team',
  },
  {
    account: {
      id: 'crm', workspaceId: 'T_RUNTIME', revision: 1, ownerKind: 'team',
      createdByMembershipId: 'membership_owner', providerId: 'crm', label: 'CRM',
      policy: {
        kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1/accounts'],
        headerName: 'authorization', headerValuePrefix: 'Bearer ', allowedMethods: ['GET'],
        authMode: 'credential',
      },
      secretRefId: 'secret_crm', lifecycle: 'ready', createdAt: 1, updatedAt: 1,
    },
    binding: {
      agentId: 'agent_runtime', connectionAccountId: 'crm', providerId: 'crm',
      allowedCapabilities: ['GET'], enabled: true, createdAt: 1, updatedAt: 1,
    },
    policy: {
      kind: 'api', allowedHosts: ['api.example.com'], pathPrefixes: ['/v1/accounts'],
      headerName: 'authorization', headerValuePrefix: 'Bearer ', allowedMethods: ['GET'],
      authMode: 'credential',
    },
    scope: 'team',
  },
];

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
    modelAttribution: {
      source: 'workspace_default',
      providerId: 'openai',
      workspaceDefaultRevision: 7,
    },
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
    effectiveConnections: structuredClone(EFFECTIVE_CONNECTIONS),
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

test('activated owner incarnations rotate continuity and freeze public handoff context', () => {
  const first = compile({
    assignment: assignment({ runtimeContract: 'chickpea-v1', ownerIncarnation: 1 }),
  });
  const second = compile({
    assignment: assignment({
      runtimeContract: 'chickpea-v1',
      ownerIncarnation: 2,
      handoffContext: [
        { messageTs: '1783000000.000050', role: 'human', text: 'Visible question.' },
        {
          messageTs: '1783000000.000075', role: 'agent', agentId: 'agent_previous',
          text: 'Visible answer.',
        },
      ],
    }),
  });

  assert.notEqual(first.conversation.continuityKey, second.conversation.continuityKey);
  assert.notEqual(deriveRuntimePlanInstanceId(first), deriveRuntimePlanInstanceId(second));
  assert.equal(second.ownerIncarnation, 2);
  assert.deepEqual(second.handoffContext, [
    { messageTs: '1783000000.000050', role: 'human', text: 'Visible question.' },
    {
      messageTs: '1783000000.000075', role: 'agent', agentId: 'agent_previous',
      text: 'Visible answer.',
    },
  ]);
});

test('activated DMs use the real Slack root instead of the legacy channel-wide DM key', () => {
  const dmTurn = turn({
    channelId: 'D_RUNTIME',
    threadTs: '1783000000.000900',
    sessionThreadTs: 'dm',
    source: 'dm_message',
    channelType: 'im',
  });
  const legacy = compile({
    turn: dmTurn,
    assignment: assignment({ channelId: 'D_RUNTIME', runtimeContract: 'legacy' }),
  });
  const activated = compile({
    turn: dmTurn,
    assignment: assignment({
      channelId: 'D_RUNTIME', runtimeContract: 'chickpea-v1', ownerIncarnation: 2,
    }),
  });

  assert.equal(legacy.conversation.threadTs, 'dm');
  assert.equal(activated.conversation.threadTs, '1783000000.000900');
  assert.notEqual(legacy.conversation.continuityKey, activated.conversation.continuityKey);
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

  assert.equal(plan.schemaVersion, 3);
  assert.equal(plan.agentId, 'agent_runtime');
  assert.equal(plan.conversation.workspaceId, 'T_RUNTIME');
  assert.equal(plan.conversation.threadTs, '1783000000.000100');
  assert.equal(plan.conversation.surface, 'channel_thread');
  assert.match(plan.conversation.continuityKey, /^agent_[a-f0-9]{40}$/);
  assert.equal(plan.model, 'openai/gpt-5.4-mini');
  assert.equal(plan.runtimeModel, 'openai/gpt-5.4-mini');
  assert.deepEqual(plan.modelAttribution, {
    source: 'workspace_default',
    providerId: 'openai',
    workspaceDefaultRevision: 7,
  });
  assert.equal(plan.ownerIncarnation, 1);
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
  assert.equal(Object.hasOwn(plan, 'managedConnections'), false);
  assert.deepEqual(plan.repositories, [{ id: 'repo_acme', fullName: 'acme/product' }]);
  assert.equal(plan.sandbox.mode, 'cloudflare');
  assert.deepEqual(plan.artifactDestination, {
    kind: 'slack_conversation',
    channelId: 'C_RUNTIME',
  });
  assert.deepEqual(plan.configurationRevision, { agent: 1 });
  assert.match(plan.harnessRevision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(plan).includes('super-secret-token'), false);
  assert.equal(JSON.stringify(plan).includes('documents:read'), false);
  assert.equal(JSON.stringify(plan).includes('installationId'), false);
  assert.match(plan.instructions, /sk-live-looking-but-not-secret/);
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).harnessRevision, plan.harnessRevision);
});

test('a runtime plan freezes an internal execution route without changing its canonical model', () => {
  const plan = compile({ runtimeModel: 'openai-subscription/gpt-5.4-mini' });
  const apiKeyPlan = compile({ runtimeModel: 'openai/gpt-5.4-mini' });

  assert.equal(plan.model, 'openai/gpt-5.4-mini');
  assert.equal(plan.runtimeModel, 'openai-subscription/gpt-5.4-mini');
  assert.notEqual(plan.harnessRevision, apiKeyPlan.harnessRevision);
  assert.equal(
    parseRuntimePlanV2(structuredClone(plan)).runtimeModel,
    'openai-subscription/gpt-5.4-mini',
  );
});

test('a hosted route carries only compiled profile facts and binds its revisioned alias', () => {
  const sha256 = 'ab'.repeat(32);
  const providerId = revisionedAlias('openaiSubscription', 9, sha256).providerId;
  const runtimeModelRoute = {
    source: 'hosted_catalog' as const,
    revision: 9,
    sha256,
    lane: 'openai_subscription' as const,
    profile: 'openai-codex-responses-standard@1' as const,
    displayName: 'Hosted GPT',
    contextWindow: 200_000,
    maxTokens: 100_000,
  };
  const plan = compile({
    runtimeModel: `${providerId}/gpt-5.4-mini`,
    runtimeModelRoute,
  });

  assert.deepEqual(plan.runtimeModelRoute, runtimeModelRoute);
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).runtimeModelRoute?.profile,
    'openai-codex-responses-standard@1');
  assert.throws(
    () => parseRuntimePlanV2({
      ...plan,
      runtimeModelRoute: { ...runtimeModelRoute, baseUrl: 'https://attacker.example' },
    }),
    /runtimeModelRoute.*unknown field/i,
  );
});

test('managed providers freeze Chickpea capabilities without remote account identifiers', () => {
  const policy = {
    kind: 'managed' as const,
    adapterId: 'composio',
    toolkit: 'gmail',
    principalRef: 'chickpea-user-private',
    accountRef: 'ca_private',
    allowedCapabilities: ['gmail.messages.search', 'gmail.drafts.create'],
    resourceConstraints: {
      mailboxIds: [{
        handle: 'mailbox_primary',
        providerRef: 'provider-mailbox-private',
        label: 'Primary mailbox',
      }],
    },
  };
  const managed: EffectiveConnectionAccount = {
    account: {
      id: 'gmail-managed', workspaceId: 'T_RUNTIME', revision: 1, ownerKind: 'team',
      createdByMembershipId: 'membership_owner', providerId: 'google', label: 'Managed Gmail',
      policy, secretRefId: 'secret_unused', lifecycle: 'ready', createdAt: 1, updatedAt: 1,
    },
    binding: {
      agentId: 'agent_runtime', connectionAccountId: 'gmail-managed', providerId: 'google',
      allowedCapabilities: ['gmail.messages.search'], enabled: true, createdAt: 1, updatedAt: 1,
      resourceConstraints: { mailboxIds: ['mailbox_primary'] },
    },
    policy: { ...policy, allowedCapabilities: ['gmail.messages.search'] },
    scope: 'team',
  };

  const plan = compile({ effectiveConnections: [...structuredClone(EFFECTIVE_CONNECTIONS), managed] });
  assert.equal(Object.hasOwn(plan, 'managedConnections'), true);
  assert.deepEqual(plan.managedConnections, [{
    id: 'gmail-managed',
    providerId: 'google',
    adapterId: 'composio',
    toolkit: 'gmail',
    allowedCapabilities: ['gmail.messages.search'],
    resourceConstraints: { mailboxIds: ['mailbox_primary'] },
  }]);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /ca_private|chickpea-user-private|secret_unused|provider-mailbox-private|Primary mailbox/,
  );
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).harnessRevision, plan.harnessRevision);
});

test('personal authorization choices freeze labels and lifecycle without credential policy', () => {
  const plan = compile({
    turn: turn({ actorMembershipId: 'membership_alice' }),
    connectionAuthorizations: [{
      providerId: 'google',
      templateAccountId: 'connection_template',
      policy: {
        kind: 'api',
        allowedHosts: ['gmail.googleapis.com'],
        pathPrefixes: ['/gmail/v1/users/me'],
        headerName: 'authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET'],
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      },
      allowedCapabilities: ['GET'],
      accounts: [{
        id: 'connection_work',
        label: 'Work',
        purpose: 'Company mail',
        lifecycle: 'needs_attention',
      }],
    }],
    connectionChoices: [{
      providerId: 'google',
      choices: [
        { label: 'Work', purpose: 'Company mail', scope: 'personal' },
        { label: 'Personal', scope: 'personal' },
      ],
    }],
  });

  assert.deepEqual(plan.connectionAuthorizations, [{
    providerId: 'google',
    templateAccountId: 'connection_template',
    accounts: [{
      id: 'connection_work',
      label: 'Work',
      purpose: 'Company mail',
      lifecycle: 'needs_attention',
    }],
  }]);
  assert.deepEqual(plan.connectionChoices?.[0]?.choices.map(({ label }) => label), [
    'Work',
    'Personal',
  ]);
  const serialized = JSON.stringify({
    authorizations: plan.connectionAuthorizations,
    choices: plan.connectionChoices,
  });
  assert.doesNotMatch(serialized, /gmail\.googleapis|gmail\.readonly|secretRef|clientSecret|Bearer/i);
  assert.equal(parseRuntimePlanV2(structuredClone(plan)).harnessRevision, plan.harnessRevision);
});

test('semantic-memory runtime policy rotates new plans while v2 plans remain readable', () => {
  const semanticMemoryPlan = compile();
  const legacy = compile({ continuityPolicy: 'slack-runtime-v2' });

  assert.equal(semanticMemoryPlan.continuityPolicy, 'slack-runtime-v3');
  assert.equal(parseRuntimePlanV2(structuredClone(legacy)).continuityPolicy, 'slack-runtime-v2');
  assert.notEqual(semanticMemoryPlan.harnessRevision, legacy.harnessRevision);
  assert.notEqual(
    deriveRuntimePlanInstanceId(semanticMemoryPlan),
    deriveRuntimePlanInstanceId(legacy),
  );
});

test('persisted RuntimePlan V2 jobs remain readable without new attribution fields', () => {
  const {
    ownerIncarnation: _ownerIncarnation,
    modelAttribution: _modelAttribution,
    runtimeModel: _runtimeModel,
    ...legacy
  } = compile();
  const v2 = { ...legacy, schemaVersion: 2 as const };
  v2.harnessRevision = compatibilityHarnessRevision(v2);

  const parsed = parseRuntimePlanV2(v2);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.model, 'openai/gpt-5.4-mini');
  assert.equal(parsed.modelAttribution, undefined);
  assert.equal(parsed.ownerIncarnation, undefined);
});

test('a pre-attribution persisted assignment keeps its model and is labeled legacy on retry', () => {
  const legacyAssignment = assignment();
  delete legacyAssignment.modelAttribution;
  const plan = compile({ assignment: legacyAssignment });
  assert.equal(plan.model, 'openai/gpt-5.4-mini');
  assert.deepEqual(plan.modelAttribution, {
    source: 'legacy_environment',
    providerId: 'openai',
  });
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
    effectiveConnections: structuredClone(EFFECTIVE_CONNECTIONS),
  };
  const reordered = compileRuntimePlanV2(reorderedInput);

  assert.equal(reordered.harnessRevision, first.harnessRevision);
  assert.equal(deriveRuntimePlanInstanceId(reordered), deriveRuntimePlanInstanceId(first));
});

test('harness policy and frozen credential epochs rotate the runtime incarnation', () => {
  const baseline = compile();
  const cases = [
    compile({ assignment: assignment({
      model: 'anthropic/claude-haiku-4-5',
      modelAttribution: { source: 'pinned', providerId: 'anthropic' },
    }) }),
    compile({ instructions: 'Changed instructions.' }),
    compile({
      assignment: assignment({
        agent: { ...structuredClone(AGENT), skills: [{ ...AGENT.skills[0]!, instructions: 'Changed.' }] },
      }),
    }),
    compile({ effectiveConnections: withMcpPolicy({ allowedTools: ['read'] }) }),
    compile({ sandboxMode: 'bash' }),
    compile({ memoryEpoch: 4 }),
    compile({ continuityPolicy: 'slack-runtime-v4' }),
    compile({
      assignment: assignment({
        agent: { ...structuredClone(AGENT), revision: AGENT.revision + 1 },
      }),
    }),
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
  assert.deepEqual(credentialRotated.modelCredential, {
    credentialRefId: 'credential_new',
    version: 99,
    providerId: 'openai',
  });
  assert.notEqual(credentialRotated.harnessRevision, baseline.harnessRevision);
  assert.notEqual(deriveRuntimePlanInstanceId(credentialRotated), deriveRuntimePlanInstanceId(baseline));
  assert.doesNotMatch(JSON.stringify(credentialRotated), /Rotated key/);

  const liveResolverChange = compile({
    effectiveConnections: withMcpPolicy({
      authMode: 'bearer',
      headerNames: ['x-new-secret-reference'],
    }),
  });
  assert.notEqual(liveResolverChange.harnessRevision, baseline.harnessRevision);
  assert.notEqual(deriveRuntimePlanInstanceId(liveResolverChange), deriveRuntimePlanInstanceId(baseline));
});

test('legacy Agent-scoped connector rows never enter a runtime plan', () => {
  const plan = compile({ effectiveConnections: [] });
  assert.deepEqual(plan.mcpConnections, []);
  assert.deepEqual(plan.apiConnections, []);
});

function withMcpPolicy(
  patch: Partial<Extract<EffectiveConnectionAccount['policy'], { kind: 'mcp' }>>,
): EffectiveConnectionAccount[] {
  const connections = structuredClone(EFFECTIVE_CONNECTIONS);
  const current = connections[0]!;
  if (current.policy.kind !== 'mcp' || current.account.policy.kind !== 'mcp') {
    throw new Error('MCP fixture is invalid.');
  }
  current.policy = { ...current.policy, ...patch };
  current.account.policy = { ...current.account.policy, ...patch };
  return connections;
}

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

function compatibilityHarnessRevision(plan: ReturnType<typeof compile>): string {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: plan.schemaVersion,
    continuityPolicy: plan.continuityPolicy,
    agentId: plan.agentId,
    ...(plan.actorMembershipId ? { actorMembershipId: plan.actorMembershipId } : {}),
    ...(plan.connectionAccountIds !== undefined
      ? { connectionAccountIds: plan.connectionAccountIds }
      : {}),
    ...(plan.connectionAuthorizations !== undefined
      ? { connectionAuthorizations: plan.connectionAuthorizations }
      : {}),
    ...(plan.connectionChoices !== undefined
      ? { connectionChoices: plan.connectionChoices }
      : {}),
    ...(plan.configurationRevision
      ? { configurationRevision: plan.configurationRevision }
      : {}),
    model: plan.model,
    instructions: plan.instructions,
    memoryEpoch: plan.memoryEpoch,
    skills: plan.skills,
    mcpConnections: plan.mcpConnections,
    apiConnections: plan.apiConnections,
    repositories: plan.repositories,
    sandbox: plan.sandbox,
    artifactDestinationKind: plan.artifactDestination.kind,
  })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
