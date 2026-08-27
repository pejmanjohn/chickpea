import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityStatus,
  activityStatusForObservation,
  connectingActivityStatus,
  initialActivityStatus,
  isSafeTypedActivityStatus,
  registerActivityContext,
  toolActivityStatus,
} from '../src/activity/status.ts';
import {
  genericSemanticDescriptor,
  managedConnectorSemanticDescriptor,
  narrateSemanticActivity,
  semanticDescriptorForCoreTool,
  semanticInvocationFact,
  thinkingSemanticActivity,
} from '../src/activity/semantic.ts';
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
    text: 'Checking Gmail…',
  });
  assert.deepEqual(narrateSemanticActivity(descriptor, {
    phase: 'settled',
    outcome: 'succeeded',
  }), {
    kind: 'reading',
    action: 'Reviewing',
    object: 'Gmail messages',
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
    text: 'Thinking…',
  });
  assert.equal(isSafeTypedActivityStatus(thinkingSemanticActivity()), true);

  const answer = semanticDescriptorForCoreTool('stream_answer');
  assert.equal(answer.role, 'answer_generation');
  assert.deepEqual(narrateSemanticActivity(answer, { phase: 'started' }), {
    kind: 'writing',
    action: 'Drafting',
    object: 'the response',
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
      text: 'Working on the request…',
    });
  }
  assert.deepEqual(
    narrateSemanticActivity({ operation: 'prompt_injected' }, { phase: 'started' }),
    {
      kind: 'running',
      action: 'Working on',
      object: 'the request',
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

test('admission activity uses allowlisted request objects without echoing user text', () => {
  assert.deepEqual(
    initialActivityStatus(
      undefined,
      'Briefly explain how you would draft an initial skill for monitoring xoxb-secret.',
    ),
    activityStatus('writing', 'Drafting', 'the initial skill'),
  );
  assert.deepEqual(
    initialActivityStatus(undefined, 'Reply with exactly received.'),
    activityStatus('writing', 'Drafting', 'the response'),
  );
  assert.deepEqual(
    initialActivityStatus(['Google Ads access requirements'], 'xoxb-secret'),
    activityStatus('writing', 'Drafting', 'Google Ads access requirements'),
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

test('the presentation declaration uses user-facing activity copy', () => {
  assert.deepEqual(
    toolActivityStatus('stream_answer'),
    activityStatus('writing', 'Drafting', 'the response'),
  );
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

  assert.doesNotMatch(status.text, /[<>\n]/);
  assert.ok(status.text.length <= 50, `expected <= 50 chars, got ${status.text.length}`);
});
