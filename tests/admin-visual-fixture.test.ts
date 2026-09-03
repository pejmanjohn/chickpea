import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderAdminPage } from '../src/admin/page.ts';
import {
  ONBOARDING_JOURNEY_KEY,
  readOnboardingJourney,
} from '../src/config/onboarding-state.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { PROVIDER_KEY_SETTING_KEYS } from '../src/config/provider-keys.ts';

interface VisualFixture {
  address: string;
  adminToken: string;
  authStates: Record<string, { path: string }>;
  baseUrl: string;
  canonicalStates: Record<string, { path: string; actions: readonly string[] }>;
  onboardingStage: 'choose_provider' | 'choose_model' | 'try' | null;
  runtimeContract: 'legacy' | 'chickpea-v1';
  stateDbPath: string;
  stateDirectory: string;
  close(): Promise<void>;
}

interface VisualFixtureModule {
  startAdminVisualFixture(options?: {
    host?: string;
    port?: number;
    runtimeContract?: 'legacy' | 'chickpea-v1';
    onboardingStage?: 'choose_provider' | 'choose_model' | 'try';
    principalRole?: 'owner' | 'admin' | 'member';
  }): Promise<VisualFixture>;
}

interface ChannelProjection {
  grants: Array<{ agentId: string }>;
  channelId: string;
  readiness: { code: string };
  source: string;
}

interface AgentProjection {
  id: string;
  capabilityPreviews: {
    skills: Array<{ name: string }>;
    connectors: Array<{ name: string }>;
    repositories: Array<{ name: string }>;
  };
}

interface SlackFixtureResponse {
  ok: boolean;
  error?: string;
  channel?: {
    id: string;
    is_private: boolean;
    is_member: boolean;
    is_archived: boolean;
  };
}

async function loadFixtureModule(): Promise<VisualFixtureModule> {
  // The executable stays plain Node ESM so `npm run admin:visual-fixture` does
  // not need a second build or browser dependency. Its TypeScript imports are
  // loaded through the same tsx seam as the existing offline harnesses.
  // @ts-expect-error The local executable intentionally has no declaration file.
  return import('../scripts/serve-admin-visual-fixture.mjs') as Promise<VisualFixtureModule>;
}

async function fixtureJson<T>(fixture: VisualFixture, path: string): Promise<T> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${fixture.adminToken}` },
  });
  assert.equal(response.status, 200, path);
  return response.json() as Promise<T>;
}

async function fixtureMutation(
  fixture: VisualFixture,
  path: string,
  body: Record<string, unknown>,
  method = 'POST',
): Promise<Response> {
  return fetch(`${fixture.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${fixture.adminToken}`,
      origin: fixture.baseUrl,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function waitForFixtureStatePath(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`visual fixture did not start:\n${output}`));
    }, 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
      callback();
    };
    const onData = (chunk: unknown) => {
      output += String(chunk);
      const statePath = output.match(/Temporary state: (.+)\r?\n/)?.[1];
      if (statePath) finish(() => resolve(statePath));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `visual fixture exited before startup (code ${String(code)}, signal ${String(signal)}):\n${output}`,
      )));
    };
    child.stdout?.on('data', onData);
    child.once('exit', onExit);
  });
}

test('visual fixture seeds the real Agent, Channel, readiness, capability, and memory projections', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture();
  try {
    const agents = await fixtureJson<{ agents: AgentProjection[] }>(fixture, '/admin/api/agents');
    assert.deepEqual(
      agents.agents.map((agent) => agent.id),
      ['agent_customer', 'agent_release', 'agent_research'],
    );
    const research = agents.agents.find((agent) => agent.id === 'agent_research');
    assert.ok(research);
    assert.equal(research.capabilityPreviews.skills[0]?.name, 'research-brief');
    assert.equal(research.capabilityPreviews.connectors[0]?.name, 'Linear');
    assert.equal(research.capabilityPreviews.repositories[0]?.name, 'acme/research');

    const releaseConnections = await fixtureJson<{
      attached: Array<{ account: { label: string; lifecycle: string; ownerKind: string } }>;
    }>(fixture, '/admin/api/agents/agent_release/connections?workspaceId=TVISUAL');
    assert.equal(releaseConnections.attached.length, 1);
    assert.equal(releaseConnections.attached[0]?.account.label, 'Gmail · Team');
    assert.equal(releaseConnections.attached[0]?.account.lifecycle, 'needs_attention');
    assert.equal(releaseConnections.attached[0]?.account.ownerKind, 'team');

    const releaseSchedules = await fixtureJson<{
      schedules: Array<{ name: string; status: string; channelLabel: string }>;
    }>(fixture, '/admin/api/agents/agent_release/schedules');
    assert.deepEqual(
      releaseSchedules.schedules.map((schedule) => [schedule.name, schedule.status]),
      [
        ['Daily launch readiness digest with a long scannable name', 'active'],
        ['Dependency follow-up', 'needs_attention'],
        ['Weekly customer summary', 'paused'],
      ],
    );
    assert.ok(releaseSchedules.schedules.every((schedule) => schedule.channelLabel === 'release-room'));

    const channels = await fixtureJson<{ channels: ChannelProjection[] }>(
      fixture,
      '/admin/api/channels',
    );
    const byId = new Map<string, ChannelProjection>(
      channels.channels.map((channel: ChannelProjection) => [channel.channelId, channel]),
    );
    assert.equal(byId.get('C_RELEASES')?.source, 'granted_and_discovered');
    assert.equal(byId.get('C_RELEASES')?.readiness.code, 'ready');
    assert.equal(byId.get('C_SUPPORT')?.readiness.code, 'membership_required');
    assert.deepEqual(byId.get('C_UNASSIGNED')?.grants, []);
    assert.equal(byId.get('C_UNASSIGNED')?.readiness.code, 'no_agents');
    assert.equal(byId.get('C_DISCOVERED')?.source, 'discovered');

    const memory = await fixtureJson<{
      memory: { agentId: string; body: string; revision: number };
    }>(
      fixture,
      '/admin/api/agents/agent_research/memory',
    );
    assert.equal(memory.memory.agentId, 'agent_research');
    assert.equal(memory.memory.revision, 1);
    assert.match(memory.memory.body, /Prefer short evidence summaries/);
    assert.match(memory.memory.body, /Separate verified fact, inference, and unresolved questions/);
  } finally {
    await fixture.close();
  }
});

test('visual fixture fake Slack fails closed and returns requested records', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture();
  const callSlack = async (
    method: string,
    token: string | null,
    body: Record<string, string> = {},
  ): Promise<SlackFixtureResponse> => {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${fixture.baseUrl}/__admin_visual_fixture/slack/${method}`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(body),
    });
    assert.equal(response.status, 200, method);
    return response.json() as Promise<SlackFixtureResponse>;
  };

  try {
    assert.deepEqual(await callSlack('auth.test', null), { ok: false, error: 'invalid_auth' });
    assert.deepEqual(await callSlack('auth.test', 'xoxb-wrong'), { ok: false, error: 'invalid_auth' });
    assert.deepEqual(
      await callSlack('users.info', 'xoxb-local-admin-visual-fixture', { user: 'U_WRONG' }),
      { ok: false, error: 'user_not_found' },
    );
    const channel = await callSlack(
      'conversations.info',
      'xoxb-local-admin-visual-fixture',
      { channel: 'C_SUPPORT' },
    );
    assert.equal(channel.channel?.id, 'C_SUPPORT');
    assert.equal(channel.channel?.is_private, false);
    assert.equal(channel.channel?.is_member, false);
    assert.equal(channel.channel?.is_archived, false);
    assert.deepEqual(
      await callSlack(
        'conversations.info',
        'xoxb-local-admin-visual-fixture',
        { channel: 'C_MISSING' },
      ),
      { ok: false, error: 'channel_not_found' },
    );
  } finally {
    await fixture.close();
  }
});

test('canonical visual states use authenticated production URLs and UI actions only', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture();
  try {
    const unauthenticated = await fetch(`${fixture.baseUrl}/admin/agents/agent_research`, {
      redirect: 'manual',
    });
    assert.equal(unauthenticated.status, 303);
    assert.equal(
      unauthenticated.headers.get('location'),
      '/auth/slack/sign-in?destination=%2Fadmin%2Fagents%2Fagent_research',
    );
    const authorization = `Bearer ${fixture.adminToken}`;

    assert.deepEqual(fixture.canonicalStates, {
      settingsProviders: { path: '/admin/settings/providers', actions: [] },
      agentInstructions: { path: '/admin/agents/agent_research', actions: [] },
      agentBlankDescription: { path: '/admin/agents/agent_customer', actions: [] },
      agentMemory: { path: '/admin/agents/agent_research', actions: ['Memory'] },
      agentSchedules: { path: '/admin/agents/agent_release', actions: ['Schedules'] },
      channelsIndex: { path: '/admin/channels', actions: [] },
      channelDetail: { path: '/admin/channels/TVISUAL/C_RELEASES', actions: [] },
      channelAdvanced: {
        path: '/admin/channels/TVISUAL/C_RELEASES',
        actions: ['Advanced'],
      },
      team: { path: '/admin/team', actions: [] },
    });

    for (const state of Object.values(fixture.canonicalStates)) {
      assert.equal(new URL(state.path, fixture.baseUrl).search, '');
      const page = await fetch(`${fixture.baseUrl}${state.path}`, {
        headers: { authorization },
      });
      assert.equal(page.status, 200, state.path);
      const html = await page.text();
      assert.match(html, /<title>Chickpea · \/admin<\/title>/);
      assert.match(html, /api\("\/admin\/api\/agents"\)/);
      assert.doesNotMatch(html, /data-action="fixture-|visualFixture|fixtureState/);
    }
  } finally {
    await fixture.close();
  }
});

test('visual fixture repeats pending and live Workspace-default contracts without exposing Chickpea', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  for (const runtimeContract of ['legacy', 'chickpea-v1'] as const) {
    const fixture = await startAdminVisualFixture({ runtimeContract });
    try {
      assert.equal(fixture.runtimeContract, runtimeContract);
      const workspaceDefault = await fixtureJson<{
        workspaceDefault: {
          runtimeContract: string;
          live: boolean;
          modelId: string;
          inheritingAgentCount: number;
          health: { status: string };
        };
      }>(fixture, '/admin/api/workspace-model-default');
      assert.deepEqual(workspaceDefault.workspaceDefault, {
        runtimeContract,
        live: runtimeContract === 'chickpea-v1',
        modelId: 'local-stub/visual-review',
        inheritingAgentCount: 1,
        health: { status: 'ready', providerId: 'local-stub' },
        provenance: 'installation_bootstrap',
        revision: 1,
        workspaceId: 'TVISUAL',
      });

      const agents = await fixtureJson<{ agents: AgentProjection[] }>(fixture, '/admin/api/agents');
      assert.deepEqual(
        agents.agents.map(({ id }) => id),
        ['agent_customer', 'agent_release', 'agent_research'],
      );
    } finally {
      await fixture.close();
    }
  }
});

test('Slack auth visual states render the production Slack-only journey without secrets', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture();
  try {
    assert.deepEqual(Object.keys(fixture.authStates), [
      'signIn', 'setupCreate', 'setupConnected', 'setupApproval', 'setupOwner',
      'accessDenied', 'ownerComplete', 'recovery',
    ]);
    for (const [name, state] of Object.entries(fixture.authStates)) {
      const response = await fetch(`${fixture.baseUrl}${state.path}`);
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      assert.match(html, /data-slack-auth-surface=/, name);
      assert.match(html, /<main[^>]*aria-labelledby="auth-title"/, name);
      if (name === 'signIn') {
        assert.match(html, />Welcome back<\/h1>/, name);
        assert.match(html, /slack-provider-logo slack-logo-image/, name);
        assert.doesNotMatch(html, /role="status"|Full Slack members|Slack Connect participants/, name);
      } else if (name === 'setupCreate' || name === 'setupConnected' || name === 'setupOwner') {
        assert.match(html, /slack-provider-button/, name);
        assert.match(html, /slack-provider-logo slack-logo-image/, name);
        if (name === 'setupOwner') assert.match(html, /role="status" aria-live="polite"/, name);
        else assert.doesNotMatch(html, /role="status" aria-live="polite"/, name);
      } else if (name === 'ownerComplete') {
        assert.doesNotMatch(html, /role="status" aria-live="polite"/, name);
      } else {
        assert.match(html, /role="status" aria-live="polite"/, name);
      }
      assert.doesNotMatch(
        html,
        /xox(?:b|p|e)-[A-Za-z0-9-]{8,}|route-client-secret|route-signing-secret|visual-setup-capability/,
        name,
      );
      assert.doesNotMatch(html, /fonts\.googleapis|Forgot Password|Sign up|Cloudflare Access/i, name);
    }
  } finally {
    await fixture.close();
  }
});

test('visual fixture renders every durable onboarding stage through the production URL', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const stages = ['choose_provider', 'choose_model', 'try'] as const;
  for (const onboardingStage of stages) {
    const fixture = await startAdminVisualFixture({
      onboardingStage,
    });
    try {
      assert.equal(fixture.onboardingStage, onboardingStage);
      const login = await fetch(
        `${fixture.baseUrl}/__admin_visual_fixture/login?token=${encodeURIComponent(fixture.adminToken)}&destination=/admin/onboarding`,
        { redirect: 'manual' },
      );
      const cookie = login.headers.get('set-cookie');
      assert.ok(cookie);
      const page = await fetch(`${fixture.baseUrl}/admin/onboarding`, {
        headers: { cookie },
      });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /app\.className = "frame onboarding-frame"/);
      const state = await fetch(`${fixture.baseUrl}/admin/api/onboarding`, {
        headers: { cookie },
      });
      assert.equal(state.status, 200);
      assert.equal((await state.json() as { stage: string }).stage, onboardingStage);
    } finally {
      await fixture.close();
    }
  }
});

test('onboarding production routes reject stale, unavailable, invalid, and conflicting choices', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();

  const staleFixture = await startAdminVisualFixture({ onboardingStage: 'choose_provider' });
  try {
    const stale = await fixtureMutation(staleFixture, '/admin/api/onboarding/provider', {
      expectedRevision: '{"version":0}',
      providerId: 'cloudflare',
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as { error: string }).error, 'onboarding_changed');
  } finally {
    await staleFixture.close();
  }

  const providerFixture = await startAdminVisualFixture({ onboardingStage: 'choose_provider' });
  try {
    const onboarding = await fixtureJson<{ revision: string }>(providerFixture, '/admin/api/onboarding');
    const unavailable = await fixtureMutation(providerFixture, '/admin/api/onboarding/provider', {
      expectedRevision: onboarding.revision,
      providerId: 'openai',
    });
    assert.equal(unavailable.status, 409);
    assert.equal(
      (await unavailable.json() as { error: string }).error,
      'onboarding_provider_not_configured',
    );
  } finally {
    await providerFixture.close();
  }

  const modelFixture = await startAdminVisualFixture({ onboardingStage: 'choose_model' });
  try {
    const onboarding = await fixtureJson<{ revision: string }>(modelFixture, '/admin/api/onboarding');
    const workspace = await fixtureJson<{
      workspaceDefault: { revision: number };
    }>(modelFixture, '/admin/api/workspace-model-default');

    const invalid = await fixtureMutation(modelFixture, '/admin/api/onboarding/try', {
      expectedRevision: onboarding.revision,
      modelId: 'anthropic/not-in-the-catalog',
      expectedDefaultRevision: workspace.workspaceDefault.revision,
    });
    assert.equal(invalid.status, 400);

    const conflict = await fixtureMutation(modelFixture, '/admin/api/onboarding/try', {
      expectedRevision: onboarding.revision,
      modelId: 'anthropic/claude-sonnet-5',
      expectedDefaultRevision: workspace.workspaceDefault.revision + 1,
    });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as {
      error: string;
      workspaceDefault?: { revision: number };
    };
    assert.equal(conflictBody.error, 'workspace_model_default_revision_conflict');
    assert.equal(conflictBody.workspaceDefault?.revision, workspace.workspaceDefault.revision);
  } finally {
    await modelFixture.close();
  }
});

test('onboarding production routes keep setup mutations owner- or admin-only', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture({
    onboardingStage: 'choose_model',
    principalRole: 'member',
  });
  try {
    const revision = '{"version":0,"state":"active"}';
    const attempts = [
      fixtureMutation(fixture, '/admin/api/onboarding/provider', {
        expectedRevision: revision,
        providerId: 'anthropic',
      }),
      fixtureMutation(fixture, '/admin/api/onboarding/try', {
        expectedRevision: revision,
        modelId: 'anthropic/claude-sonnet-5',
        expectedDefaultRevision: 0,
      }),
      fixtureMutation(fixture, '/admin/api/onboarding/complete', {
        expectedRevision: revision,
      }),
    ];
    for (const response of await Promise.all(attempts)) {
      assert.equal(response.status, 403);
      assert.equal((await response.json() as { error: string }).error, 'forbidden');
    }
  } finally {
    await fixture.close();
  }
});

test('onboarding accepts a matching workspace-model conflict and advances to Try', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture({ onboardingStage: 'choose_model' });
  try {
    const onboarding = await fixtureJson<{ revision: string }>(fixture, '/admin/api/onboarding');
    const workspace = await fixtureJson<{
      workspaceDefault: { revision: number };
    }>(fixture, '/admin/api/workspace-model-default');
    const modelId = 'anthropic/claude-sonnet-5';
    const saved = await fixtureMutation(fixture, '/admin/api/workspace-model-default', {
      modelId,
      expectedRevision: workspace.workspaceDefault.revision,
    }, 'PUT');
    assert.equal(saved.status, 200, await saved.clone().text());

    const started = await fixtureMutation(fixture, '/admin/api/onboarding/try', {
      expectedRevision: onboarding.revision,
      modelId,
      expectedDefaultRevision: workspace.workspaceDefault.revision,
    });
    assert.equal(started.status, 200, await started.clone().text());
    const body = await started.json() as {
      stage: string;
      modelId: string;
      agentId: string;
      slackAppId: string;
    };
    assert.equal(body.stage, 'try');
    assert.equal(body.modelId, modelId);
    assert.equal(body.agentId, 'agent_chickpea');
    assert.equal(body.slackAppId, 'AVISUAL');

    const settings = new SqliteSettingsStore(fixture.stateDbPath);
    try {
      assert.equal(
        (await readOnboardingJourney(settings))?.journey.trySlackUserId,
        'UVISUALOWNER',
      );
    } finally {
      settings.close();
    }

    const cutover = await fixtureJson<{
      cutover: { runtimeContract: string; state: string; systemPrincipalCount: number };
    }>(fixture, '/admin/api/chickpea-cutover/preflight');
    assert.equal(cutover.cutover.runtimeContract, 'chickpea-v1');
    assert.equal(cutover.cutover.state, 'activated');
    assert.equal(cutover.cutover.systemPrincipalCount, 1);
  } finally {
    await fixture.close();
  }
});

test('legacy channel onboarding resumes at provider selection instead of a stale Try screen', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  const fixture = await startAdminVisualFixture({ onboardingStage: 'choose_provider' });
  try {
    const settings = new SqliteSettingsStore(fixture.stateDbPath);
    try {
      await settings.setSetting(
        PROVIDER_KEY_SETTING_KEYS.anthropic,
        'sk-ant-local-admin-visual-fixture',
      );
      await settings.setSetting(ONBOARDING_JOURNEY_KEY, JSON.stringify({
        version: 2,
        state: 'active',
        startedAt: 100,
        agentId: 'agent_default',
        selectedWorkspaceId: 'TVISUAL',
        selectedChannelId: 'C12345678',
        selectedChannelName: 'release-room',
        tryStartedAt: 300,
      }));
    } finally {
      settings.close();
    }

    const onboarding = await fixtureJson<{ stage: string; revision: string }>(
      fixture,
      '/admin/api/onboarding',
    );
    assert.equal(onboarding.stage, 'choose_provider');

    const resumed = await fixtureMutation(fixture, '/admin/api/onboarding/provider', {
      expectedRevision: onboarding.revision,
      providerId: 'anthropic',
    });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal((await resumed.json() as { stage: string }).stage, 'choose_model');
  } finally {
    await fixture.close();
  }
});

test('visual fixture rejects non-loopback binding and removes its temporary state', async () => {
  const { startAdminVisualFixture } = await loadFixtureModule();
  await assert.rejects(
    startAdminVisualFixture({ host: '0.0.0.0' }),
    /loopback/i,
  );

  const fixture = await startAdminVisualFixture({ host: '127.0.0.1', port: 0 });
  assert.equal(fixture.address, '127.0.0.1');
  assert.ok(fixture.stateDbPath.startsWith(fixture.stateDirectory));
  assert.ok(existsSync(fixture.stateDirectory));
  await fixture.close();
  assert.equal(existsSync(fixture.stateDirectory), false);
});

test('visual fixture executable removes temporary state when the process exits', async (context) => {
  const scriptPath = fileURLToPath(new URL('../scripts/serve-admin-visual-fixture.mjs', import.meta.url));
  // Model the child being descheduled immediately after it announces readiness.
  // Its shutdown handlers must already exist when the parent sends SIGTERM.
  const pauseAfterReady = `data:text/javascript,${encodeURIComponent(`
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...args) => {
      const result = write(chunk, ...args);
      if (String(chunk).startsWith('Temporary state: ')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      }
      return result;
    };
  `)}`;
  const child = spawn(process.execPath, [
    '--import', pauseAfterReady, scriptPath, '--host', '127.0.0.1', '--port', '0',
  ]);
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  const stateDbPath = await waitForFixtureStatePath(child);
  const stateDirectory = dirname(stateDbPath);
  assert.ok(existsSync(stateDbPath));
  const exited = once(child, 'exit');
  assert.equal(child.kill('SIGTERM'), true);
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(existsSync(stateDirectory), false);
});

test('production Admin markup exposes the shared primary shell and scoped Agent and Channel hooks', () => {
  const html = renderAdminPage();
  const firstPaint = html.split('<script>')[0] ?? '';

  assert.match(html, /admin-surface-agent-detail/);
  assert.match(html, /admin-surface-channels-index/);
  assert.match(html, /admin-surface-channel-detail/);
  assert.match(html, /--admin-visual-font:/);
  assert.match(html, /\.admin-surface\s+\.admin-visual-icon-tile/);
  assert.match(html, /\.admin-surface\s+\.admin-visual-status/);
  assert.match(html, /--admin-visual-muted:\s*#7f7055/);
  assert.match(html, /--admin-visual-green:\s*#4e7a3e/);

  assert.match(firstPaint, /<div id="app" class="frame primary-admin-shell" aria-busy="true">/);
  assert.match(firstPaint, /<nav class="rail primary-shell-sidebar" aria-label="Loading Chickpea">/);
  assert.match(html, /app\.className = "frame onboarding-frame"/);
  assert.match(html, /isPrimaryAdminSurface\(\) \? " primary-admin-shell"/);
  assert.match(html, /<nav class="rail' \+ \(primaryShell \? ' primary-shell-sidebar' : ''\) \+ '" aria-label="Settings">/);
  assert.doesNotMatch(html, /href="\/admin\/account"|>Account<\/a>/);
  assert.doesNotMatch(html, /fixtureState|fixtureCredential|agent_research|C_RELEASES|TVISUAL/);
  assert.doesNotMatch(html, /\.onboarding[^,{]*,\s*\.admin-surface|\.settings[^,{]*,\s*\.admin-surface/);
});
