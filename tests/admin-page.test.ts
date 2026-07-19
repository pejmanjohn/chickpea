import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPage } from '../src/admin/page.ts';
import { seededAgents, seededAssignments } from '../src/config/seed.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FakeElement {
  innerHTML: string;
}

interface FakeTarget {
  closest(selector: string): FakeTarget | null;
  getAttribute(name: string): string | null;
}

interface FakeSubmitTarget extends FakeTarget {
  __formData: Record<string, string>;
}

type Listener = (event: { target: FakeTarget; preventDefault?(): void }) => void;
type AssignmentFixture = {
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  agentId: string;
  enabled: boolean;
  channelPromptAddendum?: string;
};
type SlackConnectionFixture = {
  connected: boolean;
  credentials: { botToken: string; signingSecret: string; botUserId: string };
  teamId?: string | null;
  teamName?: string | null;
  requestUrl: string;
  manifestUrl: string;
};
type SlackChannelFixture = { id: string; name: string; isPrivate?: boolean; isMember?: boolean };
type SlackChannelsFixture = {
  channels: SlackChannelFixture[];
  teamId: string;
  teamName: string;
  truncated?: boolean;
};

const releaseAgent = {
  id: 'agent_release',
  name: 'Release Profile',
  description: 'Release readiness profile',
  instructions: 'Answer with release context.',
  enabled: true,
  model: 'local-stub/release',
};

const opsAgent = {
  id: 'agent_ops',
  name: 'Ops Profile',
  description: 'Operations profile',
  instructions: 'Answer with operations context.',
  enabled: true,
  model: 'local-stub/ops',
};

function inlineScript(): string {
  const script = renderAdminPage().match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'admin page should include one inline script');
  return script;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function actionTarget(attributes: Record<string, string>): FakeTarget {
  return {
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function submitTarget(attributes: Record<string, string>, formData: Record<string, string>): FakeSubmitTarget {
  return {
    __formData: formData,
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function effectiveConfig(agent: typeof releaseAgent, channelId: string): unknown {
  return {
    config: {
      workspaceId: 'T_DESIGN',
      channelId,
      agentId: agent.id,
      profile: agent,
      model: agent.model,
      provider: 'local-stub',
      instructions: `${agent.name} resolved instructions.`,
      instructionLayers: [{ source: 'profile', label: 'Profile', text: agent.instructions }],
      snapshotHash: `sha256-${channelId}`,
    },
  };
}

function defaultAssignments(): AssignmentFixture[] {
  return [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      channelLabel: 'eng-releases',
      agentId: releaseAgent.id,
      enabled: true,
      channelPromptAddendum: 'Release channel addendum.',
    },
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_OPS',
      agentId: opsAgent.id,
      enabled: true,
    },
  ];
}

type ProviderSummaryFixture = { id: string; status: 'env' | 'stored' | 'missing'; modelCount: number | null };
type ModelProviderFixture = {
  id: string;
  configured: boolean;
  source: string;
  suggestions: string[];
};

function runAdminPageHarness(
  options: {
    assignments?: AssignmentFixture[];
    slackConnection?: SlackConnectionFixture;
    slackChannels?: SlackChannelsFixture;
    putIsMember?: boolean;
    cloudflare?: boolean;
    agents?: unknown[];
    providers?: ProviderSummaryFixture[];
    openrouterFavorites?: string[];
    openrouterModels?: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }>;
    workersAiFavorites?: string[];
    workersAiModels?: Array<{ id: string }>;
    anthropicModels?: Array<{ id: string }>;
    openaiModels?: Array<{ id: string }>;
    providerKeyReject?: { status: number; detail: string };
    modelProviders?: ModelProviderFixture[];
    effectiveError?: { status: number; error: string; message?: string };
    agentWriteError?: { status: number; error: string; message?: string };
    skillResolution?: Record<string, unknown>;
    skillResolveError?: { status: number; error: string; message?: string };
    mcpTestResult?: { ok: true; tools: Array<{ name: string; title?: string; description?: string }> } | { ok: false; code: string; message: string };
  } = {},
): {
  app: FakeElement;
  modalRoot: FakeElement;
  favContainers: Record<string, FakeElement>;
  listeners: Record<string, Listener>;
  putAssignments: unknown[];
  slackPosts: unknown[];
  channelListCalls: string[];
  providerKeyPosts: Array<{ id: string; key: string }>;
  providerKeyDeletes: string[];
  favoritesPuts: Array<{ id: string; favorites: string[] }>;
  agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }>;
  agentPostBodies: Array<Record<string, unknown>>;
  skillResolvePosts: Array<{ source: string }>;
  mcpTestPosts: Array<Record<string, unknown>>;
  mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  resolveOpsEffective(): void;
} {
  const app: FakeElement = { innerHTML: '' };
  const modalRoot: FakeElement = { innerHTML: '' };
  const favContainers: Record<string, FakeElement> = {};
  const listeners: Record<string, Listener> = {};
  const putAssignments: unknown[] = [];
  const slackPosts: unknown[] = [];
  const channelListCalls: string[] = [];
  const providerKeyPosts: Array<{ id: string; key: string }> = [];
  const providerKeyDeletes: string[] = [];
  const favoritesPuts: Array<{ id: string; favorites: string[] }> = [];
  const agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
  const agentPostBodies: Array<Record<string, unknown>> = [];
  const skillResolvePosts: Array<{ source: string }> = [];
  const mcpTestPosts: Array<Record<string, unknown>> = [];
  const mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const mcpTestResult = options.mcpTestResult;
  let assignments = options.assignments ?? defaultAssignments();
  const slackConnection = options.slackConnection;
  const slackChannels = options.slackChannels;
  const putIsMember = options.putIsMember;
  // Captured out here because the fetch parameter below is also named `options`
  // (the request init) and would otherwise shadow these harness fixtures.
  const agentsFixture = options.agents;
  const providerKeyReject = options.providerKeyReject;
  const modelProviders = options.modelProviders;
  const effectiveError = options.effectiveError;
  const agentWriteError = options.agentWriteError;
  const skillResolveError = options.skillResolveError;
  const skillResolution = options.skillResolution;
  let resolveOpsEffective: (() => void) | undefined;

  // Mutable provider state so a POST/DELETE key flips the /admin/api/providers
  // status the next loadSettings() reads (mirrors the real endpoint).
  const providerState: ProviderSummaryFixture[] =
    options.providers ?? [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'missing', modelCount: null },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: options.cloudflare ? 'env' : 'missing', modelCount: null },
    ];
  const favoritesState: Record<string, string[]> = {
    openrouter: options.openrouterFavorites ?? ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
    'workers-ai': options.workersAiFavorites ?? ['@cf/zai-org/glm-5.2', '@cf/moonshotai/kimi-k2.6'],
  };
  const modelsState: Record<string, unknown[]> = {
    openrouter:
      options.openrouterModels ??
      [
        { id: 'anthropic/claude-sonnet-4', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'openai/gpt-4.1', context_length: 1047576, pricing: { prompt: '0.000002', completion: '0.000008' } },
        { id: 'meta-llama/llama-3.3-70b-instruct', context_length: 131072, pricing: { prompt: '0.00000013', completion: '0.0000004' } },
      ],
    'workers-ai': options.workersAiModels ?? [{ id: '@cf/zai-org/glm-5.2' }, { id: '@cf/moonshotai/kimi-k2.7-code' }],
    ...(options.anthropicModels ? { anthropic: options.anthropicModels } : {}),
    ...(options.openaiModels ? { openai: options.openaiModels } : {}),
  };

  const document = {
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'modal-root') return modalRoot;
      // The favorites search re-renders only its own results container; hand it a
      // tracked fake element so a keystroke's filtered output is observable.
      if (id.startsWith('fav-results-')) {
        return (favContainers[id] ??= { innerHTML: '' });
      }
      return null;
    },
    querySelector() {
      return null;
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
  };

  // Mutable so a PATCH write is reflected by the follow-up GET (saveProfile
  // re-fetches and re-clones the editor from it), mirroring the real store.
  const agentsList: Record<string, unknown>[] = (agentsFixture ?? [releaseAgent, opsAgent]).map(
    (agent) => ({ ...(agent as Record<string, unknown>) }),
  );

  const fetch = (path: string, options?: { method?: string; body?: string }): Promise<FakeResponse> => {
    const method = options?.method ?? 'GET';
    if (path === '/admin/api/agents' && method === 'GET') {
      return Promise.resolve(jsonResponse({ agents: agentsList }));
    }
    if (path === '/admin/api/agents' && method === 'POST') {
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
            },
            agentWriteError.status,
          ),
        );
      }
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentPostBodies.push(body);
      agentsList.push({ ...body });
      return Promise.resolve(jsonResponse({ agent: body }, 201));
    }
    if (path === '/admin/api/skills/resolve' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as { source: string };
      skillResolvePosts.push({ source: body.source });
      if (skillResolveError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: skillResolveError.error,
              ...(skillResolveError.message ? { message: skillResolveError.message } : {}),
            },
            skillResolveError.status,
          ),
        );
      }
      const resolution =
        skillResolution ?? {
          owner: 'acme',
          repo: 'skills',
          ref: 'main',
          total: 2,
          capped: false,
          skipped: 0,
          skills: [
            {
              name: 'release-notes',
              description: 'Turns merged PRs into a changelog.',
              instructions: '# Release notes\nWrite in launch voice.',
              hasScripts: false,
              path: 'release-notes',
              sourceUrl: 'https://github.com/acme/skills/tree/main/release-notes',
            },
            {
              name: 'incident-scribe',
              description: 'Builds an incident timeline.',
              instructions: '# Incident scribe\nAssemble the timeline.',
              hasScripts: true,
              path: 'incident-scribe',
              sourceUrl: 'https://github.com/acme/skills/tree/main/incident-scribe',
            },
          ],
        };
      return Promise.resolve(jsonResponse({ resolution }));
    }
    const mcpTestMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/mcp\/test$/);
    if (mcpTestMatch && method === 'POST') {
      const agentId = decodeURIComponent(mcpTestMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      mcpTestPosts.push({ agentId, ...body });
      const result =
        mcpTestResult ??
        {
          ok: true,
          tools: [
            { name: 'search_issues', description: 'Search issues.' },
            { name: 'create_issue', description: 'Create an issue (write).' },
          ],
        };
      // The test endpoint always answers HTTP 200 — failures ride in the body.
      return Promise.resolve(jsonResponse(result));
    }
    const mcpSecretsMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/mcp\/secrets\/([^/]+)$/,
    );
    if (mcpSecretsMatch) {
      const agentId = decodeURIComponent(mcpSecretsMatch[1] as string);
      const id = decodeURIComponent(mcpSecretsMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      if (method === 'PUT') {
        mcpSecretPuts.push({ agentId, id, body });
        const headerNames = (body.headerNames as string[]) ?? [];
        const headers: Record<string, string> = {};
        headerNames.forEach((name) => {
          headers[name] = 'stored';
        });
        // Source-only response — the value is never echoed back.
        return Promise.resolve(jsonResponse({ bearer: body.bearerToken !== undefined ? 'stored' : 'missing', headers }));
      }
      if (method === 'DELETE') {
        mcpSecretDeletes.push({ agentId, id, body });
        return Promise.resolve(jsonResponse({ ok: true }));
      }
    }
    const agentPatchMatch = path.match(/^\/admin\/api\/agents\/([^/]+)$/);
    if (agentPatchMatch && method === 'PATCH') {
      const id = decodeURIComponent(agentPatchMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentPatchBodies.push({ id, body });
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
            },
            agentWriteError.status,
          ),
        );
      }
      const existing = agentsList.find((agent) => agent.id === id);
      if (existing) {
        Object.assign(existing, body, { id });
      }
      return Promise.resolve(jsonResponse({ agent: { id, ...body } }));
    }
    if (path === '/admin/api/assignments' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as AssignmentFixture;
      putAssignments.push(body);
      assignments = [
        ...assignments.filter(
          (assignment) => assignment.workspaceId !== body.workspaceId || assignment.channelId !== body.channelId,
        ),
        body,
      ];
      return Promise.resolve(
        jsonResponse({
          assignment: body,
          ...(putIsMember !== undefined ? { isMember: putIsMember } : {}),
        }),
      );
    }
    if (path === '/admin/api/slack-channels' || path.startsWith('/admin/api/slack-channels?')) {
      channelListCalls.push(path);
      if (!slackChannels) {
        return Promise.resolve(jsonResponse({ error: 'slack_not_configured' }, 409));
      }
      return Promise.resolve(
        jsonResponse({
          channels: slackChannels.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            isPrivate: channel.isPrivate ?? false,
            isMember: channel.isMember ?? true,
          })),
          teamId: slackChannels.teamId,
          teamName: slackChannels.teamName,
          truncated: slackChannels.truncated ?? false,
        }),
      );
    }
    if (path === '/admin/api/assignments') {
      return Promise.resolve(
        jsonResponse({
          assignments,
        }),
      );
    }
    if (path === '/admin/api/models') {
      return Promise.resolve(jsonResponse({ providers: modelProviders ?? [] }));
    }
    if (path === '/admin/api/providers') {
      return Promise.resolve(jsonResponse({ providers: providerState.map((p) => ({ ...p })) }));
    }
    const favMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/favorites$/);
    if (favMatch) {
      const id = favMatch[1] as string;
      if (method === 'PUT') {
        const body = JSON.parse(options?.body ?? '{}') as { favorites: string[] };
        favoritesPuts.push({ id, favorites: body.favorites });
        favoritesState[id] = body.favorites;
        return Promise.resolve(jsonResponse({ provider: id, favorites: body.favorites }));
      }
      return Promise.resolve(jsonResponse({ provider: id, favorites: favoritesState[id] ?? [] }));
    }
    const modelsMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch) {
      const id = modelsMatch[1] as string;
      return Promise.resolve(jsonResponse({ provider: id, models: modelsState[id] ?? [], cached: false }));
    }
    const keyMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/key$/);
    if (keyMatch) {
      const id = keyMatch[1] as string;
      const entry = providerState.find((p) => p.id === id);
      if (method === 'DELETE') {
        providerKeyDeletes.push(id);
        if (entry) {
          entry.status = 'missing';
          entry.modelCount = null;
        }
        return Promise.resolve(
          jsonResponse({ ok: true, provider: { id, status: 'missing', modelCount: null }, pinnedProfileCount: 0 }),
        );
      }
      const body = JSON.parse(options?.body ?? '{}') as { key?: string };
      providerKeyPosts.push({ id, key: body.key ?? '' });
      if (providerKeyReject) {
        return Promise.resolve(
          jsonResponse(
            {
              error: 'provider_key_rejected',
              provider: id,
              status: providerKeyReject.status,
              detail: providerKeyReject.detail,
            },
            422,
          ),
        );
      }
      if (entry) {
        entry.status = 'stored';
        entry.modelCount = 2;
      }
      return Promise.resolve(
        jsonResponse({ ok: true, provider: { id, status: 'stored', modelCount: 2 }, models: [{ id: 'm1' }, { id: 'm2' }] }),
      );
    }
    if (path === '/admin/api/slack-connection' && method === 'POST') {
      slackPosts.push(JSON.parse(options?.body ?? '{}'));
      // A successful save flips the fixture to connected/stored, exactly like
      // the real endpoint's follow-up GET would report.
      if (slackConnection) {
        slackConnection.connected = true;
        slackConnection.credentials = {
          botToken: 'stored',
          signingSecret: 'stored',
          botUserId: 'stored',
        };
      }
      return Promise.resolve(
        jsonResponse({
          ok: true,
          team: 'Acme Inc',
          botName: 'tag',
          botUserId: 'U_BOT',
          note: 'Signing secret saved; Slack proves it on the first signed event.',
        }),
      );
    }
    if (path === '/admin/api/slack-connection') {
      // Without a fixture, mirror an endpoint failure: the page must render
      // everything else and simply omit the card (resilience contract).
      return slackConnection
        ? Promise.resolve(jsonResponse(slackConnection))
        : Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    }
    if (path.startsWith('/admin/api/effective-config?')) {
      if (effectiveError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: effectiveError.error,
              ...(effectiveError.message ? { message: effectiveError.message } : {}),
            },
            effectiveError.status,
          ),
        );
      }
      const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const channelId = params.get('channelId');
      if (channelId === 'C_OPS') {
        return new Promise<FakeResponse>((resolve) => {
          resolveOpsEffective = () => {
            resolve(jsonResponse(effectiveConfig(opsAgent, 'C_OPS')));
          };
        });
      }
      return Promise.resolve(jsonResponse(effectiveConfig(releaseAgent, 'C0EXR3L9T')));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  };

  vm.runInNewContext(
    inlineScriptFor(options.cloudflare ?? false),
    {
      document,
      fetch,
      console,
      FormData: class {
        private readonly fields: Record<string, string>;

        constructor(form: FakeSubmitTarget) {
          this.fields = form.__formData;
        }

        get(name: string) {
          return this.fields[name] ?? null;
        }
      },
      URLSearchParams,
    },
    { filename: 'admin-page-inline.js' },
  );

  return {
    app,
    modalRoot,
    favContainers,
    listeners,
    putAssignments,
    slackPosts,
    channelListCalls,
    providerKeyPosts,
    providerKeyDeletes,
    favoritesPuts,
    agentPatchBodies,
    agentPostBodies,
    skillResolvePosts,
    mcpTestPosts,
    mcpSecretPuts,
    mcpSecretDeletes,
    resolveOpsEffective() {
      assert.ok(resolveOpsEffective, 'expected C_OPS effective-config request to be pending');
      resolveOpsEffective();
    },
  };
}

// IS_CLOUDFLARE is baked into the inline script at render time from
// isCloudflareTarget() (globalThis.navigator.userAgent). The Workers AI row is
// binding-only, so a Cloudflare-target harness renders it by masquerading the
// navigator just for the renderAdminPage() call, then restoring it.
function inlineScriptFor(cloudflare: boolean): string {
  if (!cloudflare) return inlineScript();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Cloudflare-Workers' },
    configurable: true,
  });
  try {
    return inlineScript();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

function disconnectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: false,
    credentials: { botToken: 'missing', signingSecret: 'env', botUserId: 'missing' },
    teamId: null,
    teamName: null,
    requestUrl: 'https://tag.example.dev/channels/slack/events',
    manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
  };
}

function connectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: true,
    credentials: { botToken: 'stored', signingSecret: 'stored', botUserId: 'stored' },
    teamId: 'T_DESIGN',
    teamName: 'Acme Inc',
    requestUrl: 'https://tag.example.dev/channels/slack/events',
    manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
  };
}

function channelsFixture(): SlackChannelsFixture {
  return {
    teamId: 'T_DESIGN',
    teamName: 'Acme Inc',
    truncated: false,
    channels: [
      { id: 'C_NEW', name: 'new-channel', isPrivate: false, isMember: true },
      { id: 'C_PRIVATE', name: 'secret-room', isPrivate: true, isMember: false },
    ],
  };
}

test('admin page renders channel labels, profile secondary text, and singular channel counts', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  assert.match(harness.app.innerHTML, /<span class="chan-name">#eng-releases<\/span>/);
  // Rail secondary text is the attached profile's name (per the design mockups);
  // the channel ID secondary lives on the Profiles "Used in" rows instead.
  assert.match(harness.app.innerHTML, /<span class="chan-meta">Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  const click = harness.listeners.click;
  assert.ok(click);
  // Profiles is now a main-panel destination (the modal was retired): opening it
  // swaps the main panel to the overview, and each card carries its usage meta.
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Profiles<\/h1>/);
  assert.match(harness.app.innerHTML, /<span class="pcard-name">Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  // Drilling into a profile opens the full-page editor whose "Used in" section
  // names the channel it answers in (with its channel ID) and offers Detach.
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Used in<\/h2>/);
  assert.match(harness.app.innerHTML, /<span class="b-name mono"[^>]*>#eng-releases<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="b-meta">C0EXR3L9T<\/span>/);
  assert.match(harness.app.innerHTML, /data-action="detach-channel"/);
});

test('the profile editor blocks delete while assigned and confirms disable everywhere', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // Delete is disabled while the profile is attached (the server 409s too); the
  // footer's usage count explains why.
  assert.match(harness.app.innerHTML, /data-action="delete-profile" disabled[^>]*>Delete profile<\/button>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  // Turning the enable toggle off on an assigned profile asks for confirmation
  // (stops-everywhere) before it commits, rather than silently disabling it.
  change({
    target: {
      checked: false,
      closest: () => null,
      getAttribute(name: string) {
        return name === 'data-action' ? 'profile-enable-toggle' : null;
      },
    } as unknown as FakeTarget,
  });
  assert.match(harness.app.innerHTML, /Disable Release Profile\?/);
  assert.match(harness.app.innerHTML, /data-action="disable-confirm"/);
  assert.match(harness.app.innerHTML, /data-action="disable-keep"/);
});

test('New profile opens a blank create screen and validation gates save', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });

  // The create screen is a full page (not a modal): back link, ghost-example
  // instructions placeholder, and Create/Cancel.
  assert.match(harness.app.innerHTML, /<h1 class="page-title">New profile<\/h1>/);
  assert.match(harness.app.innerHTML, /Answer teammates/);
  assert.match(harness.app.innerHTML, /data-action="cancel-create"/);
  assert.match(harness.app.innerHTML, /data-action="save-profile"/);

  // A blank name is rejected inline with the verbatim server-side string; no
  // agents request is issued.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  assert.match(harness.app.innerHTML, /Name is required\./);
});

test('profile capability tabs switch the visible panel on click', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // Instructions is the default tab: its panel is visible, the others [hidden].
  assert.match(harness.app.innerHTML, /id="ptab-instructions" class="ptab on"/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-skills"[^>]* hidden/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-instructions"[^>]* hidden/);

  // Clicking the Skills tab swaps the visible panel and the active pill.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  assert.match(harness.app.innerHTML, /id="ptab-skills" class="ptab on"/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-instructions"[^>]* hidden/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-skills"[^>]* hidden/);

  // And back to Connections.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  assert.match(harness.app.innerHTML, /id="ptab-connections" class="ptab on"/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-connections"[^>]* hidden/);

  // Mid-typed whitespace survives a tab round-trip: the keystroke mirror (not
  // a trimming collectProfileDraft) carries the draft across the re-render.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer carefully.\n\n- next bullet ') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  assert.match(harness.app.innerHTML, /Answer carefully\.\n\n- next bullet </);
});

// A checkbox change target that also exposes `checked` (the skill enable toggle
// and profile-enable toggle both read target.checked).
function checkboxTarget(attributes: Record<string, string>, checked: boolean): FakeTarget & { checked: boolean } {
  return {
    checked,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

test('the profile editor manages custom skills end to end and carries them in the save body', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_release',
        name: 'Release Profile',
        description: 'Release readiness profile',
        instructions: 'Answer with release context.',
        enabled: true,
        model: 'local-stub/release',
        skills: [],
      },
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // The Skills capability tab renders, its panel empty at first.
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);
  assert.match(harness.app.innerHTML, /No custom skills yet/);

  // Open a blank editor; the inline form appears with the three fields.
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  assert.match(harness.app.innerHTML, /data-action="skill-field-name"/);
  assert.match(harness.app.innerHTML, /data-action="skill-field-instructions"/);

  // An invalid name is rejected inline with the client mirror of the server rule.
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'Bad Name!') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'x') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'y') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /lowercase letters/);

  // Fix it and save; the row lists with the custom badge and defaults enabled.
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'release-notes') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Turns PRs into a changelog.') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'Write the notes in launch voice.') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /class="badge-src">custom/);
  assert.match(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // A duplicate name is rejected.
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'release-notes') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'dupe') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'dupe') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /Another skill already uses that name/);
  click({ target: actionTarget({ 'data-action': 'skill-cancel' }) });

  // Toggle the skill off — the toggle re-renders unchecked.
  change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // Edit the skill; the form is seeded and the edit preserves the disabled state.
  click({ target: actionTarget({ 'data-action': 'skill-edit', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /value="release-notes"/);
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Edited changelog copy.') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /Edited changelog copy\./);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // Save the profile — the PATCH body carries the skills array with the edits.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  const patched = harness.agentPatchBodies[0];
  assert.equal(patched?.id, 'agent_release');
  assert.deepEqual(patched?.body.skills, [
    { name: 'release-notes', description: 'Edited changelog copy.', instructions: 'Write the notes in launch voice.', enabled: false },
  ]);

  // After save the editor re-clones from the (echoed) agent, so the row persists
  // and the save bar re-disables.
  assert.match(harness.app.innerHTML, /release-notes/);

  // Remove the skill and save again; the array is now empty in the PATCH body.
  click({ target: actionTarget({ 'data-action': 'skill-remove', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /No custom skills yet/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 2);
  assert.deepEqual(harness.agentPatchBodies[1]?.body.skills, []);
});

test('importing skills from a URL resolves a picker, adds the selected skill, and carries it in the save body', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_import',
        name: 'Import Profile',
        description: 'Import readiness profile',
        instructions: 'Answer with import context.',
        enabled: true,
        model: 'local-stub/import',
        skills: [],
      },
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_import' }) });

  // The Skills section offers an "Import from URL" affordance next to New skill.
  assert.match(harness.app.innerHTML, /data-action="import-skills"/);

  // Open the import panel — the source input appears; the picker is not shown yet.
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  assert.match(harness.app.innerHTML, /data-action="import-source"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-add"/);

  // Type a source and Find skills — the endpoint gets the raw string.
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  assert.equal(harness.skillResolvePosts.length, 1);
  assert.equal(harness.skillResolvePosts[0]?.source, 'acme/skills');

  // The picker renders both skills, the summary line, and the has-scripts badge.
  assert.match(harness.app.innerHTML, /Found 2 skills in acme\/skills/);
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /incident-scribe/);
  assert.match(harness.app.innerHTML, /won&rsquo;t run yet/);
  assert.match(harness.app.innerHTML, /data-action="import-add"/);

  // Both rows start selected; deselect the scripts one so only release-notes adds.
  change({ target: checkboxTarget({ 'data-action': 'import-row-toggle', 'data-index': '1' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-row-toggle" data-index="1" checked/);

  // Add selected — the panel closes and the imported skill shows as a normal row.
  click({ target: actionTarget({ 'data-action': 'import-add' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-source"/);
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /class="badge-src">custom/);
  // Only the selected skill was imported.
  assert.doesNotMatch(harness.app.innerHTML, /incident-scribe/);

  // Save — the PATCH body carries the imported skill in the client shape.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    {
      name: 'release-notes',
      description: 'Turns merged PRs into a changelog.',
      instructions: '# Release notes\nWrite in launch voice.',
      enabled: true,
    },
  ]);
});

test('an import error is surfaced in the panel and dedupes a same-named skill on add', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_dupe',
        name: 'Dupe Profile',
        description: 'Dedupe profile',
        instructions: 'Answer with context.',
        enabled: true,
        model: 'local-stub/dupe',
        skills: [{ name: 'release-notes', description: 'Old copy.', instructions: 'Old body.', enabled: false }],
      },
    ],
    skillResolveError: { status: 502, error: 'rate_limited', message: 'GitHub rate limit hit. Add a GITHUB_TOKEN or try later.' },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_dupe' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });

  // A server error surfaces its message inline and keeps the panel open.
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /GitHub rate limit hit\. Add a GITHUB_TOKEN or try later\./);
  assert.match(harness.app.innerHTML, /data-action="import-source"/);
});

test('importing a same-named skill replaces the existing one rather than duplicating it', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_replace',
        name: 'Replace Profile',
        description: 'Replace profile',
        instructions: 'Answer with context.',
        enabled: true,
        model: 'local-stub/replace',
        skills: [{ name: 'release-notes', description: 'Old copy.', instructions: 'Old body.', enabled: false }],
      },
    ],
    skillResolution: {
      owner: 'acme',
      repo: 'skills',
      ref: 'main',
      total: 1,
      capped: false,
      skipped: 0,
      skills: [
        {
          name: 'release-notes',
          description: 'Fresh copy.',
          instructions: 'Fresh body.',
          hasScripts: false,
          path: 'release-notes',
          sourceUrl: 'https://github.com/acme/skills/tree/main/release-notes',
        },
      ],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_replace' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills@release-notes') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-add' }) });

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  // Exactly one release-notes skill, replaced with the imported copy (no duplicate).
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    { name: 'release-notes', description: 'Fresh copy.', instructions: 'Fresh body.', enabled: true },
  ]);
});

test('saving a profile with a filled-but-not-added skill editor commits the skill, not drops it', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_trap',
        name: 'Trap Profile',
        description: 'Repro for the lost-skill bug',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/trap',
        skills: [],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_trap' }) });

  // Open the editor and fill it — but do NOT click "Add skill" (skill-save-row).
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'incident-scribe') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Build a timeline.') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, '# Incident Scribe') });

  // Click Save changes directly. The filled editor must be committed, not dropped.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    { name: 'incident-scribe', description: 'Build a timeline.', instructions: '# Incident Scribe', enabled: true },
  ]);
});

// ---- Connections (remote MCP servers) --------------------------------------

function connectionsAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent_conn',
    name: 'Conn Profile',
    description: 'Connections profile',
    instructions: 'Answer with connection context.',
    enabled: true,
    model: 'local-stub/conn',
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

test('the Connections section renders empty, with the STDIO-greyed form, exact security copy, and trust-gated Test', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // The Connections capability tab renders, its panel empty at first, with the
  // tokens-by-reference note.
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="connections"/);
  assert.match(harness.app.innerHTML, /No connections yet/);
  assert.match(
    harness.app.innerHTML,
    /Your profile stores connection policy and tool approvals only &mdash; tokens live in the settings store and are never returned by the API\./,
  );

  // Open the add form — Name + URL + transport control appear.
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });
  assert.match(harness.app.innerHTML, /data-action="conn-field-name"/);
  assert.match(harness.app.innerHTML, /data-action="conn-field-url"/);

  // STDIO is present but disabled with the Cloudflare-unsupported title.
  assert.match(harness.app.innerHTML, /disabled title="Not supported on Cloudflare Workers">STDIO<\/button>/);
  // Streamable HTTP and SSE are live segmented options.
  assert.match(harness.app.innerHTML, /data-action="conn-transport" data-transport="streamable-http"/);
  assert.match(harness.app.innerHTML, /data-action="conn-transport" data-transport="sse"/);

  // Test is disabled until the url is filled. The input handler doesn't
  // re-render, so trigger one via the transport segment.
  assert.match(harness.app.innerHTML, /data-action="conn-test" disabled/);
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-transport', 'data-transport': 'streamable-http' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-test" disabled/);
});

test('testing a connection renders discovered-tool checkboxes all checked and carries policy (not the token) into the save body', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });

  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  // Switch to bearer auth and paste a token — the token is a TRANSIENT secret.
  change({
    target: {
      value: 'bearer',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  input({ target: inputTarget({ 'data-action': 'conn-field-bearer' }, 'sk-secret-token') });

  // Test the connection — the endpoint gets the id/url/transport/authMode + token.
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();
  assert.equal(harness.mcpTestPosts.length, 1);
  const testBody = harness.mcpTestPosts[0] as Record<string, unknown>;
  assert.equal(testBody.agentId, 'agent_conn');
  assert.equal(testBody.id, 'linear');
  assert.equal(testBody.url, 'https://mcp.example.com/mcp');
  assert.equal(testBody.authMode, 'bearer');
  assert.equal(testBody.bearerToken, 'sk-secret-token');

  // Both discovered tools render as checkboxes, all checked by default.
  assert.match(harness.app.innerHTML, /Connected &middot; 2 tools/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);
  assert.match(harness.app.innerHTML, /search_issues/);
  assert.match(harness.app.innerHTML, /create_issue/);

  // Uncheck the write tool so only search_issues is approved.
  change({ target: checkboxTarget({ 'data-action': 'conn-tool-toggle', 'data-index': '1' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  // Add the connection (explicit button) and save the profile.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  // The PATCH body carries the connection POLICY: allowedTools is the checked
  // subset, discoveredTools is the full list, lifecycleStatus is ready.
  assert.equal(harness.agentPatchBodies.length, 1);
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers.length, 1);
  const conn = servers[0] as Record<string, unknown>;
  assert.equal(conn.id, 'linear');
  assert.equal(conn.displayName, 'Linear');
  assert.equal(conn.authMode, 'bearer');
  assert.equal(conn.lifecycleStatus, 'ready');
  assert.deepEqual(conn.allowedTools, ['search_issues']);
  assert.deepEqual(
    (conn.discoveredTools as Array<Record<string, unknown>>).map((t) => t.name),
    ['search_issues', 'create_issue'],
  );

  // CRITICAL: the token value is NEVER in the profile PATCH body anywhere.
  assert.doesNotMatch(JSON.stringify(harness.agentPatchBodies[0]?.body), /sk-secret-token/);
  // But it WAS PUT to the settings store by reference.
  assert.equal(harness.mcpSecretPuts.length, 1);
  assert.equal(harness.mcpSecretPuts[0]?.agentId, 'agent_conn');
  assert.equal(harness.mcpSecretPuts[0]?.id, 'linear');
  assert.equal((harness.mcpSecretPuts[0]?.body as Record<string, unknown>).bearerToken, 'sk-secret-token');
});

test('creating a profile writes connection secrets under the generated profile id', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Support Profile') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Help teammates.') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  change({
    target: {
      value: 'bearer',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  input({ target: inputTarget({ 'data-action': 'conn-field-bearer' }, 'new-profile-token') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPostBodies[0]?.id, 'agent_support_profile');
  assert.equal(harness.mcpSecretPuts[0]?.agentId, 'agent_support_profile');
  assert.equal(harness.mcpSecretPuts[0]?.id, 'linear');
  assert.equal(harness.mcpSecretPuts[0]?.body.bearerToken, 'new-profile-token');
});

test('re-testing a connection refreshes discovered tools; a vanished tool drops and a new one defaults checked', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [
              { name: 'old_tool_a' },
              { name: 'old_tool_b' },
            ],
            allowedTools: ['old_tool_a'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
    // The re-test discovers a DIFFERENT tool set — old_tool_b is gone, a new one appears.
    mcpTestResult: {
      ok: true,
      tools: [
        { name: 'old_tool_a', description: 'kept' },
        { name: 'brand_new_tool', description: 'new' },
      ],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // The card shows the connected pill for the persisted (1-approved) connection.
  assert.match(harness.app.innerHTML, /Connected &middot; 1 tool/);

  // Open the editor and re-test.
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // The vanished old_tool_b is gone; the kept tool retains its approval and the
  // brand-new tool defaults checked.
  assert.match(harness.app.innerHTML, /brand_new_tool/);
  assert.doesNotMatch(harness.app.innerHTML, /old_tool_b/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  // Save — allowedTools now reflects ONLY the fresh discovery, not the stale approval.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers[0]?.allowedTools, ['old_tool_a', 'brand_new_tool']);
  assert.deepEqual(
    (servers[0]?.discoveredTools as Array<Record<string, unknown>>).map((t) => t.name),
    ['old_tool_a', 'brand_new_tool'],
  );
});

test('re-testing preserves a deliberately-unchecked tool that still exists (no silent re-approval)', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [{ name: 'read_tool' }, { name: 'write_tool' }],
            // Operator approved only the read tool; write_tool was left unchecked.
            allowedTools: ['read_tool'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
    // Re-test rediscovers the SAME two tools — write_tool still exists.
    mcpTestResult: {
      ok: true,
      tools: [{ name: 'read_tool', description: 'r' }, { name: 'write_tool', description: 'w' }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // read_tool stays checked; write_tool must remain UNCHECKED across the re-test.
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers[0]?.allowedTools, ['read_tool']);
});

test('a failed test marks the connection failed with the safe status text and no tool checkboxes', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    mcpTestResult: { ok: false, code: 'unauthorized', message: 'The MCP server rejected the connection. Check the token or headers.' },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // The safe failure text surfaces inline; no discovered-tool checkboxes render.
  assert.match(harness.app.innerHTML, /The MCP server rejected the connection\. Check the token or headers\./);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle"/);

  // Save — the connection persists as failed with the classified statusText.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.lifecycleStatus, 'failed');
  assert.equal(servers[0]?.statusText, 'The MCP server rejected the connection. Check the token or headers.');
  assert.deepEqual(servers[0]?.allowedTools, []);
});

test('removing a connection confirms in a modal and DELETEs its secrets on save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'bearer',
            headerNames: ['X-Api-Key'],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [{ name: 'search_issues' }],
            allowedTools: ['search_issues'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  assert.match(harness.app.innerHTML, /Linear/);

  // Remove opens a confirm modal rather than dropping the row immediately.
  click({ target: actionTarget({ 'data-action': 'conn-remove', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /Remove Linear\?/);
  assert.match(harness.app.innerHTML, /data-action="conn-remove-confirm"/);
  assert.match(harness.app.innerHTML, /data-action="conn-remove-cancel"/);

  // Confirm — the row is gone; empty state returns.
  click({ target: actionTarget({ 'data-action': 'conn-remove-confirm' }) });
  assert.match(harness.app.innerHTML, /No connections yet/);

  // Save — the PATCH body has an empty mcpServers AND the secrets DELETE fires
  // with the connection's header names.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.deepEqual(harness.agentPatchBodies[0]?.body.mcpServers, []);
  assert.equal(harness.mcpSecretDeletes.length, 1);
  assert.equal(harness.mcpSecretDeletes[0]?.agentId, 'agent_conn');
  assert.equal(harness.mcpSecretDeletes[0]?.id, 'linear');
  assert.deepEqual((harness.mcpSecretDeletes[0]?.body as Record<string, unknown>).headerNames, ['X-Api-Key']);
});

test('saving with a filled-but-not-added connection editor commits it, not drops it', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // Open the editor and fill it — but do NOT click "Add connection".
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Deepwiki') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.deepwiki.com/mcp') });

  // Save changes directly — the filled editor must be committed.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.id, 'deepwiki');
  assert.equal(servers[0]?.displayName, 'Deepwiki');
});

test('a duplicate connection name and a non-https URL are rejected inline before save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'pending',
            statusText: '',
            discoveredTools: [],
            allowedTools: [],
          },
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-new' }) });

  // A non-https URL is rejected inline.
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Other') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'http://insecure.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  assert.match(harness.app.innerHTML, /MCP server URLs must use https\./);

  // A name that slugs to the existing id is rejected as a duplicate.
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://other.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  assert.match(harness.app.innerHTML, /Another connection already uses that name\./);
});

test('saving a profile with an invalid open skill editor blocks the save and shows the error', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_badedit',
        name: 'Bad Edit Profile',
        description: 'Repro',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/be',
        skills: [],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;

  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_badedit' }) });
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'Bad Name!') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'x') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'y') });

  // Save must NOT silently proceed — it surfaces the validation error and blocks.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 0);
  assert.match(harness.app.innerHTML, /lowercase letters/);
});

test('creating a blank profile round-trips with an empty skills array', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  // The create screen has no capability tabs (M3 scope is edit-only), but a new
  // profile defaults skills to [] and the POST body must still carry the field.
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="profile-tab"/);
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Fresh Profile') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer freshly.') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  // The create POST carries an empty skills array — the backend contract requires
  // the field, and a blank profile has no custom skills yet.
  assert.equal(harness.agentPostBodies.length, 1);
  assert.equal(harness.agentPostBodies[0]?.name, 'Fresh Profile');
  assert.deepEqual(harness.agentPostBodies[0]?.skills, []);
  assert.equal(Object.hasOwn(harness.agentPostBodies[0] ?? {}, 'defaultModels'), false);
});

test('the profile editor save bar is sticky, hidden when clean, and revealed when dirty', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_bar',
        name: 'Bar Profile',
        description: 'Save-bar fixture',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/bar',
        skills: [{ name: 'a-skill', description: 'desc', instructions: '# body', enabled: true }],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_bar' }) });

  // The sticky bar exists but is marked clean (hidden) with no pending edits.
  assert.match(harness.app.innerHTML, /save-bar-sticky/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^"]*is-clean/);

  // A render-causing edit (toggle the skill off) marks the profile dirty; the
  // re-render drops is-clean and shows the "Unsaved changes" label + Save.
  change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /save-bar-sticky[^"]*is-clean/);
  assert.match(harness.app.innerHTML, /Unsaved changes/);
  assert.match(harness.app.innerHTML, /data-action="save-profile"/);
});

test('leaving a dirty profile editor prompts, and honors keep/discard/save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_guard',
        name: 'Guard Profile',
        description: 'd',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/guard',
        skills: [{ name: 'a-skill', description: 'desc', instructions: '# body', enabled: true }],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  const openEditor = () =>
    click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_guard' }) });
  // A render-causing edit that marks the profile dirty.
  const dirtyIt = () =>
    change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });

  // Clean editor → clicking Profiles navigates immediately, no modal.
  openEditor();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your profiles/);

  // Dirty editor → clicking Profiles opens the guard modal and does NOT leave.
  openEditor();
  dirtyIt();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Unsaved changes/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);

  // Keep editing → modal closes, still on the editor.
  click({ target: actionTarget({ 'data-action': 'leave-cancel' }) });
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);

  // Discard & leave → navigate to the list, and NO save was sent.
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'leave-discard' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your profiles/);
  assert.equal(harness.agentPatchBodies.length, 0);

  // Save changes from the modal → PATCH is sent, then it navigates to the list.
  openEditor();
  dirtyIt();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'leave-save' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your profiles/);
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.id, 'agent_guard');
});

test('profile save and access summary render server model-resolution messages', async () => {
  const serverMessage = 'No model pinned for agent agent_no_model. Pin a model in /admin (Profiles -> Model).';
  const harness = runAdminPageHarness({
    agentWriteError: { status: 422, error: 'model_not_resolvable', message: serverMessage },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'No Model') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer from the fixture.') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /No model pinned for agent agent_no_model/);
  assert.doesNotMatch(harness.app.innerHTML, /model_not_resolvable/);

  const accessHarness = runAdminPageHarness({
    effectiveError: { status: 422, error: 'model_not_resolvable', message: serverMessage },
  });
  await flushAsync();

  assert.match(accessHarness.app.innerHTML, /<p class="field-label">Configuration issue<\/p>/);
  assert.match(accessHarness.app.innerHTML, /No model pinned for agent agent_no_model/);
  assert.doesNotMatch(accessHarness.app.innerHTML, /<p class="field-label">No enabled profile<\/p>/);
});

test('selecting a channel re-renders after effective config finishes resolving', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C_OPS',
    }),
  });

  assert.match(harness.app.innerHTML, /Resolving\.\.\./);
  harness.resolveOpsEffective();
  await flushAsync();

  assert.match(harness.app.innerHTML, /#C_OPS/);
  assert.match(harness.app.innerHTML, /local-stub\/ops/);
  assert.doesNotMatch(harness.app.innerHTML, /Resolving\.\.\./);
});

test('channel rail groups concrete assignments under their own workspace headers', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      ...defaultAssignments(),
      {
        workspaceId: 'T_DEMO',
        channelId: 'C_DEMO',
        channelLabel: 'demo-channel',
        agentId: releaseAgent.id,
        enabled: true,
      },
      {
        workspaceId: '*',
        channelId: '*',
        agentId: releaseAgent.id,
        enabled: true,
      },
    ],
  });
  await flushAsync();

  // Each workspace group renders a ws-row header (chevron icon + the workspace
  // id, since only the connected workspace carries a friendly team name).
  assert.match(harness.app.innerHTML, /<div class="ws-row"><svg[^>]*>.*?<\/svg>T_DESIGN<\/div>/);
  assert.match(harness.app.innerHTML, /<div class="ws-row"><svg[^>]*>.*?<\/svg>T_DEMO<\/div>/);

  const designHeader = harness.app.innerHTML.indexOf('>T_DESIGN</div>');
  const designChannel = harness.app.innerHTML.indexOf('<span class="chan-name">#eng-releases</span>');
  const demoHeader = harness.app.innerHTML.indexOf('>T_DEMO</div>');
  const demoChannel = harness.app.innerHTML.indexOf('<span class="chan-name">#demo-channel</span>');
  assert.ok(designHeader >= 0 && designHeader < designChannel);
  assert.ok(designChannel < demoHeader);
  assert.ok(demoHeader < demoChannel);
});

test('add-channel opens a main-panel picker with the locked workspace and a channel dropdown', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  // Workspace is locked text (name + id), not an editable input.
  assert.match(harness.app.innerHTML, /Add a channel/);
  assert.match(harness.app.innerHTML, /Acme Inc/);
  assert.doesNotMatch(harness.app.innerHTML, /name="workspaceId"/);
  // The dropdown is populated from the proxy, private channels get a lock, and a
  // channel the bot is not in is flagged.
  assert.match(harness.app.innerHTML, /id="add-channel-select"/);
  assert.match(harness.app.innerHTML, /# new-channel/);
  assert.match(harness.app.innerHTML, /secret-room/);
  assert.match(harness.app.innerHTML, /not a member/);
  // Helper copy + the manual fallback affordance.
  assert.match(harness.app.innerHTML, /Invite @Tag to the channel in Slack, then click Refresh/);
  assert.match(harness.app.innerHTML, /Enter ID manually/);
  // The picker fetched the proxy exactly once on open.
  assert.equal(harness.channelListCalls.length, 1);
});

test('add-channel submit PUTs the connected workspace id and surfaces the invite reminder', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
    putIsMember: false,
  });
  await flushAsync();

  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { channelSelect: 'C_PRIVATE' }),
    preventDefault() {},
  });
  await flushAsync();

  // The PUT carries the CONNECTED workspace id (never a hand-typed one) and the
  // picked channel.
  assert.deepEqual(harness.putAssignments, [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_PRIVATE',
      agentId: releaseAgent.id,
      enabled: true,
      channelLabel: 'secret-room',
    },
  ]);
  // isMember:false from the server drives the invite reminder (channel-specific).
  assert.match(harness.app.innerHTML, /Invite Tag to finish/);
  assert.match(harness.app.innerHTML, /Invite @Tag to #secret-room in Slack/);
});

test('the rail and add-channel affordance stay gated until Slack is connected', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  // Disconnected: the whole screen is the Connect stepper — no rail, no
  // add-channel affordance anywhere, and no channel-list fetch.
  assert.match(harness.app.innerHTML, /Connect Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="toggle-add-channel"/);
  assert.doesNotMatch(harness.app.innerHTML, /class="rail"/);
  assert.equal(harness.channelListCalls.length, 0);
});

test('add-channel manual fallback reveals a server-validated channel-ID input', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'toggle-manual-channel' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /id="add-channel-manual" name="manualChannelId"/);

  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { manualChannelId: 'C_MANUAL' }),
    preventDefault() {},
  });
  await flushAsync();

  assert.deepEqual(harness.putAssignments, [
    { workspaceId: 'T_DESIGN', channelId: 'C_MANUAL', agentId: releaseAgent.id, enabled: true },
  ]);
});

test('admin page renders the first-run Connect stepper when credentials are missing', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  // Step 1 is the whole screen: header, not-connected chip, the manifest Create
  // link (events URL prefilled), and the workspace-pick warning.
  assert.match(harness.app.innerHTML, /Connect Slack/);
  assert.match(harness.app.innerHTML, /Two steps: create the app/);
  assert.match(harness.app.innerHTML, /Not connected/);
  // The manifest deep-link is the server-provided URL, attribute-escaped.
  assert.match(
    harness.app.innerHTML,
    /href="https:\/\/api\.slack\.com\/apps\?new_app=1&amp;manifest_json=%7B%22a%22%3A1%7D"/,
  );
  assert.match(harness.app.innerHTML, /tag\.example\.dev\/channels\/slack\/events/);
  assert.match(harness.app.innerHTML, /pick a workspace/);
  // Credential provenance lives in a collapsed disclosure (env signing secret is
  // read-only), and the paste fields belong to step 2 — hidden until advanced.
  assert.match(harness.app.innerHTML, /configured via environment/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  await flushAsync();

  // Step 2: the two paired paste fields + the live-validation hint.
  assert.match(harness.app.innerHTML, /name="botToken"/);
  assert.match(harness.app.innerHTML, /name="signingSecret"/);
  assert.match(harness.app.innerHTML, /first real Slack event/);
});

test('connected + zero channels shows the funnel with credentials demoted to a disclosure', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: {
      connected: true,
      credentials: { botToken: 'env', signingSecret: 'env', botUserId: 'stored' },
      requestUrl: 'https://tag.example.dev/channels/slack/events',
      manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
    },
  });
  await flushAsync();

  // The funnel is the focus; the header chip flips to Connected and credential
  // provenance is demoted to a collapsed "Connection details" disclosure.
  assert.match(harness.app.innerHTML, /Choose where Chickpea answers/);
  assert.match(harness.app.innerHTML, /Connected/);
  assert.match(harness.app.innerHTML, /Connection details/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Connect Slack/);
});

test('admin page omits the connection card when the endpoint fails (resilience)', async () => {
  const harness = runAdminPageHarness({ assignments: [] });
  await flushAsync();

  // Everything else still renders...
  assert.match(harness.app.innerHTML, /No channels yet/);
  // ...but no wizard card is painted from a failed connection fetch: neither the
  // paste form nor either connection-card heading appears.
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Slack connection/);
});

test('wizard paste-back submit posts both credentials and renders the connected state', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '  xoxb-pasted ', signingSecret: 'pasted-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  // Trimmed on the client before the POST.
  assert.deepEqual(harness.slackPosts, [{ botToken: 'xoxb-pasted', signingSecret: 'pasted-secret' }]);
  // The connected funnel's dismissable success toast names the team + bot.
  assert.match(harness.app.innerHTML, /Connected to <b[^>]*>Acme Inc<\/b> as <span[^>]*>@tag<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
});

test('wizard submit validates empty fields inline without posting', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '', signingSecret: 'secret-only' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(harness.slackPosts.length, 0);
  assert.match(harness.app.innerHTML, /Bot token is required\./);
});

// ---- Settings: model providers (cards 13-14) --------------------------------

function inputTarget(attributes: Record<string, string>, value: string): FakeTarget & { value: string } {
  return {
    value,
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

test('admin topbar exposes a Settings destination that lands on the model-providers page', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  // The Settings sibling sits next to Profiles in the topbar (inactive until opened).
  assert.match(harness.app.innerHTML, /data-action="open-settings">Settings<\/button>/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<h1 class="page-title">Settings<\/h1>/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Model providers<\/h2>/);
  // The active-state styling is the soft ember tint (.nav-active), no weight change.
  assert.match(harness.app.innerHTML, /class="btn btn-soft nav-active" data-action="open-settings">Settings<\/button>/);
});

test('Settings renders the three key-provider rows and hides Workers AI on the Node target', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  // Anthropic (stored) shows the Stored chip + model count; OpenAI (missing) offers Add key.
  assert.match(html, /<span class="prov-name">Anthropic<\/span>/);
  assert.match(html, /Stored<\/span><span class="hint">Saved here · 10 models available<\/span>/);
  assert.match(html, /<span class="prov-name">OpenAI<\/span>/);
  assert.match(html, /Missing<\/span>/);
  assert.match(html, /data-action="prov-add-key" data-provider="openai"/);
  // OpenRouter (env) is read-only — no change/remove — with the favorites manager.
  assert.match(html, /Via environment<\/span><span class="hint">Read-only/);
  assert.match(html, /in your picker<\/span>/);
  assert.match(html, /Models in your picker/);
  assert.doesNotMatch(html, /data-action="prov-remove" data-provider="openrouter"/);
  // Workers AI is binding-only: absent on Node.
  assert.doesNotMatch(html, /<span class="prov-name">Workers AI<\/span>/);
});

test('Settings validates a pasted key and collapses the row to a stored status', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-add-key', 'data-provider': 'openai' }) });
  assert.match(harness.app.innerHTML, /data-action="prov-validate" data-provider="openai"/);
  input({ target: inputTarget({ 'data-action': 'prov-key-input', 'data-provider': 'openai' }, 'sk-live-openai') });
  click({ target: actionTarget({ 'data-action': 'prov-validate', 'data-provider': 'openai' }) });
  await flushAsync();

  assert.deepEqual(harness.providerKeyPosts, [{ id: 'openai', key: 'sk-live-openai' }]);
  // The row collapsed: OpenAI now reports Stored with the primed model count.
  assert.match(harness.app.innerHTML, /<span class="prov-name">OpenAI<\/span>/);
  assert.match(harness.app.innerHTML, /Stored<\/span><span class="hint">Saved here · 2 models available<\/span>/);
});

test('Settings surfaces a rejected key verbatim in the raw-error block and stores nothing', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
    providerKeyReject: { status: 401, detail: 'authentication_error: invalid x-api-key' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-add-key', 'data-provider': 'anthropic' }) });
  input({ target: inputTarget({ 'data-action': 'prov-key-input', 'data-provider': 'anthropic' }, 'sk-ant-bad') });
  click({ target: actionTarget({ 'data-action': 'prov-validate', 'data-provider': 'anthropic' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /Anthropic rejected the key\. Nothing was stored/);
  assert.match(html, /<div class="raw-error">GET \/v1\/models → 401 authentication_error: invalid x-api-key<\/div>/);
  // Provider still Missing (nothing stored) and the paste field is still open.
  assert.match(html, /Missing<\/span>/);
});

test('Settings remove-key confirmation names the pinned profiles and the honest consequence', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    agents: [
      { id: 'agent_a', name: 'Support Triage', description: '', instructions: 'x', enabled: true, model: 'anthropic/claude-sonnet-4-6' },
      { id: 'agent_b', name: 'Release Scribe', description: '', instructions: 'x', enabled: true, model: 'anthropic/claude-haiku-4-5' },
      { id: 'agent_c', name: 'Ops', description: '', instructions: 'x', enabled: true, model: 'openai/gpt-4.1' },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-remove', 'data-provider': 'anthropic' }) });
  const html = harness.app.innerHTML;
  assert.match(html, /Remove the stored Anthropic key\?/);
  assert.match(html, /<b[^>]*>2 profiles<\/b> are pinned to an Anthropic model/);
  assert.match(html, /Support Triage/);
  assert.match(html, /Release Scribe/);
  assert.match(html, /the model provider call failed before completion/);
  assert.match(html, /ANTHROPIC_API_KEY<\/span> in the environment, if set, still applies/);
  assert.doesNotMatch(html, /Ops/); // the OpenAI-pinned profile is not implicated

  // Confirming removes the stored key.
  click({ target: actionTarget({ 'data-action': 'prov-remove-confirm', 'data-provider': 'anthropic' }) });
  await flushAsync();
  assert.deepEqual(harness.providerKeyDeletes, ['anthropic']);
});

test('Settings OpenRouter favorites manager searches, stars, and persists to the picker', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  // Two OpenRouter favorites render with ctx + input/output pricing metas.
  const html = harness.app.innerHTML;
  assert.match(html, /In your picker &middot; 2 starred/);
  assert.match(html, /<span class="fav-model">anthropic\/claude-sonnet-4<\/span><span class="fav-meta">200K ctx · <span class="price">\$3\.00 \/ \$15\.00<\/span> \/M<\/span>/);
  assert.match(html, /1M ctx/);

  // Typing filters the live list into the results container (unstarred matches only).
  input({ target: inputTarget({ 'data-action': 'fav-search', 'data-provider': 'openrouter' }, 'llama') });
  const results = harness.favContainers['fav-results-openrouter'];
  assert.ok(results);
  assert.match(results.innerHTML, /Results for &ldquo;llama&rdquo;/);
  assert.match(results.innerHTML, /meta-llama\/llama-3\.3-70b-instruct/);
  assert.match(results.innerHTML, /131K ctx/);

  // Starring the match persists the whole array and grows the picker group.
  click({ target: actionTarget({ 'data-action': 'fav-star', 'data-provider': 'openrouter', 'data-model': 'meta-llama/llama-3.3-70b-instruct' }) });
  await flushAsync();
  assert.equal(harness.favoritesPuts.length, 1);
  assert.deepEqual(harness.favoritesPuts[0], {
    id: 'openrouter',
    favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1', 'meta-llama/llama-3.3-70b-instruct'],
  });
  assert.match(harness.app.innerHTML, /In your picker &middot; 3 starred/);
});

test('Settings shows the Workers AI row on the Cloudflare target with no per-row metas', async () => {
  const harness = runAdminPageHarness({ cloudflare: true });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<span class="prov-name">Workers AI<\/span>/);
  assert.match(html, /Always available<\/span><span class="hint">Keyless · billed in Neurons/);
  assert.match(html, /via the Workers AI binding/);
  // Seed default renders as a starred favorite, provider-native, with NO meta.
  assert.match(html, /<span class="fav-model">@cf\/zai-org\/glm-5\.2<\/span><\/div>/);
  assert.match(html, /keep it starred to keep that default in the picker/);
});

test('the profile Model picker shows the node-unpinned pick-a-model prompt with the SLACK_TAG_MODEL note', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  // A blank profile has no pinned model. The Model field is now a click-to-open
  // combobox (F6): opening it renders the grouped popover. With no providers
  // configured the popover shows the pick-a-model prompt.
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /placeholder="Pick a model &mdash; none pinned"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  // The empty-ish combo carries the offline/dev fallback note and a Settings link.
  assert.match(html, /set <span class="mono"[^>]*>SLACK_TAG_MODEL<\/span>/);
  assert.match(html, /as an offline\/dev fallback so an unpinned profile still replies/);
  assert.match(html, /data-action="open-settings">Manage providers &amp; models in Settings &nearr;<\/button>/);
});

test('the profile Model picker labels Cloudflare binding suggestions as workers-ai', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'cloudflare',
        configured: true,
        source: 'Workers AI binding',
        suggestions: ['cloudflare/@cf/zai-org/glm-5.2'],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  // Opening the picker lazily loads the workers-ai favorites that drive the
  // binding group's options.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<div class="combo-group">workers-ai<span class="src">· Workers AI binding<\/span><\/div>/);
  assert.doesNotMatch(harness.app.innerHTML, /<div class="combo-group">cloudflare<span/);
  // The binding group's options carry the cloudflare/ specifier prefix, built
  // from the starred favorites (not the leaked src path or a raw @cf id).
  assert.match(harness.app.innerHTML, /data-model="cloudflare\/@cf\/zai-org\/glm-5\.2"/);
});

test('the profile Model picker renders the FULL live Anthropic list (Opus) with a user-facing source', async () => {
  const harness = runAdminPageHarness({
    // A stored Anthropic key: the runtime reports its source as the internal
    // "registered in src/app.ts" path, which must never leak to the UI.
    modelProviders: [
      {
        id: 'anthropic',
        configured: true,
        source: 'registered in src/app.ts',
        suggestions: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5'],
      },
    ],
    // The live /models list carries the full catalog — including Opus, which the
    // static 2-model suggestions omitted (the F5 bug this fixes).
    anthropicModels: [
      { id: 'claude-opus-4-1' },
      { id: 'claude-sonnet-4-6' },
      { id: 'claude-haiku-4-5' },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  // Opening the picker lazily loads the full Anthropic model list.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  // The group is labeled by provider id with a user-facing phrase — never the
  // leaked src path.
  assert.match(html, /<div class="combo-group">anthropic<span class="src">· via your key<\/span><\/div>/);
  assert.doesNotMatch(html, /registered in src\/app\.ts/);
  // Every live model renders as an anthropic/ specifier — Opus now appears.
  assert.match(html, /data-model="anthropic\/claude-opus-4-1"/);
  assert.match(html, /data-model="anthropic\/claude-sonnet-4-6"/);
  assert.match(html, /data-model="anthropic\/claude-haiku-4-5"/);
});

test('the profile Model picker filters options by the typed specifier', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'anthropic',
        configured: true,
        source: 'registered in src/app.ts',
        suggestions: ['anthropic/claude-sonnet-4-6'],
      },
    ],
    anthropicModels: [{ id: 'claude-opus-4-1' }, { id: 'claude-sonnet-4-6' }, { id: 'claude-haiku-4-5' }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click);
  assert.ok(input);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  // Typing "opus" narrows the open picker to matching specifiers only.
  input({ target: inputTarget({ 'data-action': 'profile-model' }, 'opus') });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, /data-model="anthropic\/claude-opus-4-1"/);
  assert.doesNotMatch(html, /data-model="anthropic\/claude-sonnet-4-6"/);
  assert.doesNotMatch(html, /data-model="anthropic\/claude-haiku-4-5"/);
});

test('the profile Model picker suppresses configured provider groups with no favorites', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'openrouter',
        configured: true,
        source: 'via OPENROUTER_API_KEY',
        suggestions: [],
      },
    ],
    // OpenRouter renders from starred favorites; with none starred its group is
    // suppressed even though the provider is configured.
    openrouterFavorites: [],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /<div class="combo-group">openrouter/);
  assert.doesNotMatch(harness.app.innerHTML, /no providers configured/);
  assert.match(harness.app.innerHTML, /Star models in Settings to add picker shortcuts/);
});

test('node-target Default seed is unpinned and its profile editor renders the pick-a-model prompt', async () => {
  const defaultProfile = seededAgents.find((agent) => agent.id === 'agent_default');
  assert.ok(defaultProfile);
  assert.equal(defaultProfile.model, undefined);

  const harness = runAdminPageHarness({
    agents: seededAgents,
    assignments: seededAssignments,
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_default' }) });
  // The seed's editor opens with an empty Model field; opening the combobox
  // proves the unpinned pick-a-model guidance renders in the popover.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /<h1 class="page-title">Default<\/h1>/);
  assert.match(html, /value="" autocomplete="off" role="combobox" aria-expanded="true" aria-haspopup="listbox" placeholder="Pick a model &mdash; none pinned"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  assert.match(html, /SLACK_TAG_MODEL/);
  assert.match(html, /as an offline\/dev fallback so an unpinned profile still replies/);
});
