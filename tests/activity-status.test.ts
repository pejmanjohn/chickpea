import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityStatusForObservation,
  connectingActivityStatus,
  registerActivityContext,
  toolActivityStatus,
} from '../src/activity/status.ts';

test('thinking activity is visible without exposing model reasoning content', () => {
  registerActivityContext('thinking-thread', {
    skills: [],
    mcpConnections: [],
    apiConnections: [],
  });
  assert.deepEqual(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'thinking-thread',
      contentIndex: 0,
    }),
    { text: 'is thinking through the request' },
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
    { text: 'is loading the Repository inspector skill' },
  );

  const secret = 'ghs_do-not-leak-this-token';
  const unknown = activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'skill-thread',
    toolName: 'activate_skill',
    toolCallId: 'call-2',
    args: { name: secret },
  });
  assert.deepEqual(unknown, { text: 'is loading a skill' });
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
    { text: 'is using Context7 Docs' },
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'mcp-thread',
      toolName: 'mcp__secret-server__secret-tool',
      toolCallId: 'call-2',
    }),
    { text: 'is using a connection' },
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

  assert.deepEqual(status, { text: 'is using a tool' });
  assert.doesNotMatch(status.text, new RegExp(secret));
});

test('the presentation declaration uses user-facing activity copy', () => {
  assert.deepEqual(
    toolActivityStatus('stream_answer'),
    { text: 'is preparing the response' },
  );
});

test('sandbox primitives use fixed statuses without exposing their arguments', () => {
  const secret = 'credential-do-not-leak';
  const expected = new Map([
    ['read', 'is reading a workspace file'],
    ['write', 'is writing a workspace file'],
    ['edit', 'is editing a workspace file'],
    ['grep', 'is searching the workspace'],
    ['glob', 'is finding workspace files'],
    ['read_skill_resource', 'is reading a skill resource'],
  ]);

  for (const [toolName, text] of expected) {
    const status = toolActivityStatus(toolName, { path: secret, pattern: secret });
    assert.deepEqual(status, { text }, toolName);
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
      { text: 'is running a workspace command' },
      command,
    );
  }

  for (const command of [
    "rg -n 'git push|pnpm test|playwright' src",
    "grep -R 'curl https://app.asana.com/api/1.0/users/me' .",
  ]) {
    assert.deepEqual(
      toolActivityStatus('bash', { command }),
      { text: 'is inspecting the workspace' },
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
    { text: 'is starting the app' },
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
      { text: 'is starting the app' },
      command,
    );
  }

  assert.deepEqual(
    toolActivityStatus('bash', {
      command: 'pnpm -C apps/web install && pnpm -C apps/web dev',
    }),
    { text: 'is installing dependencies' },
    'the earlier higher-priority install stage must not be hidden by app startup',
  );
  assert.deepEqual(
    toolActivityStatus('bash', { command: 'pnpm -w build start' }),
    { text: 'is running a workspace command' },
    'a script argument named start must not be mistaken for the selected script',
  );
  assert.deepEqual(
    toolActivityStatus('bash', { command: 'pnpm -C apps/web test' }),
    { text: 'is running the test suite' },
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
  assert.deepEqual(matched, { text: 'is using Asana' });
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
    { text: 'is using Asana' },
  );

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'explicit-url-call',
      args: { command: 'curl -sS --url https://app.asana.com/api/1.0/users/me' },
    }),
    { text: 'is using Asana' },
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
    { text: 'is using Asana' },
  );

  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'api-thread',
      toolName: 'bash',
      toolCallId: 'call-2',
      args: { command: 'curl -sS https://app.asana.com/api/1.00/users/me' },
    }),
    { text: 'is running a workspace command' },
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
      { text: 'is running a workspace command' },
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
    { text: 'is inspecting the workspace' },
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
    { text: 'is running a workspace command' },
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
    { text: 'is using Guarded API' },
  );
  assert.deepEqual(
    observe("curl -sS 'https://api.example.com/v1/items?scope=approved'"),
    { text: 'is running a workspace command' },
    'the default GET method is outside the connection policy',
  );
  assert.deepEqual(
    observe("curl -sS -X POST 'https://api.example.com/v1/items?scope=blocked'"),
    { text: 'is running a workspace command' },
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
    { text: 'is loading a skill' },
  );
  assert.deepEqual(
    activityStatusForObservation({
      type: 'tool_start',
      instanceId: 'reused-thread',
      toolName: 'mcp__old-server__query',
      toolCallId: 'old-server-call',
    }),
    { text: 'is using a connection' },
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
  assert.deepEqual(
    activityStatusForObservation({
      type: 'thinking_start',
      instanceId: 'bounded-thread-256',
    }),
    { text: 'is thinking through the request' },
  );
});

test('configured activity labels are Slack-safe and bounded', () => {
  const status = connectingActivityStatus(
    '  Dangerous <@U123>\n*connection* ' + 'x'.repeat(100),
  );

  assert.doesNotMatch(status.text, /[<>\n]/);
  assert.ok(status.text.length <= 50, `expected <= 50 chars, got ${status.text.length}`);
});
