import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityStatus,
  activityStatusForObservation,
  buildSemanticActivityContext,
  connectingActivityStatus,
  initialActivityStatus,
  isSafeTypedActivityStatus,
  registerActivityContext,
  registerActivityInvocationFact,
  toolActivityStatus,
} from '../src/activity/status.ts';
import {
  configuredSemanticDescriptor,
  genericSemanticDescriptor,
  isSemanticActivityDescriptor,
  managedConnectorSemanticDescriptor,
  narrateSemanticActivity,
  semanticDescriptorForCoreTool,
  semanticInvocationFact,
  thinkingSemanticActivity,
  webPageSemanticDescriptor,
  webSearchSemanticDescriptor,
} from '../src/activity/semantic.ts';
import { workspaceManagementSemanticDescriptor } from '../src/management/tool-adapter.ts';
import { WEB_TOOL_DESCRIPTORS, WEB_TOOL_NAMES } from '../src/web/tools.ts';
import { slackLoadingMessages, slackStatusText } from '../src/slack/replies.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  semanticDescriptorForManagedCapability,
  semanticDescriptorForManagedTool,
} from '../src/connections/catalog/index.ts';

test('semantic activity narrates Gmail from catalog facts without reading invocation input', () => {
  const descriptor = semanticDescriptorForManagedCapability('gmail.messages.search');
  assert.ok(descriptor);
  assert.deepEqual(semanticDescriptorForManagedTool('gmail_search_messages'), descriptor);
  assert.deepEqual(narrateSemanticActivity(descriptor, { phase: 'started' }), {
    kind: 'checking',
    action: 'Checking',
    object: 'Gmail',
    family: 'managed_connector',
    phase: 'working',
    text: 'Checking Gmail…',
  });
  assert.deepEqual(narrateSemanticActivity(descriptor, {
    phase: 'settled',
    outcome: 'succeeded',
  }), {
    kind: 'reading',
    action: 'Reviewing',
    object: 'Gmail messages',
    family: 'managed_connector',
    phase: 'reviewing',
    text: 'Reviewing Gmail messages…',
  });
});

test('every managed capability produces bounded deterministic start and review copy', () => {
  for (const connector of MANAGED_CONNECTOR_CATALOG.list()) {
    for (const capability of connector.capabilities) {
      const descriptor = semanticDescriptorForManagedCapability(capability.id);
      assert.ok(descriptor, capability.id);
      for (const event of [
        { phase: 'started' as const },
        { phase: 'settled' as const, outcome: 'succeeded' as const },
      ]) {
        const activity = narrateSemanticActivity(descriptor, event);
        assert.ok(activity, `${capability.id}:${event.phase}`);
        assert.ok(activity.text.length <= 50, `${capability.id}:${activity.text}`);
        assert.doesNotMatch(activity.text, /[<>&*_~`\r\n]/);
      }
    }
  }
});

test('the semantic copy matrix covers core roles and hides internal helpers', () => {
  assert.deepEqual(thinkingSemanticActivity(), {
    kind: 'preparing',
    action: 'Thinking',
    object: 'the request',
    family: 'unknown',
    phase: 'thinking',
    text: 'Thinking…',
  });
  assert.equal(isSafeTypedActivityStatus(thinkingSemanticActivity()), true);
  assert.deepEqual(
    activityStatus('preparing', 'Thinking', 'the request', 'unknown', 'thinking'),
    thinkingSemanticActivity(),
  );

  const answer = semanticDescriptorForCoreTool('stream_answer');
  assert.equal(answer.role, 'answer_generation');
  assert.deepEqual(narrateSemanticActivity(answer, { phase: 'started' }), {
    kind: 'writing',
    action: 'Drafting',
    object: 'the response',
    family: 'response',
    phase: 'drafting',
    text: 'Drafting the response…',
  });
  assert.equal(narrateSemanticActivity(answer, {
    phase: 'settled', outcome: 'failed',
  }), undefined);

  const hidden = semanticDescriptorForCoreTool('request_chickpea_handoff');
  assert.equal(hidden.role, 'internal_hidden');
  assert.equal(narrateSemanticActivity(hidden, { phase: 'started' }), undefined);

  const secret = 'sk-proj-credential-do-not-leak';
  const unknown = semanticDescriptorForCoreTool(secret);
  assert.deepEqual(narrateSemanticActivity(unknown, { phase: 'started' }), {
    kind: 'running',
    action: 'Working on',
    object: 'the request',
    family: 'unknown',
    phase: 'working',
    text: 'Working on the request…',
  });
  assert.doesNotMatch(
    narrateSemanticActivity(unknown, { phase: 'started' })?.text ?? '',
    new RegExp(secret),
  );
});

test('semantic descriptors never accept customer-authored names as copy inputs', () => {
  const secret = 'xoxb-customer-authored-name-do-not-leak';
  for (const family of [
    'custom_connection', 'skill', 'repository', 'agent_authoring',
  ] as const) {
    const descriptor = genericSemanticDescriptor(family);
    const serialized = JSON.stringify(descriptor);
    assert.doesNotMatch(serialized, new RegExp(secret));
    const activity = narrateSemanticActivity(descriptor, { phase: 'started' });
    assert.ok(activity);
    assert.doesNotMatch(activity.text, new RegExp(secret));
  }
  const forged = {
    ...genericSemanticDescriptor('skill'),
    label: { kind: 'managed_connector', id: 'customer', label: secret },
  };
  assert.doesNotMatch(
    narrateSemanticActivity(forged, { phase: 'started' })?.text ?? '',
    new RegExp(secret),
  );
});

test('semantic invocation facts reject extra or unsafe fields at the owner boundary', () => {
  const secret = 'xoxb-owner-payload-do-not-cross';
  const descriptor = {
    ...genericSemanticDescriptor('workspace'),
    operationBody: secret,
  };
  assert.throws(
    () => semanticInvocationFact('call_workspace_unsafe', descriptor as never),
    /descriptor is invalid/,
  );

  const gmail = MANAGED_CONNECTOR_CATALOG.connector('gmail');
  const search = MANAGED_CONNECTOR_CATALOG.capability('gmail.messages.search');
  assert.ok(gmail && search);
  const unsafeManaged = managedConnectorSemanticDescriptor({ ...gmail, label: secret }, search);
  assert.throws(
    () => semanticInvocationFact('call_gmail_unsafe', unsafeManaged),
    /descriptor is invalid/,
  );
});

test('unsafe managed labels and invalid descriptors degrade to fixed copy', () => {
  const gmail = MANAGED_CONNECTOR_CATALOG.connector('gmail');
  const search = MANAGED_CONNECTOR_CATALOG.capability('gmail.messages.search');
  assert.ok(gmail && search);
  for (const label of [
    'xoxb-12345678901234567890',
    'Gmail <@U123> *private*',
    `Gmail ${'x'.repeat(80)}`,
  ]) {
    const descriptor = managedConnectorSemanticDescriptor({ ...gmail, label }, search);
    assert.deepEqual(narrateSemanticActivity(descriptor, { phase: 'started' }), {
      kind: 'running',
      action: 'Working on',
      object: 'the request',
      family: 'unknown',
      phase: 'working',
      text: 'Working on the request…',
    });
  }
  assert.deepEqual(
    narrateSemanticActivity({ operation: 'prompt_injected' }, { phase: 'started' }),
    {
      kind: 'running',
      action: 'Working on',
      object: 'the request',
      family: 'unknown',
      phase: 'working',
      text: 'Working on the request…',
    },
  );
});

test('side-effecting semantic activity stays in-progress or neutral until final prose', () => {
  for (const capabilityId of ['gmail.drafts.create', 'gmail.messages.send']) {
    const descriptor = semanticDescriptorForManagedCapability(capabilityId);
    assert.ok(descriptor);
    const start = narrateSemanticActivity(descriptor, { phase: 'started' });
    const review = narrateSemanticActivity(descriptor, {
      phase: 'settled', outcome: 'succeeded',
    });
    assert.ok(start && review);
    assert.doesNotMatch(start.text, /created|sent|completed|succeeded/i);
    assert.match(review.text, /^Reviewing /);
    assert.doesNotMatch(review.text, /created|sent|completed|succeeded/i);
  }
  const descriptor = semanticDescriptorForManagedCapability('gmail.messages.send');
  assert.ok(descriptor);
  assert.deepEqual(narrateSemanticActivity(descriptor, {
    phase: 'settled', outcome: 'failed',
  }), {
    kind: 'preparing',
    action: 'Reassessing',
    object: 'the request',
    family: 'unknown',
    phase: 'reassessing',
    text: 'Reassessing the request…',
  });
});

test('activity facts carry safe action-and-object copy without exposing raw input', () => {
  const secret = 'xoxb-12345678901234567890';
  const activity = activityStatus('writing', 'Drafting', `initial skill ${secret}`);

  assert.deepEqual(activity, {
    kind: 'writing',
    action: 'Drafting',
    object: 'the current item',
    family: 'unknown',
    phase: 'drafting',
    text: 'Drafting the current item…',
  });
  assert.equal(activity.text.startsWith('Agent '), false);
  assert.doesNotMatch(activity.text, new RegExp(secret));
  assert.doesNotMatch(activity.text, /is thinking|gpt-|claude-|local-stub/i);
});

test('thinking observations do not replace the admitted user-facing activity', () => {
  registerActivityContext('thinking-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [],
  });
  assert.equal(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'thinking-thread',
      contentIndex: 0,
    }),
    undefined,
  );
  assert.equal(
    activityStatusForObservation({
      type: 'thinking_delta',
      instanceId: 'thinking-thread',
      delta: 'private model reasoning',
    }),
    undefined,
  );
});

test('admission activity is fixed thinking copy and ignores request content', () => {
  assert.deepEqual(
    initialActivityStatus(
      undefined,
      'Briefly explain how you would draft an initial skill for monitoring xoxb-secret.',
    ),
    thinkingSemanticActivity(),
  );
  assert.deepEqual(
    initialActivityStatus(undefined, 'Reply with exactly received.'),
    thinkingSemanticActivity(),
  );
  assert.deepEqual(
    initialActivityStatus(['Google Ads access requirements'], 'xoxb-secret'),
    thinkingSemanticActivity(),
  );
});

test('skill activation names only a skill registered for this agent instance', () => {
  registerActivityContext('skill-thread', {
    skills: [{ name: 'repo-inspector', displayName: 'Repository inspector' }],
    mcpConnections: [],
    apiConnections: [],
  });

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'skill-thread',
      toolName: 'activate_skill',
      toolCallId: 'call-1',
      args: { name: 'repo-inspector' },
    }),
    activityStatus('preparing', 'Loading', 'the Repository inspector skill'),
  );

  const secret = 'ghs_do-not-leak-this-token';
  const unknown = activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'skill-thread',
    toolName: 'activate_skill',
    toolCallId: 'call-2',
    args: { name: secret },
  });
  assert.deepEqual(unknown, activityStatus('preparing', 'Loading', 'a skill'));
  assert.doesNotMatch(unknown.text, new RegExp(secret));
});

test('MCP activity uses the configured display name and hides unknown tool identifiers', () => {
  registerActivityContext('mcp-thread', {
    skills: [],
    mcpConnections: [{ id: 'context7', displayName: 'Context7 Docs' }],
    apiConnections: [],
  });

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'mcp-thread',
      toolName: 'mcp__context7__resolve-library-id',
      toolCallId: 'call-1',
    }),
    activityStatus('checking', 'Checking', 'Context7 Docs'),
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'mcp-thread',
      toolName: 'mcp__secret-server__secret-tool',
      toolCallId: 'call-2',
    }),
    activityStatus('checking', 'Checking', 'a connection'),
  );
});

test('unknown tool names are never copied into status text', () => {
  registerActivityContext('unknown-tool-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [],
  });
  const secret = 'credential-do-not-leak';
  const status = activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'unknown-tool-thread',
    toolName: secret,
    toolCallId: 'unknown-call',
  });

  assert.deepEqual(status, activityStatus('running', 'Working with', 'a tool'));
  assert.doesNotMatch(status.text, new RegExp(secret));
});

test('semantic MCP activity uses a family grant without caching customer-authored names', () => {
  const secretName = 'mcp__xoxb-customer-secret__prompt_injected_tool';
  const context = buildSemanticActivityContext([], ['custom_connection']);
  assert.doesNotMatch(JSON.stringify(context), /xoxb-customer-secret/);
  registerActivityContext('semantic-mcp-thread', context);

  assert.deepEqual(activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'semantic-mcp-thread',
    toolName: secretName,
  }), {
    kind: 'checking',
    action: 'Checking',
    object: 'a connected service',
    family: 'custom_connection',
    phase: 'working',
    text: 'Checking a connected service…',
  });
});

function registerNamedContext(instanceId: string): void {
  registerActivityContext(instanceId, buildSemanticActivityContext([
    { toolName: 'activate_skill', descriptor: genericSemanticDescriptor('skill') },
    { toolName: 'connection_request', descriptor: genericSemanticDescriptor('custom_connection') },
  ], ['skill', 'custom_connection'], {
    skills: [
      { name: 'weekly-report' },
      { name: 'asana-api', displayName: 'Asana' },
      { name: 'a-skill-whose-name-is-far-too-long-for-status' },
      // Thirty characters fit "Using the … skill…" but not "Following the … skill…".
      { name: 'thirty', displayName: 'thirty character skill name ab' },
    ],
    mcpConnections: [
      { id: 'sql-dash', displayName: 'SQL Dash' },
      { id: 'mcp.crm', displayName: 'CRM' },
      { id: 'unsafe', displayName: 'Dangerous <@U123>' },
      { id: 'twin.a', displayName: 'Twin A' },
      { id: 'twin:a', displayName: 'Twin B' },
    ],
    apiConnections: [{
      id: 'zendesk',
      displayName: 'Zendesk',
      allowedHosts: ['acme.zendesk.com'],
      pathPrefixes: ['/api/v2'],
      allowedMethods: ['GET'],
    }],
  }));
}

function observeNamed(instanceId: string, event: Record<string, unknown>): string | undefined {
  return activityStatusForObservation({
    instanceId,
    submissionId: `${instanceId}-submission`,
    ...event,
  } as never)?.text;
}

test('a configured MCP connection is named from its configuration, not its tool name', () => {
  registerNamedContext('named-mcp');
  assert.equal(observeNamed('named-mcp', {
    type: 'tool_start', toolName: 'mcp__sql-dash__run_query', toolCallId: 'q1',
  }), 'Checking SQL Dash…');
  assert.equal(observeNamed('named-mcp', {
    type: 'tool', toolName: 'mcp__sql-dash__run_query', toolCallId: 'q1', isError: false,
  }), 'Reviewing SQL Dash results…');

  // Flue sanitizes the server id into the tool name; the lookup follows it.
  registerNamedContext('sanitized-mcp');
  assert.equal(observeNamed('sanitized-mcp', {
    type: 'tool_start', toolName: 'mcp__mcp_crm__search', toolCallId: 'q2',
  }), 'Checking CRM…');

  // An unsafe configured name keeps the family copy.
  registerNamedContext('unsafe-mcp');
  assert.equal(observeNamed('unsafe-mcp', {
    type: 'tool_start', toolName: 'mcp__unsafe__search', toolCallId: 'q4',
  }), 'Checking a connected service…');

  // Two ids that sanitize to one tool-name part name neither.
  registerNamedContext('twin-mcp');
  assert.equal(observeNamed('twin-mcp', {
    type: 'tool_start', toolName: 'mcp__twin_a__search', toolCallId: 'q5',
  }), 'Checking a connected service…');

  const secret = 'xoxb-server-do-not-leak';
  registerNamedContext('unnamed-mcp');
  const unknown = observeNamed('unnamed-mcp', {
    type: 'tool_start', toolName: `mcp__${secret}__search`, toolCallId: 'q3',
  });
  assert.equal(unknown, 'Checking a connected service…');
});

test('skill activation names only a configured skill', () => {
  registerNamedContext('named-skill');
  assert.equal(observeNamed('named-skill', {
    type: 'tool_start', toolName: 'activate_skill', toolCallId: 's1', args: { name: 'weekly-report' },
  }), 'Using the weekly report skill…');
  assert.equal(observeNamed('named-skill', {
    type: 'tool', toolName: 'activate_skill', toolCallId: 's1', isError: false,
  }), 'Following the weekly report skill…');

  registerNamedContext('built-in-skill');
  assert.equal(observeNamed('built-in-skill', {
    type: 'tool_start', toolName: 'activate_skill', toolCallId: 's4', args: { name: 'asana-api' },
  }), 'Using the Asana skill…');

  // A name that fits only the start copy stays generic in both phases.
  registerNamedContext('thirty-skill');
  assert.equal(observeNamed('thirty-skill', {
    type: 'tool_start', toolName: 'activate_skill', toolCallId: 's5', args: { name: 'thirty' },
  }), 'Using a skill…');
  assert.equal(observeNamed('thirty-skill', {
    type: 'tool', toolName: 'activate_skill', toolCallId: 's5', isError: false,
  }), 'Reviewing skill results…');

  registerNamedContext('invented-skill');
  const invented = observeNamed('invented-skill', {
    type: 'tool_start', toolName: 'activate_skill', toolCallId: 's2', args: { name: 'sk-proj-invented' },
  });
  assert.equal(invented, 'Using a skill…');

  registerNamedContext('long-skill');
  assert.equal(observeNamed('long-skill', {
    type: 'tool_start',
    toolName: 'activate_skill',
    toolCallId: 's3',
    args: { name: 'a-skill-whose-name-is-far-too-long-for-status' },
  }), 'Using a skill…');
});

test('a connection request is named by the configured API connection it matches', () => {
  registerNamedContext('named-api');
  assert.equal(observeNamed('named-api', {
    type: 'tool_start',
    toolName: 'connection_request',
    toolCallId: 'r1',
    args: { url: 'https://acme.zendesk.com/api/v2/tickets', method: 'GET' },
  }), 'Checking Zendesk…');
  assert.equal(observeNamed('named-api', {
    type: 'tool', toolName: 'connection_request', toolCallId: 'r1', isError: false,
  }), 'Reviewing Zendesk results…');

  registerNamedContext('unmatched-api');
  assert.equal(observeNamed('unmatched-api', {
    type: 'tool_start',
    toolName: 'connection_request',
    toolCallId: 'r2',
    args: { url: 'https://evil.example.com/Zendesk', method: 'GET' },
  }), 'Checking a connected service…');
});

test('configured labels are bound to their own family and trust tier', () => {
  const skill = configuredSemanticDescriptor('skill', 'weekly-report', 'weekly report');
  assert.equal(isSemanticActivityDescriptor(skill), true);
  assert.equal(isSemanticActivityDescriptor({
    ...skill, label: { ...skill.label!, kind: 'custom_connection' },
  }), false);
  assert.equal(isSemanticActivityDescriptor({ ...skill, trust: 'managed_catalog' }), false);
  assert.equal(isSemanticActivityDescriptor({
    ...genericSemanticDescriptor('repository'),
    label: { kind: 'skill', id: 'weekly-report', label: 'weekly report' },
  }), false);
  assert.equal(
    configuredSemanticDescriptor('custom_connection', 'crm', 'AKIAABCDEFGHIJKLMNOP').label,
    undefined,
  );
  assert.equal(configuredSemanticDescriptor('custom_connection', '../crm', 'CRM').label, undefined);
});

test('parallel calls review by name only when they share one connection', () => {
  registerNamedContext('batch-same');
  for (const id of ['b1', 'b2']) {
    observeNamed('batch-same', { type: 'tool_start', toolName: 'mcp__sql-dash__run_query', toolCallId: id });
  }
  observeNamed('batch-same', { type: 'tool', toolName: 'mcp__sql-dash__run_query', toolCallId: 'b1', isError: false });
  assert.equal(observeNamed('batch-same', {
    type: 'tool', toolName: 'mcp__sql-dash__run_query', toolCallId: 'b2', isError: false,
  }), 'Reviewing SQL Dash results…');

  registerNamedContext('batch-mixed');
  observeNamed('batch-mixed', { type: 'tool_start', toolName: 'mcp__sql-dash__run_query', toolCallId: 'm1' });
  observeNamed('batch-mixed', { type: 'tool_start', toolName: 'mcp__mcp_crm__search', toolCallId: 'm2' });
  observeNamed('batch-mixed', { type: 'tool', toolName: 'mcp__sql-dash__run_query', toolCallId: 'm1', isError: false });
  assert.equal(observeNamed('batch-mixed', {
    type: 'tool', toolName: 'mcp__mcp_crm__search', toolCallId: 'm2', isError: false,
  }), 'Reviewing the results…');
});

test('an invocation owner cannot invent a configured connection or skill name', () => {
  registerNamedContext('owner-named');
  const submissionId = 'owner-named-submission';
  activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'owner-named',
    submissionId,
    toolName: 'connection_request',
    toolCallId: 'owner-call',
  });
  for (const descriptor of [
    configuredSemanticDescriptor('custom_connection', 'payroll', 'Payroll'),
    configuredSemanticDescriptor('custom_connection', 'zendesk', 'Payroll'),
    configuredSemanticDescriptor('skill', 'weekly-report', 'Payroll'),
  ]) {
    assert.ok(descriptor.label);
    assert.equal(registerActivityInvocationFact(
      'owner-named', submissionId, semanticInvocationFact('owner-call', descriptor),
    ), undefined);
  }
  assert.equal(registerActivityInvocationFact(
    'owner-named',
    submissionId,
    semanticInvocationFact('owner-call', configuredSemanticDescriptor('custom_connection', 'zendesk', 'Zendesk')),
  )?.text, 'Checking Zendesk…');
});

test('the presentation declaration uses user-facing activity copy', () => {
  assert.deepEqual(
    toolActivityStatus('stream_answer'),
    activityStatus('writing', 'Drafting', 'the response'),
  );
});

test('image generation narrates a non-terminal creation step', () => {
  const status = toolActivityStatus('generate_image', {
    prompt: 'a poster that must never reach the status line',
  });
  assert.deepEqual(status, activityStatus('running', 'Creating', 'an image'));
  assert.equal(status.text, 'Creating an image…');
  // File delivery is terminal; image generation precedes staging.
  assert.notDeepEqual(status, toolActivityStatus('post_artifact'));
  assert.doesNotMatch(status.text, /poster/);
});

test('browser sign-in tools narrate fixed statuses without their arguments', () => {
  const signIn = toolActivityStatus('browser_sign_in', { loginId: 'wl_secret-login', passwordRef: 'e2' });
  assert.deepEqual(signIn, activityStatus('running', 'Signing in to', 'a website'));
  const handoff = toolActivityStatus('browser_handoff', { loginId: 'wl_secret-login', reason: 'needs a code' });
  assert.deepEqual(handoff, activityStatus('running', 'Handing off', 'a sign-in'));
  assert.doesNotMatch(`${signIn.text} ${handoff.text}`, /wl_secret|needs a code/);
});

test('sandbox primitives use fixed statuses without exposing their arguments', () => {
  const secret = 'credential-do-not-leak';
  const expected = new Map([
    ['read', activityStatus('reading', 'Reading', 'a workspace file')],
    ['write', activityStatus('writing', 'Writing', 'a workspace file')],
    ['edit', activityStatus('updating', 'Editing', 'a workspace file')],
    ['grep', activityStatus('checking', 'Searching', 'the workspace')],
    ['glob', activityStatus('checking', 'Finding', 'workspace files')],
    ['read_skill_resource', activityStatus('reading', 'Reading', 'a skill resource')],
  ]);

  for (const [toolName, expectedStatus] of expected) {
    const status = toolActivityStatus(toolName, { path: secret, pattern: secret });
    assert.deepEqual(status, expectedStatus, toolName);
    assert.doesNotMatch(status.text, new RegExp(secret));
  }
});

test('bash activity classifies parsed commands rather than quoted or searched text', () => {
  for (const command of [
    "printf '%s\\n' 'git push origin main'",
    'echo "pnpm install --frozen-lockfile"',
    `node -e "console.log('playwright screenshot.png')"`,
    "bash -c 'git commit -m quoted'",
    "git status \"$(printf 'git push')\"",
  ]) {
    assert.deepEqual(
      toolActivityStatus('bash', { command }),
      activityStatus('running', 'Running', 'a workspace command'),
      command,
    );
  }

  for (const command of [
    "rg -n 'git push|pnpm test|playwright' src",
    "grep -R 'curl https://app.asana.com/api/1.0/users/me' .",
  ]) {
    assert.deepEqual(
      toolActivityStatus('bash', { command }),
      activityStatus('checking', 'Inspecting', 'the workspace'),
      command,
    );
  }
});

test('sandbox app startup recognizes package-manager working-directory flags', () => {
  assert.deepEqual(
    toolActivityStatus('bash', {
      command:
        'cd /workspace/sample-app && pnpm -C apps/web dev > /workspace/dev-server.log 2>&1 & ' +
        'echo $! > /workspace/dev-server.pid',
    }),
    activityStatus('running', 'Starting', 'the app'),
  );

  for (const command of [
    'npm --prefix apps/web run dev',
    'yarn --cwd apps/web start',
    'bun --cwd=apps/web run dev',
    'pnpm --filter @sample/web dev',
    'pnpm -w dev',
    'pnpm --workspace-root dev',
    'pnpm -F @sample/web dev',
    'pnpm -r run dev',
  ]) {
    assert.deepEqual(
      toolActivityStatus('bash', { command }),
      activityStatus('running', 'Starting', 'the app'),
      command,
    );
  }

  assert.deepEqual(
    toolActivityStatus('bash', {
      command: 'pnpm -C apps/web install && pnpm -C apps/web dev',
    }),
    activityStatus('running', 'Installing', 'dependencies'),
    'the earlier higher-priority install stage must not be hidden by app startup',
  );
  assert.deepEqual(
    toolActivityStatus('bash', { command: 'pnpm -w build start' }),
    activityStatus('running', 'Running', 'a workspace command'),
    'a script argument named start must not be mistaken for the selected script',
  );
  assert.deepEqual(
    toolActivityStatus('bash', { command: 'pnpm -C apps/web test' }),
    activityStatus('running', 'Running', 'the test suite'),
  );
});

test('API curl activity is matched against approved host and path scope without leaking command text', () => {
  registerActivityContext('api-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [
      {
        displayName: 'Asana',
        allowedHosts: ['app.asana.com'],
        pathPrefixes: ['/api/1.0'],
        allowedMethods: ['GET'],
      },
    ],
  });

  const secret = 'Bearer do-not-leak-this-token';
  const matched = activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'api-thread',
    toolName: 'bash',
    toolCallId: 'call-1',
    args: {
      command:
        `curl -sS -H 'Authorization: ${secret}' ` +
        'https://app.asana.com/api/1.0/users/me',
    },
  });
  assert.deepEqual(matched, activityStatus('checking', 'Checking', 'Asana'));
  assert.doesNotMatch(matched.text, /do-not-leak/);

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'multiline-call',
      args: {
        command: [
          'set -e',
          'curl -sS \\',
          "  -H 'Accept: application/json' \\",
          '  "https://app.asana.com/api/1.0/workspaces"',
        ].join('\n'),
      },
    }),
    activityStatus('checking', 'Checking', 'Asana'),
  );

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'explicit-url-call',
      args: { command: 'curl -sS --url https://app.asana.com/api/1.0/users/me' },
    }),
    activityStatus('checking', 'Checking', 'Asana'),
  );

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'piped-call',
      args: {
        command: 'curl -sS https://app.asana.com/api/1.0/workspaces | head -c 200',
      },
    }),
    activityStatus('checking', 'Checking', 'Asana'),
  );

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'call-2',
      args: { command: 'curl -sS https://app.asana.com/api/1.00/users/me' },
    }),
    activityStatus('running', 'Running', 'a workspace command'),
    'path matching must use segment boundaries rather than raw prefix matching',
  );

  for (const command of [
    'printf "curl https://app.asana.com/api/1.0/users/me"',
    'curl -sS https://app.asana.com.evil.example/api/1.0/users/me',
    'curl -sS https://app.asana.com:444/api/1.0/users/me',
    "curl -sS -d 'https://app.asana.com/api/1.0/users/me' https://unconfigured.example/submit",
    "curl -sS -H 'Referer: https://app.asana.com/api/1.0/users/me' https://unconfigured.example/submit",
    `curl -sS --data '{"return_to":"https://app.asana.com/api/1.0/users/me"}' https://unconfigured.example/submit`,
    "curl 'https://app.asana.com/api/1.0]'",
    'printf x > curl https://app.asana.com/api/1.0/users/me',
    'curl https://app.asana.com/api/1.0/users/me https://unconfigured.example/collect',
  ]) {
    assert.deepEqual(
      activityStatusForObservation({
        type: 'tool_start',
        instanceId: 'api-thread',
        toolName: 'bash',
        toolCallId: 'negative-call',
        args: { command },
      }),
      activityStatus('running', 'Running', 'a workspace command'),
      command,
    );
  }

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'heredoc-call',
      args: {
        command: "cat <<'EOF'\ncurl https://app.asana.com/api/1.0/users/me\nEOF",
      },
    }),
    activityStatus('checking', 'Inspecting', 'the workspace'),
    'a URL in a heredoc body must not be attributed to the connection',
  );
});

test('API activity falls back when one curl command targets multiple configured connections', () => {
  registerActivityContext('multi-api-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [
      {
        displayName: 'Asana',
        allowedHosts: ['app.asana.com'],
        pathPrefixes: ['/api/1.0'],
        allowedMethods: ['GET'],
      },
      {
        displayName: 'Linear',
        allowedHosts: ['api.linear.app'],
        pathPrefixes: ['/graphql'],
        allowedMethods: ['GET'],
      },
    ],
  });

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'multi-api-thread',
      toolName: 'bash',
      toolCallId: 'multi-api-call',
      args: {
        command:
          'curl -sS https://app.asana.com/api/1.0/users/me ' +
          'https://api.linear.app/graphql',
      },
    }),
    activityStatus('running', 'Running', 'a workspace command'),
  );
});

test('API activity requires both the HTTP method and request guard to match', () => {
  registerActivityContext('guarded-api-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [
      {
        displayName: 'Guarded API',
        allowedHosts: ['api.example.com'],
        pathPrefixes: ['/v1/items'],
        allowedMethods: ['POST'],
        matchesRequest: (url) => new URL(url).searchParams.get('scope') === 'approved',
      },
    ],
  });

  const observe = (command: string) =>
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'guarded-api-thread',
      toolName: 'bash',
      toolCallId: 'guarded-api-call',
      args: { command },
    });

  assert.deepEqual(
    observe("curl -sS -d '{}' 'https://api.example.com/v1/items?scope=approved'"),
    activityStatus('checking', 'Checking', 'Guarded API'),
  );
  assert.deepEqual(
    observe("curl -sS 'https://api.example.com/v1/items?scope=approved'"),
    activityStatus('running', 'Running', 'a workspace command'),
    'the default GET method is outside the connection policy',
  );
  assert.deepEqual(
    observe("curl -sS -X POST 'https://api.example.com/v1/items?scope=blocked'"),
    activityStatus('running', 'Running', 'a workspace command'),
    'a request rejected by matchesRequest must not receive the connection name',
  );
});

test('re-registering an instance replaces stale skill and connection names', () => {
  registerActivityContext('reused-thread', {
    skills: [{ name: 'old-skill', displayName: 'Old skill' }],
    mcpConnections: [{ id: 'old-server', displayName: 'Old server' }],
    apiConnections: [],
  });
  registerActivityContext('reused-thread', {
    skills: [{ name: 'new-skill', displayName: 'New skill' }],
    mcpConnections: [],
    apiConnections: [],
  });

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'reused-thread',
      toolName: 'activate_skill',
      toolCallId: 'old-skill-call',
      args: { name: 'old-skill' },
    }),
    activityStatus('preparing', 'Loading', 'a skill'),
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'reused-thread',
      toolName: 'mcp__old-server__query',
      toolCallId: 'old-server-call',
    }),
    activityStatus('checking', 'Checking', 'a connection'),
  );
});

test('an unregistered instance produces no observable activity', () => {
  assert.equal(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'not-a-slack-agent',
    }),
    undefined,
  );
});

test('activity contexts are bounded and evict the oldest instance', () => {
  for (let index = 0; index <= 256; index += 1) {
    registerActivityContext(`bounded-thread-${index}`, {
      skills: [],
      mcpConnections: [],
      apiConnections: [],
    });
  }

  assert.equal(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'bounded-thread-0',
    }),
    undefined,
  );
  assert.equal(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'bounded-thread-256',
    }),
    undefined,
  );
});

test('configured activity labels are Slack-safe and bounded', () => {
  const status = connectingActivityStatus(
    '  Dangerous <@U123>\n*connection* ' + 'x'.repeat(100),
  );

  assert.equal(status.text, 'Connecting to a connected service…');
  assert.equal(connectingActivityStatus('Zendesk').text, 'Connecting to Zendesk…');
});

/** A synthetic Slack token shaped as a hostname label, assembled at runtime. */
const TOKEN_HOST = `${['xoxb', '0000000000', '000000000000'].join('-')}.example`;

function registerWebContext(instanceId: string): void {
  registerActivityContext(instanceId, buildSemanticActivityContext([
    ...WEB_TOOL_NAMES.map((toolName) => ({ toolName, descriptor: WEB_TOOL_DESCRIPTORS[toolName] })),
  ]));
}

function readStatus(instanceId: string, args: unknown, toolCallId = 'w1'): string | undefined {
  return observeNamed(instanceId, { type: 'tool_start', toolName: 'read_web_page', toolCallId, args });
}

test('a web read names the host it reads, and nothing else from its input', () => {
  registerWebContext('web-read');
  assert.equal(readStatus('web-read', { url: 'https://Docs.Statusboard.example/api/v2?key=secret#auth' }),
    'Reading docs.statusboard.example…');
  assert.equal(observeNamed('web-read', { type: 'tool', toolName: 'read_web_page', toolCallId: 'w1', isError: false }),
    'Reviewing the page…');

  registerWebContext('web-forms');
  assert.equal(readStatus('web-forms', { url: 'http://docs.statusboard.example/api' }, 'w2'),
    'Reading docs.statusboard.example…', 'Slack links a bare domain as http, which the read upgrades');
  assert.equal(readStatus('web-forms', { url: 'https://bücher.example/docs' }, 'w3'),
    'Reading xn--bcher-kva.example…', 'an international name shows as punycode');
  assert.equal(readStatus('web-forms', { url: 'https://a.very.deep.chain.of.mirrors.for.docs.statusboard.example/' }, 'w4'),
    'Reading of.mirrors.for.docs.statusboard.example…', 'a long host keeps the labels that fit');
});

test('a web host that fails validation keeps the generic web-read status', () => {
  const rejected: Array<[unknown, string]> = [
    [{}, 'no URL'],
    [{ url: 42 }, 'a URL that is not text'],
    [{ url: 'docs statusboard' }, 'not a URL'],
    [{ url: 'ftp://docs.statusboard.example/' }, 'not https'],
    [{ url: 'https://reader:hunter2@docs.statusboard.example/' }, 'embedded credentials'],
    [{ url: 'https://U123@docs.statusboard.example/' }, 'a user name, which is how a mention would ride along'],
    [{ url: 'https://localhost/docs' }, 'a local host'],
    [{ url: 'https://10.0.0.5/docs' }, 'a private address'],
    [{ url: 'https://metadata.internal/latest' }, 'an internal name'],
    [{ url: 'https://[2606:4700::1111]/' }, 'an IPv6 literal'],
    [{ url: 'https://docs.statusboard.example:8443/' }, 'a port the read refuses'],
    [{ url: 'https://<!channel>.example/' }, 'a broadcast'],
    [{ url: 'https://*bold*.example/' }, 'mrkdwn bold'],
    [{ url: 'https://under_score.example/' }, 'mrkdwn italic'],
    [{ url: 'https://strike~.example/' }, 'mrkdwn strike'],
    [{ url: `https://${TOKEN_HOST}/` }, 'a credential-shaped host'],
    [{ url: `https://${'a'.repeat(34)}.example/` }, 'two labels too long for the status'],
  ];
  for (const [index, [args, why]] of rejected.entries()) {
    registerWebContext(`web-generic-${index}`);
    assert.equal(readStatus(`web-generic-${index}`, args), 'Reading a web page…', why);
  }
});

test('a web status reaches Slack inside its limit, and a forged host never does', () => {
  const longest = `${'a'.repeat(33)}.example`;
  for (const [url, expected] of [
    ['https://docs.statusboard.example/api', 'Reading docs.statusboard.example…'],
    [`https://${longest}/`, `Reading ${longest}…`],
  ] as const) {
    const status = narrateSemanticActivity(webPageSemanticDescriptor(url), { phase: 'started' })!;
    assert.equal(slackStatusText(status), expected);
    assert.deepEqual(slackLoadingMessages(status), [expected]);
    assert.ok(expected.length <= 50, `${expected.length} characters`);
  }

  const web = genericSemanticDescriptor('web');
  for (const label of ['<!channel> *now*', 'docs.statusboard.example\n<@U123>', TOKEN_HOST, 'Docs.Statusboard.example']) {
    const forged = { ...web, label: { kind: 'web_host', id: label, label } };
    assert.equal(isSemanticActivityDescriptor(forged), false, label);
    const text = slackStatusText(narrateSemanticActivity(forged, { phase: 'started' })!);
    assert.equal(text, 'Working on the request…', label);
  }
  const host = webPageSemanticDescriptor('https://docs.statusboard.example/');
  assert.equal(isSemanticActivityDescriptor(host), true);
  assert.equal(isSemanticActivityDescriptor({ ...host, label: { ...host.label!, id: 'other.example' } }), false);
  assert.equal(isSemanticActivityDescriptor({ ...genericSemanticDescriptor('custom_connection'), label: host.label }), false,
    'a web host names only a web read or a connection try');
});

function registerTryContext(instanceId: string): void {
  registerActivityContext(instanceId, buildSemanticActivityContext(
    [{ toolName: 'try_connection', descriptor: workspaceManagementSemanticDescriptor('try_connection') }],
    [],
    { apiConnections: [{
      id: 'statusboard', displayName: 'Statusboard', allowedHosts: ['api.statusboard.example'],
      pathPrefixes: ['/v2'], allowedMethods: ['GET'],
    }] },
  ));
}

test('a connection try names the host it tests, from its draft or its named connection', () => {
  const tryStatus = (instanceId: string, args: unknown) => {
    registerTryContext(instanceId);
    return observeNamed(instanceId, { type: 'tool_start', toolName: 'try_connection', toolCallId: 't1', args });
  };
  assert.equal(tryStatus('try-draft', {
    draft: { allowedHosts: ['API.Statusboard.example', 'other.example'], pathPrefixes: ['/v2'], headerName: 'X-Api-Key' },
    key: 'sb_live_never_shown', path: '/v2/incidents',
  }), 'Testing api.statusboard.example…');
  assert.equal(tryStatus('try-saved', { connectionId: 'statusboard', path: '/v2/incidents' }), 'Testing api.statusboard.example…');
  assert.equal(observeNamed('try-saved', { type: 'tool', toolName: 'try_connection', toolCallId: 't1', isError: false }),
    'Checking the connection…');
  const draft = (host: unknown) => ({ draft: { allowedHosts: [host], pathPrefixes: [], headerName: 'X-Api-Key' }, path: '/' });
  for (const [index, [args, why]] of ([
    [{ connectionId: 'unknown', path: '/v2' }, 'a connection the Agent does not have'],
    [draft(TOKEN_HOST), 'a credential-shaped host'],
    [draft('<!channel>.example'), 'a broadcast'],
    [draft('evil.example/@api.statusboard.example'), 'a host that carries a path'],
    [draft('10.0.0.5'), 'a private address'],
    [draft(42), 'a host that is not text'],
  ] as const).entries()) {
    assert.equal(tryStatus(`try-generic-${index}`, args), 'Setting up a connection…', why);
  }
  const forged = { ...genericSemanticDescriptor('connection_setup'), label: { kind: 'web_host', id: TOKEN_HOST, label: TOKEN_HOST } };
  assert.equal(isSemanticActivityDescriptor(forged), false, 'a forged host never crosses the activity wire');
});

function searchStatus(instanceId: string, args: unknown, toolCallId = 's1'): string | undefined {
  registerWebContext(instanceId);
  return observeNamed(instanceId, { type: 'tool_start', toolName: 'web_search', toolCallId, args });
}

/** The word joiner neutralizeSlackBroadcastMentions puts after an inert `@`. */
const JOIN = '\u2060';

test('a web search quotes its query, then reviews the results', () => {
  assert.equal(searchStatus('web-search', { query: 'statusboard api auth header' }), 'Searching: “statusboard api auth header”…');
  assert.equal(observeNamed('web-search', { type: 'tool', toolName: 'web_search', toolCallId: 's1', isError: false }),
    'Reviewing the results…');
  assert.equal(searchStatus('web-search-spaces', { query: '  what   changed\nin\tPostgres 18  ' }),
    'Searching: “what changed in Postgres 18”…', 'whitespace and control characters collapse');
  assert.equal(searchStatus('web-search-mrkdwn', { query: '*bold* _quiet_ ~gone~ `code` <https://x.example|link>' }),
    'Searching: “bold quiet gone code https://x.exam…”…', 'mrkdwn is stripped');
});

test('a search query shows its mentions and broadcasts inert', () => {
  assert.equal(searchStatus('web-search-broadcast', { query: '<!channel> outage' }), `Searching: “@${JOIN}channel outage”…`);
  assert.equal(searchStatus('web-search-plain', { query: '@here outage' }), `Searching: “@${JOIN}here outage”…`);
  assert.equal(searchStatus('web-search-user', { query: '<@U0123ABCD> profile' }), `Searching: “@${JOIN}U0123ABCD profile”…`);
  assert.equal(searchStatus('web-search-group', { query: '<!subteam^S0123|@ops> pager' }), `Searching: “@${JOIN}ops pager”…`);
});

test('a long search query is shortened with an ellipsis to fit the 50-character status', () => {
  const text = searchStatus('web-search-long', { query: 'how do I paginate the Statusboard incidents endpoint with cursors' })!;
  assert.equal(text, 'Searching: “how do I paginate the Statusboard i…”…');
  assert.ok(text.length <= 50, `${text.length} characters`);
  assert.equal(searchStatus('web-search-emoji-cut', { query: `${'x'.repeat(34)}😀 and more` }),
    `Searching: “${'x'.repeat(34)}…”…`, 'a cut through an emoji leaves no half of it behind');
  const status = narrateSemanticActivity(webSearchSemanticDescriptor('x'.repeat(400)), { phase: 'started' })!;
  assert.ok(isSafeTypedActivityStatus(status));
  assert.deepEqual(slackLoadingMessages(status), [slackStatusText(status)]);
  assert.ok(slackStatusText(status).length <= 50);
});

test('a search query that fails validation shows the generic search status', () => {
  const token = ['xoxb', '0000000000', '000000000000'].join('-');
  const rejected: Array<[unknown, string]> = [
    [{}, 'no query'],
    [{ query: 42 }, 'a query that is not text'],
    [{ query: '   ' }, 'only whitespace'],
    [{ query: '*_~`' }, 'only mrkdwn'],
    [{ query: `why does ${token} fail` }, 'a credential'],
    [{ query: `why does the Statusboard api say ${token} fails` }, 'a credential the shortened status would cut'],
    [{ query: 'mail ops@example.com' }, 'an @ that is not a mention the neutralizer marks'],
  ];
  for (const [index, [args, why]] of rejected.entries()) {
    assert.equal(searchStatus(`web-search-generic-${index}`, args), 'Searching the web…', why);
  }
});

test('a forged query label never reaches Slack', () => {
  const generic = webSearchSemanticDescriptor();
  for (const label of ['<!channel> now', '@here now', 'line\nbreak', '*bold*', 'x'.repeat(37), '“quoted”']) {
    const forged = { ...generic, label: { kind: 'web_query', id: label, label } };
    assert.equal(isSemanticActivityDescriptor(forged), false, label);
    assert.equal(slackStatusText(narrateSemanticActivity(forged, { phase: 'started' })!), 'Working on the request…', label);
  }
  const query = webSearchSemanticDescriptor('statusboard');
  assert.equal(isSemanticActivityDescriptor(query), true);
  assert.equal(isSemanticActivityDescriptor({ ...genericSemanticDescriptor('web'), label: query.label }), true,
    'a query label passes its own check on any web descriptor');
  assert.equal(isSemanticActivityDescriptor({ ...genericSemanticDescriptor('skill'), label: query.label }), false,
    'a query names only a web call');
});
