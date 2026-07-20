import { createHash } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import * as v from 'valibot';

import { renderAdminLogin, renderAdminPage } from './page.ts';
// Build-time JSON import: the committed manifest is the single source of the
// Slack app identity; the wizard deep-link below substitutes the request host
// so users never hand-edit a request_url.
import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };
import {
  computeSnapshotHash,
  resolveEffectiveSlackConfig,
  type EffectiveSlackConfig,
} from '../config/effective-config.ts';
import {
  AgentExistsError,
  AgentStillAssignedError,
  ModelResolutionError,
  NoAssignmentError,
  UnknownAgentError,
} from '../config/errors.ts';
import { classifyMcpError, McpBlockedUrlError, mcpDebugText, safeMcpFailureText } from '../config/mcp-errors.ts';
import {
  buildMcpRequestHeaders,
  deleteMcpSecrets,
  describeMcpSecretSources,
  finishMcpSecretCleanup,
  mcpBearerSettingKey,
  mcpHeaderSettingKey,
  resolveMcpSecrets,
  saveMcpSecrets,
  stageMcpSecretCleanup,
  type ResolvedMcpSecrets,
} from '../config/mcp-secrets.ts';
import { discoverMcpTools, type McpConnectInput, type McpDiscoveryResult } from '../config/mcp-test.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import { resolveAgentModel, type ModelResolvableAgent } from '../config/model-policy.ts';
import {
  applyResolvedProviderKeys,
  deleteProviderApiKey,
  describeProviderKeySources,
  isProviderKeyId,
  PROVIDER_KEY_IDS,
  resolveProviderApiKey,
  saveProviderApiKey,
  type ProviderKeySource,
} from '../config/provider-keys.ts';
import {
  cachedProviderModelCount,
  getProviderFavorites,
  isAdminProviderId,
  isFavoriteProviderId,
  listProviderModels,
  primeProviderModelCache,
  ProviderKeyRejectedError,
  ProviderModelsUnavailableError,
  ProviderUnreachableError,
  putProviderFavorites,
  validateProviderApiKey,
  type AdminProviderId,
} from '../config/provider-models.ts';
import { knownProviderIds, listRuntimeModelProviders } from '../config/providers.ts';
import { parseSkillSource, resolveSkillSource, SkillImportError } from '../config/skill-import.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getSettingsStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../config/types.ts';
import { listSlackChannels, SlackChannelsError } from '../slack/channels.ts';
import {
  describeSlackCredentialSources,
  primeStoredSlackCredentials,
  readStoredSlackTeamInfo,
  resolveSlackCredentials,
  resolveSlackTeamInfo,
  primeStoredSlackPublicUrl,
  slackAuthTest,
  slackConversationsInfo,
  slackConversationsJoin,
  slackTokenFingerprint,
  SLACK_SETTING_KEYS,
  type SlackTeamInfo,
} from '../slack/credentials.ts';
import { constantTimeEquals } from '../slack/internal-auth.ts';

interface AdminRoutesOptions {
  // Injection seam for tests/harnesses: any async ConfigStore serves the
  // routes; absent, the platform backend is resolved per request (c.env is the
  // Cloudflare bindings object there; Node ignores it).
  store?: ConfigStore | undefined;
  // Same seam for the Slack-connection wizard's settings persistence.
  settings?: SettingsStore | undefined;
  adminToken?: string | undefined;
  knownProviders?: ReadonlySet<string> | undefined;
  // Injection seam for the MCP test-connection route, mirroring how the skills
  // resolve route takes a resolver: tests pass a mock so no real network
  // connect is attempted; production uses the shared discover routine.
  discoverMcp?: ((input: McpConnectInput) => Promise<McpDiscoveryResult>) | undefined;
}

const ADMIN_COOKIE = 'flue_admin';
const MAX_ADMIN_LOGIN_BODY_BYTES = 4_096;

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const MCP_CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const agentIdSchema = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));

// A profile skill. `name` must satisfy Flue's `defineSkill` rule so a stored
// row can never become a turn-killing validation throw at runtime; description
// and instructions are bounded to keep a skill focused and the prompt sane.
const skillName = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits, and single hyphens only'),
  v.maxLength(64),
);
const skillSchema = v.object({
  name: skillName,
  // Trim before the non-empty check so a whitespace-only value can't pass the
  // write boundary yet throw at defineSkill (which trims) and be silently
  // skipped at turn time. The stored value is the normalized one.
  description: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(1024)),
  instructions: v.pipe(v.string(), v.trim(), v.minLength(1)),
  enabled: v.boolean(),
});
// Reject duplicate names at the write boundary — duplicates are a turn-killer
// downstream, so they must never reach the store.
const skillsSchema = v.pipe(
  v.array(skillSchema),
  v.check(
    (skills) => new Set(skills.map((skill) => skill.name)).size === skills.length,
    'skill names must be unique',
  ),
);

// A single discovered-tool record stored on a Connection's last successful
// test. Bounded to keep the profile row small (matches types.ts limits).
const mcpToolInfoSchema = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  title: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(160))),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
});

// A profile Connection (remote MCP server) — POLICY ONLY. No token/header-value
// fields exist by construction, so a secrets-shaped payload can never smuggle a
// value into the profile row. The v.check runs the same SSRF guard as turn time,
// so a private/blocked URL is refused at the write boundary too.
const mcpServerSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.regex(MCP_CONNECTION_ID_PATTERN)),
    displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
    url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
    transport: v.picklist(['streamable-http', 'sse']),
    authMode: v.picklist(['none', 'bearer']),
    headerNames: v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/))),
    enabled: v.boolean(),
    lifecycleStatus: v.picklist(['pending', 'ready', 'failed']),
    statusText: v.pipe(v.string(), v.maxLength(300)),
    discoveredTools: v.pipe(v.array(mcpToolInfoSchema), v.maxLength(50)),
    allowedTools: v.pipe(
      v.array(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
      v.maxLength(50),
    ),
    lastCheckedAt: v.optional(v.number()),
    presetId: v.optional(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]{0,63}$/), v.maxLength(64))),
  }),
  v.check((s) => validateMcpUrl(s.url).ok, 'URL not allowed'),
);

// Reject duplicate connection ids at the write boundary — a per-profile id must
// be unique because it becomes the `mcp__<id>__` tool prefix (and the
// profile-scoped secret-key suffix). Mirrors the unique-skill-names check.
const mcpServersSchema = v.pipe(
  v.array(mcpServerSchema),
  v.check(
    (servers) => new Set(servers.map((server) => server.id)).size === servers.length,
    'connection ids must be unique',
  ),
);

const agentSchema = v.object({
  id: agentIdSchema,
  name: nonEmptyString,
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  skills: v.optional(skillsSchema, []),
  mcpServers: v.optional(mcpServersSchema, []),
});

const agentPatchSchema = v.partial(
  v.object({
    name: nonEmptyString,
    instructions: nonEmptyString,
    enabled: v.boolean(),
    model: v.nullable(modelSpecifier),
    skills: skillsSchema,
    mcpServers: mcpServersSchema,
  }),
);

// Test-connection payload: the UNSAVED form. Secrets are transient (never
// persisted here) and merged over stored/env at handler time.
const mcpTestSchema = v.object({
  id: v.pipe(v.string(), v.regex(MCP_CONNECTION_ID_PATTERN)),
  url: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
  transport: v.picklist(['streamable-http', 'sse']),
  authMode: v.picklist(['none', 'bearer']),
  bearerToken: v.optional(v.string()),
  // KEYS validated like headerNames — a raw key with ':' or CR/LF would throw
  // deep inside new Headers() and read as a misleading connect failure.
  headers: v.optional(v.record(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)), v.string())),
  // The connection's known header names, so re-testing an existing connection
  // resolves STORED header values even when the operator didn't re-type them
  // (the client seeds those fields blank). Typed values in `headers` still win.
  headerNames: v.optional(v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/)))),
});

// Secrets PUT payload — values plus the header NAMES they map to (the settings
// store has no prefix scan, so delete/describe need the name list).
const headerNameSchema = v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/));

const mcpSecretsPutSchema = v.object({
  bearerToken: v.optional(v.string()),
  // Record KEYS are header names and get the same validation as headerNames —
  // an unvalidated key with ':' or CR/LF would explode later in new Headers().
  headers: v.optional(v.record(headerNameSchema, v.string())),
  headerNames: v.array(headerNameSchema),
  // Cleanup of orphans: header names removed/renamed in the editor, and a
  // bearer -> none switch, delete their stored settings instead of leaving
  // dead secrets behind under keys nothing references anymore.
  removeHeaderNames: v.optional(v.array(headerNameSchema)),
  clearBearer: v.optional(v.boolean()),
});

const mcpSecretsDeleteSchema = v.object({
  headerNames: v.array(v.pipe(v.string(), v.trim(), v.regex(/^[A-Za-z0-9-]{1,128}$/))),
});

const assignmentSchema = v.object({
  workspaceId: nonEmptyString,
  channelId: nonEmptyString,
  agentId: nonEmptyString,
  enabled: v.boolean(),
  channelLabel: v.optional(v.string()),
  channelPromptAddendum: v.optional(v.string()),
});

const slackConnectionSchema = v.object({
  botToken: nonEmptyString,
  signingSecret: nonEmptyString,
});

export function createAdminRoutes(options: AdminRoutesOptions = {}): Hono {
  const app = new Hono();
  const tokenFromOptions = Object.hasOwn(options, 'adminToken');
  const store = (c: Context) => options.store ?? getConfigStore(c.env as PlatformEnv | undefined);
  const settings = (c: Context) =>
    options.settings ?? getSettingsStore(c.env as PlatformEnv | undefined);
  const adminToken = () =>
    tokenFromOptions ? options.adminToken : process.env.TAG_ADMIN_TOKEN;
  const modelProviders = () =>
    options.knownProviders
      ? listRuntimeModelProviders({ registeredProviders: options.knownProviders })
      : listRuntimeModelProviders();
  const providerIds = () => options.knownProviders ?? knownProviderIds();
  // Default to the shared connect+discover routine; tests inject a mock so no
  // real network connect is attempted (same seam idea as the store/settings).
  const discoverMcp = (input: McpConnectInput): Promise<McpDiscoveryResult> =>
    (options.discoverMcp ?? discoverMcpTools)(input);
  const adminLoginBodyLimit = bodyLimit({
    maxSize: MAX_ADMIN_LOGIN_BODY_BYTES,
    onError: (c) =>
      c.html(renderAdminLogin({ invalidToken: true, returnTo: '/admin' }), 401),
  });

  const adminGate = async (c: Context, next: Next) => {
    const expected = adminToken();
    if (!expected) {
      return c.notFound();
    }

    // The cookie carries a hash of the token, never the token itself: a captured
    // cookie can't be replayed as a Bearer credential and doesn't reveal
    // TAG_ADMIN_TOKEN. The raw browser token exists only in the POST body, never
    // in a URL that access logs, browser history, or referrers can retain.
    const cookieValue = cookieTokenFor(expected);

    if (isAdminLoginPost(c)) {
      const login = await readAdminLogin(c);
      if (!constantTimeEquals(login.token, expected)) {
        return c.html(
          renderAdminLogin({ invalidToken: true, returnTo: login.returnTo }),
          401,
        );
      }
      setAdminCookie(c, cookieValue);
      return c.redirect(login.returnTo, 303);
    }

    const candidate = bearerToken(c.req.header('authorization'));
    if (candidate !== undefined) {
      if (!constantTimeEquals(candidate, expected)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return next();
    }

    if (!constantTimeEquals(getCookie(c, ADMIN_COOKIE), cookieValue)) {
      // A browser navigating to an /admin page with no valid session gets a
      // minimal POST token-entry form instead of a bare JSON 401. XHR and
      // /admin/api/* callers still get the JSON 401 they can handle. Kept at
      // 401 (not 200) so it is never cached as a real page.
      if (isAdminPageGet(c)) {
        return c.html(
          renderAdminLogin({ returnTo: safeAdminReturnPath(c.req.path) }),
          401,
        );
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };

  const setAdminCookie = (c: Context, cookieValue: string): void => {
    setCookie(c, ADMIN_COOKIE, cookieValue, {
      path: '/admin',
      httpOnly: true,
      sameSite: 'Lax',
      // Send only over TLS when the request arrived over TLS; on plain-http
      // dev there is no transport to protect, so forcing Secure would just
      // drop the cookie and break login.
      secure: isHttps(c),
    });
  };

  // The worker's root is not a product surface — send visitors to the admin
  // (the gate/login there handles auth). Bare 404 at `/` read as a broken
  // install during live testing.
  app.get('/', (c) => c.redirect('/admin', 302));

  // Apply the byte cap before the unauthenticated body is buffered. Keep the
  // missing-token 404 contract by letting adminGate handle disabled admin UI.
  app.use('/admin/login', (c, next) =>
    adminToken() ? adminLoginBodyLimit(c, next) : next(),
  );
  app.use('/admin', adminGate);
  app.use('/admin/*', adminGate);
  app.use('/admin/api/*', async (c, next) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    await applyResolvedProviderKeys(platformEnv, settingsStore);
    // Opportunistically pin the resolved origin so the Slack "Configure" deep
    // link works even on a button deploy that never set SLACK_TAG_PUBLIC_URL,
    // and even when creds arrived via env. No-op on the steady state.
    await persistRequestOrigin(c, settingsStore);
    return next();
  });

  app.get('/admin', (c) => c.html(renderAdminPage()));

  app.get('/admin/api/agents', async (c) => c.json({ agents: await store(c).listAgents() }));

  // The profile picker's single source of provider groups + suggestions. Anthropic
  // and OpenAI keep their small dynamic catalogs; OpenRouter and the keyless
  // Workers AI binding show ONLY the user's starred favorites (curated in the
  // Settings managers), so this route folds those favorites into their
  // suggestions — the per-provider search/favorites endpoints stay the editors.
  app.get('/admin/api/models', async (c) => {
    const settingsStore = settings(c);
    const providers = await Promise.all(
      modelProviders().map(async (provider) => {
        if (provider.id === 'openrouter') {
          const favorites = await getProviderFavorites('openrouter', settingsStore);
          return { ...provider, suggestions: favorites.map((model) => `openrouter/${model}`) };
        }
        // The binding-backed CF provider surfaces as `cloudflare`; its favorites
        // live under the `workers-ai` key and pin as `cloudflare/<model>`.
        if (provider.id === 'cloudflare') {
          const favorites = await getProviderFavorites('workers-ai', settingsStore);
          return { ...provider, suggestions: favorites.map((model) => `cloudflare/${model}`) };
        }
        return provider;
      }),
    );
    return c.json({ providers });
  });

  app.get('/admin/api/providers', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const sources = await describeProviderKeySources(platformEnv, settingsStore);
    return c.json({
      providers: [
        ...PROVIDER_KEY_IDS.map((id) => providerSummary(id, sources[id])),
        providerSummary('workers-ai', workersAiStatus(platformEnv)),
      ],
    });
  });

  app.post('/admin/api/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!isProviderKeyId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const apiKey = providerApiKeyFromBody(await readJson(c.req));
    if (!apiKey) {
      return invalidRequest(c);
    }

    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const current = await resolveProviderApiKey(id, platformEnv, settingsStore);
    if (current.source === 'env') {
      return c.json({ error: 'provider_key_read_only', provider: id }, 409);
    }

    try {
      const models = await validateProviderApiKey(id, apiKey);
      await saveProviderApiKey(id, apiKey, platformEnv, settingsStore);
      primeProviderModelCache(id, models);
      return c.json({
        ok: true,
        provider: providerSummary(id, 'stored'),
        models,
      });
    } catch (err) {
      if (err instanceof ProviderKeyRejectedError) {
        return c.json(
          {
            error: 'provider_key_rejected',
            provider: err.provider,
            status: err.status,
            detail: err.detail,
          },
          422,
        );
      }
      if (err instanceof ProviderUnreachableError) {
        return c.json({ error: 'provider_unreachable', provider: err.provider }, 502);
      }
      if (err instanceof ProviderModelsUnavailableError) {
        return c.json({ error: err.code, provider: err.provider }, 502);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/providers/:id/key', async (c) => {
    const id = c.req.param('id');
    if (!isProviderKeyId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const platformEnv = c.env as PlatformEnv | undefined;
    const resolved = await deleteProviderApiKey(id, platformEnv, settings(c));
    return c.json({
      ok: true,
      provider: providerSummary(id, resolved.source),
      pinnedProfileCount: await countPinnedProfiles(store(c), id),
    });
  });

  app.get('/admin/api/providers/:id/models', async (c) => {
    const id = c.req.param('id');
    if (!isAdminProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    try {
      const platformEnv = c.env as PlatformEnv | undefined;
      const result = await listProviderModels(id, {
        store: settings(c),
        refresh: c.req.query('refresh') === '1',
        ...(platformEnv !== undefined ? { env: platformEnv } : {}),
      });
      return c.json({ provider: id, models: result.models, cached: result.cached });
    } catch (err) {
      if (err instanceof ProviderModelsUnavailableError) {
        return c.json({ error: err.code, provider: err.provider }, err.status as 409 | 502);
      }
      if (err instanceof ProviderUnreachableError) {
        return c.json({ error: 'provider_unreachable', provider: err.provider }, 502);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/providers/:id/favorites', async (c) => {
    const id = c.req.param('id');
    if (!isFavoriteProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    return c.json({ provider: id, favorites: await getProviderFavorites(id, settings(c)) });
  });

  app.put('/admin/api/providers/:id/favorites', async (c) => {
    const id = c.req.param('id');
    if (!isFavoriteProviderId(id)) {
      return c.json({ error: 'unknown_provider' }, 404);
    }
    const favorites = providerFavoritesFromBody(await readJson(c.req));
    if (!favorites) {
      return invalidRequest(c);
    }
    return c.json({
      provider: id,
      favorites: await putProviderFavorites(id, favorites, settings(c)),
    });
  });

  app.post('/admin/api/agents', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const agent = toAgentConfig(parsed.output);
    const modelError = modelResolutionError(agent);
    if (modelError) {
      return modelNotResolvable(c, modelError);
    }
    try {
      const configStore = store(c);
      return c.json(
        {
          agent: await configStore.createAgent(agent),
          ...providerWarnings(agent.model, providerIds()),
        },
        201,
      );
    } catch (err) {
      if (err instanceof AgentExistsError) {
        return c.json({ error: 'agent_exists' }, 409);
      }
      return internalError(c, err);
    }
  });

  // Resolve a pasted GitHub repo / skills.sh link into importable skill
  // candidates (Phase 3). Read-only: the operator picks in the UI and the
  // selected skills persist via the normal agent PATCH (the skills column).
  app.post('/admin/api/skills/resolve', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(v.object({ source: nonEmptyString }), body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const source = parseSkillSource(parsed.output.source);
    if (!source) {
      return c.json({ error: 'unrecognized_source' }, 400);
    }
    const token = process.env.GITHUB_TOKEN?.trim() || undefined;
    try {
      const resolution = await resolveSkillSource(source, fetch, token);
      return c.json({ resolution });
    } catch (err) {
      if (err instanceof SkillImportError) {
        return c.json({ error: err.code, message: err.message }, 502);
      }
      return internalError(c, err);
    }
  });

  // Test an unsaved Connection form: connect + list tools without persisting
  // anything. A schema-invalid body is a 400; every OTHER outcome (blocked URL,
  // unauthorized, timeout, ...) is HTTP 200 with a classified `{ ok: false }`
  // envelope — the client renders the safe message inline, and a raw error
  // string (which could leak internals) never crosses this boundary.
  app.post('/admin/api/agents/:agentId/mcp/test', async (c) => {
    const agentId = c.req.param('agentId');
    if (!AGENT_ID_PATTERN.test(agentId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpTestSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const validated = validateMcpUrl(input.url);
    if (!validated.ok) {
      // Never even attempt a connect to a blocked target: classify the SSRF
      // rejection into the same envelope shape as a runtime failure.
      const err = new McpBlockedUrlError(validated.reason);
      return c.json({ ok: false, code: classifyMcpError(err), message: safeMcpFailureText(err) });
    }

    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    // Start from stored/env secrets for this profile-local connection, then let
    // any value typed into the unsaved form win — the operator is testing
    // exactly what they typed.
    const resolved = await resolveMcpSecrets(
      { agentId, connectionId: input.id },
      // Union of the connection's known header names and any typed this session,
      // so a stored value backs a header the operator didn't re-enter.
      [...new Set([...(input.headerNames ?? []), ...Object.keys(input.headers ?? {})])],
      platformEnv,
      settingsStore,
    );
    const merged: ResolvedMcpSecrets = {
      ...(input.bearerToken !== undefined ? { bearer: input.bearerToken } : {}),
      headers: { ...resolved.headers, ...(input.headers ?? {}) },
    };
    if (input.bearerToken === undefined && resolved.bearer !== undefined) {
      merged.bearer = resolved.bearer;
    }
    const headers = buildMcpRequestHeaders(input.authMode, merged);

    try {
      const result = await discoverMcp({
        id: input.id,
        url: validated.url,
        transport: input.transport,
        headers,
      });
      return c.json({ ok: true, tools: result.tools });
    } catch (err) {
      // Classify first — err.message may carry raw internals and must never be
      // returned to the client. The log line keeps the bounded debug text so a
      // failing Test connection is diagnosable from observability.
      console.warn('[chickpea] MCP test failed (' + input.id + '): ' + mcpDebugText(err));
      return c.json({ ok: false, code: classifyMcpError(err), message: safeMcpFailureText(err) });
    }
  });

  // Store a Connection's secrets by reference (never in the profile row). The
  // response reports source only (`env`/`stored`/`missing`) — values are never
  // echoed back. The profile PATCH path never touches settings; this is the one
  // secret-write choke point alongside DELETE below.
  app.put('/admin/api/agents/:agentId/mcp/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpSecretsPutSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const platformEnv = c.env as PlatformEnv | undefined;
    const configStore = store(c);
    const settingsStore = settings(c);
    const ref = { agentId, connectionId };
    let connection: CustomAgentConfig['mcpServers'][number] | undefined;
    try {
      connection = (await configStore.getAgent(agentId)).mcpServers.find(
        (server) => server.id === connectionId,
      );
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
    if (!connection) {
      return c.json({ error: 'not_found' }, 404);
    }

    const writtenHeaderNames = Object.keys(input.headers ?? {});
    const allowedHeaderNames = new Set(connection.headerNames);
    if (writtenHeaderNames.some((name) => !allowedHeaderNames.has(name))) {
      return invalidRequest(c);
    }
    const cleanupHeaderNames = [
      ...new Set([...connection.headerNames, ...(input.removeHeaderNames ?? [])]),
    ];
    await stageMcpSecretCleanup(
      agentId,
      [
        mcpBearerSettingKey(ref),
        ...cleanupHeaderNames.map((name) => mcpHeaderSettingKey(ref, name)),
      ],
      settingsStore,
    );
    await saveMcpSecrets(
      ref,
      {
        ...(input.bearerToken !== undefined ? { bearerToken: input.bearerToken } : {}),
        ...(input.headers !== undefined ? { headers: input.headers } : {}),
      },
      platformEnv,
      settingsStore,
    );
    if (input.clearBearer) {
      await settingsStore.deleteSetting(mcpBearerSettingKey(ref));
    }
    for (const name of input.removeHeaderNames ?? []) {
      await settingsStore.deleteSetting(mcpHeaderSettingKey(ref, name));
    }

    let currentConnection: CustomAgentConfig['mcpServers'][number] | undefined;
    try {
      currentConnection = (await configStore.getAgent(agentId)).mcpServers.find(
        (server) => server.id === connectionId,
      );
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) {
        return internalError(c, err);
      }
      try {
        // The profile disappeared after the pre-write check. Remove this
        // connection explicitly in case a concurrent profile cleanup consumed
        // the marker just before these writes landed, then finish any marker
        // that remains for the rest of the deleted profile.
        await deleteMcpSecrets(ref, cleanupHeaderNames, platformEnv, settingsStore);
        await finishMcpSecretCleanup(agentId, settingsStore);
        return c.json({ error: 'not_found' }, 404);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
    }
    if (!currentConnection) {
      try {
        await deleteMcpSecrets(ref, cleanupHeaderNames, platformEnv, settingsStore);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
      return c.json({ error: 'not_found' }, 404);
    }
    const currentHeaderNames = new Set(currentConnection.headerNames);
    const headersRemovedDuringWrite = writtenHeaderNames.filter(
      (name) => !currentHeaderNames.has(name),
    );
    if (headersRemovedDuringWrite.length > 0) {
      for (const name of headersRemovedDuringWrite) {
        await settingsStore.deleteSetting(mcpHeaderSettingKey(ref, name));
      }
      return c.json({ error: 'connection_changed' }, 409);
    }

    const sources = await describeMcpSecretSources(ref, input.headerNames, platformEnv, settingsStore);
    return c.json(sources);
  });

  app.delete('/admin/api/agents/:agentId/mcp/secrets/:connectionId', async (c) => {
    const agentId = c.req.param('agentId');
    const connectionId = c.req.param('connectionId');
    if (!AGENT_ID_PATTERN.test(agentId) || !MCP_CONNECTION_ID_PATTERN.test(connectionId)) {
      return invalidRequest(c);
    }
    const body = await readJson(c.req);
    const parsed = v.safeParse(mcpSecretsDeleteSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const platformEnv = c.env as PlatformEnv | undefined;
    await deleteMcpSecrets(
      { agentId, connectionId },
      parsed.output.headerNames,
      platformEnv,
      settings(c),
    );
    return c.json({ ok: true });
  });

  app.get('/admin/api/agents/:id', async (c) => {
    try {
      return c.json({ agent: await store(c).getAgent(c.req.param('id')) });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.patch('/admin/api/agents/:id', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      const configStore = store(c);
      const agentId = c.req.param('id');
      const current = await configStore.getAgent(agentId);
      const patch = toAgentPatch(parsed.output);
      const next: ModelResolvableAgent = {
        ...current,
        ...patch,
        id: agentId,
      };
      const modelError = modelResolutionError(next);
      if (modelError) {
        return modelNotResolvable(c, modelError);
      }
      return c.json({
        agent: await configStore.updateAgent(agentId, patch),
        ...providerWarnings(next.model, providerIds()),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/agents/:id', async (c) => {
    const configStore = store(c);
    const agentId = c.req.param('id');
    let agent: CustomAgentConfig;
    try {
      agent = await configStore.getAgent(agentId);
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) {
        return internalError(c, err);
      }
      try {
        const resumed = await finishMcpSecretCleanup(agentId, settings(c));
        return resumed ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
      } catch (cleanupError) {
        return internalError(c, cleanupError);
      }
    }

    const references = await configStore.listAssignmentsForAgent(agentId);
    if (references.length > 0) {
      return c.json(
        {
          error: 'agent_still_assigned',
          assignments: references.map(({ workspaceId, channelId }) => ({ workspaceId, channelId })),
        },
        409,
      );
    }
    // Persist the cleanup inventory before deleting the profile. The marker is
    // independent of the config row, so settings cleanup can be retried after a
    // partial failure or an ambiguous DO/RPC response where the delete committed
    // but the caller only observed an error.
    const settingsStore = settings(c);
    const secretKeys = new Set<string>();
    for (const server of agent.mcpServers) {
      const ref = { agentId, connectionId: server.id };
      secretKeys.add(mcpBearerSettingKey(ref));
      for (const name of server.headerNames) {
        secretKeys.add(mcpHeaderSettingKey(ref, name));
      }
    }
    try {
      await stageMcpSecretCleanup(agentId, [...secretKeys], settingsStore);
    } catch (err) {
      return internalError(c, err);
    }

    try {
      // A false return means another request removed the row after our initial
      // read. Either way the profile is absent and the staged cleanup is safe.
      await configStore.deleteAgent(agentId);
    } catch (err) {
      try {
        await configStore.getAgent(agentId);
      } catch (inspectionError) {
        if (inspectionError instanceof UnknownAgentError) {
          // The delete committed but its response was lost. Continue using the
          // durable marker rather than restoring secrets into an orphaned scope.
          try {
            await finishMcpSecretCleanup(agentId, settingsStore);
            return c.body(null, 204);
          } catch (cleanupError) {
            return internalError(c, cleanupError);
          }
        }
        return internalError(c, inspectionError);
      }
      if (err instanceof AgentStillAssignedError) {
        return c.json({ error: 'agent_still_assigned' }, 409);
      }
      return internalError(c, err);
    }

    try {
      await finishMcpSecretCleanup(agentId, settingsStore);
      return c.body(null, 204);
    } catch (err) {
      return internalError(c, err);
    }
  });

  app.get('/admin/api/assignments', async (c) => {
    if (!c.req.query('workspaceId') && !c.req.query('channelId')) {
      return c.json({ assignments: await store(c).listAssignments() });
    }
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const assignment = await store(c).getAssignment(key.workspaceId, key.channelId);
    return assignment ? c.json({ assignment }) : c.json({ error: 'not_found' }, 404);
  });

  app.put('/admin/api/assignments', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(assignmentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const input = parsed.output;
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);

    // Slack validation guards EVERY assignment path (this API is the one choke
    // point), but only when a bot token is resolvable AND the target is a
    // concrete workspace+channel. Wildcards ('*') are scope rules, not real
    // channels, and a credential-less (offline/dev) install keeps the exact
    // pre-validation behavior so those setups and tests never break.
    const { botToken } = await resolveSlackCredentials(platformEnv, settingsStore);
    const isWildcard = input.workspaceId === '*' || input.channelId === '*';

    let isMember: boolean | undefined;
    let joined: boolean | undefined;
    let authoritativeLabel: string | undefined;
    if (botToken && !isWildcard) {
      const teamInfo = await resolveTeamInfoSafely(platformEnv, settingsStore);
      // (a) The channel must live in the CONNECTED workspace. Without this
      //     check, a channel id copied from another workspace could be accepted
      //     even though the configured bot can never reach it.
      if (teamInfo.teamId && input.workspaceId !== teamInfo.teamId) {
        return c.json(
          {
            error: 'workspace_mismatch',
            message: workspaceMismatchMessage(teamInfo, input.workspaceId),
            connectedTeamId: teamInfo.teamId,
            connectedTeamName: teamInfo.teamName ?? null,
          },
          400,
        );
      }
      // (b) The channel must actually exist in that workspace. A typo, a
      //     wrong-workspace id, or a private channel the bot was never invited
      //     to all surface here as channel_not_found.
      let info;
      try {
        info = await slackConversationsInfo(botToken, input.channelId);
      } catch {
        // Slack unreachable: do not hard-fail an operator edit on a transient
        // outage — skip verification and save what we can.
        info = undefined;
      }
      if (info && !info.ok && info.error === 'channel_not_found') {
        return c.json(
          {
            error: 'channel_not_found',
            message: channelNotFoundMessage(input.channelId, teamInfo),
          },
          400,
        );
      }
      if (info?.ok && info.channel) {
        // (c) Membership drives the UI's "invite @Tag or it never hears
        //     mentions" reminder; Slack's authoritative name becomes the label.
        isMember = info.channel.isMember;
        if (info.channel.name) {
          authoritativeLabel = info.channel.name;
        }
        // (d) A bot CAN self-join a PUBLIC channel it is not yet in (via the
        //     channels:join scope) — do it now so the operator does not have to
        //     switch to Slack and invite it. A PRIVATE channel cannot be
        //     self-joined (Slack forbids it), so it keeps the invite reminder.
        //     Any failure — missing_scope on installs that predate the scope, a
        //     transient error — is graceful: the assignment still saves and the
        //     invite reminder still shows. The join must never fail the save.
        if (isMember === false && info.channel.isPrivate === false) {
          try {
            const join = await slackConversationsJoin(botToken, input.channelId);
            if (join.ok) {
              isMember = true;
              joined = true;
            }
          } catch {
            // Slack unreachable mid-join: leave isMember false so the invite
            // reminder shows; the save proceeds regardless.
          }
        }
      }
    }

    const assignment = toAssignment(input);
    if (authoritativeLabel !== undefined) {
      assignment.channelLabel = authoritativeLabel;
    }
    try {
      const saved = await store(c).putAssignment(assignment);
      return c.json({
        assignment: saved,
        ...(isMember !== undefined ? { isMember } : {}),
        ...(joined !== undefined ? { joined } : {}),
      });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown_agent' }, 404);
      }
      return internalError(c, err);
    }
  });

  // Server-side channel picker source for the Add-channel form: the browser
  // never touches a Slack token. Cursor-paginated + cached in-isolate (see
  // channels.ts); ?refresh=1 bypasses after the operator invites the bot to a
  // new channel. Fails closed with a clear envelope when Slack is not connected.
  app.get('/admin/api/slack-channels', async (c) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const settingsStore = settings(c);
    const { botToken } = await resolveSlackCredentials(platformEnv, settingsStore);
    if (!botToken) {
      return c.json({ error: 'slack_not_configured' }, 409);
    }
    const teamInfo = await resolveTeamInfoSafely(platformEnv, settingsStore);
    try {
      const { channels, truncated } = await listSlackChannels(botToken, {
        refresh: c.req.query('refresh') === '1',
      });
      return c.json({
        channels,
        teamId: teamInfo.teamId ?? null,
        teamName: teamInfo.teamName ?? null,
        truncated,
      });
    } catch (err) {
      if (err instanceof SlackChannelsError) {
        // A live Slack rejection (invalid_auth, missing_scope, ...): surface it
        // as a clear 502 envelope rather than a bare internal error.
        return c.json({ error: 'slack_list_failed', detail: err.slackError }, 502);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/assignments', async (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const deleted = await store(c).deleteAssignment(key.workspaceId, key.channelId);
    return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  app.get('/admin/api/effective-config', async (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    try {
      const configStore = store(c);
      return c.json({
        config: effectiveConfigResponse(
          await resolveEffectiveSlackConfig(key.workspaceId, key.channelId, {
            agents: configStore,
            assignments: configStore,
          }),
        ),
      });
    } catch (err) {
      if (err instanceof NoAssignmentError || err instanceof UnknownAgentError) {
        return c.json({ error: 'not_found' }, 404);
      }
      if (err instanceof ModelResolutionError) {
        return modelNotResolvable(c, err);
      }
      return internalError(c, err);
    }
  });

  // First-run Slack-connection wizard state: per-credential provenance
  // (env > stored > missing) plus the manifest deep-link with this install's
  // events URL substituted server-side — the one setup step every Slack bot
  // makes users do by hand. Passing the settings store explicitly bypasses
  // the resolver's 60s cache, so the card always shows fresh provenance.
  app.get('/admin/api/slack-connection', async (c) => {
    try {
      const settingsStore = settings(c);
      const credentials = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settingsStore,
      );
      // STORED-only (no network on admin load): the connected workspace name is
      // populated by the wizard save for new installs, and by the first
      // channels-list / assignment backfill for pre-existing ones.
      const teamInfo = await readStoredSlackTeamInfo(c.env as PlatformEnv | undefined, settingsStore);
      const requestUrl = `${requestOrigin(c)}/channels/slack/events`;
      return c.json({
        credentials,
        // Connected = both wire credentials resolvable somewhere. The bot
        // user id is not required for a connection (it resolves via
        // auth.test at event time when absent).
        connected: credentials.botToken !== 'missing' && credentials.signingSecret !== 'missing',
        teamId: teamInfo.teamId ?? null,
        teamName: teamInfo.teamName ?? null,
        requestUrl,
        manifestUrl: slackManifestUrl(requestOrigin(c)),
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  // Wizard paste-back: validate the bot token LIVE via auth.test (so the
  // paste feels instant and verified), then persist token + signing secret +
  // the auth.test bot user id in the settings store. Environment values keep
  // precedence at resolution time, so storing while env creds exist is
  // harmless. The signing secret cannot be pre-validated — Slack only proves
  // it on the first signed event; the response says so.
  app.post('/admin/api/slack-connection', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(slackConnectionSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    // Trim and require non-empty AFTER trimming: a whitespace-only value clears
    // the schema's min-length but would store as empty and resolve back as
    // 'missing', so reject it as an invalid request before touching Slack.
    const botToken = parsed.output.botToken.trim();
    const signingSecret = parsed.output.signingSecret.trim();
    if (!botToken || !signingSecret) {
      return invalidRequest(c);
    }
    let auth;
    try {
      auth = await slackAuthTest(botToken);
    } catch (err) {
      // Distinct from a rejected token: Slack (or the SLACK_API_URL override)
      // could not be reached at all — retriable, nothing stored.
      console.error(
        '[chickpea] wizard auth.test unreachable:',
        err instanceof Error ? err.message : String(err),
      );
      return c.json({ error: 'slack_unreachable' }, 502);
    }
    if (!auth.ok) {
      return c.json(
        { error: 'slack_auth_failed', ...(auth.error ? { detail: auth.error } : {}) },
        422,
      );
    }
    try {
      const settingsStore = settings(c);
      await settingsStore.setSetting(SLACK_SETTING_KEYS.botToken, botToken);
      await settingsStore.setSetting(SLACK_SETTING_KEYS.signingSecret, signingSecret);
      if (auth.botUserId) {
        await settingsStore.setSetting(SLACK_SETTING_KEYS.botUserId, auth.botUserId);
      }
      // Persist the connected workspace identity from the same auth.test: the
      // admin names the workspace, and the assignment PUT rejects channels from
      // any OTHER workspace against this stored team id.
      if (auth.teamId) {
        await settingsStore.setSetting(SLACK_SETTING_KEYS.teamId, auth.teamId);
        // Bind the team identity to the token that earned it: a later env
        // token pointing elsewhere must invalidate this id, not inherit it.
        await settingsStore.setSetting(
          SLACK_SETTING_KEYS.teamTokenFingerprint,
          slackTokenFingerprint(botToken),
        );
      }
      if (auth.teamName) {
        await settingsStore.setSetting(SLACK_SETTING_KEYS.teamName, auth.teamName);
      }
      // Prime the resolver cache in THIS isolate so the very next signed
      // event verifies with the just-stored secret instead of waiting out
      // the cache TTL.
      primeStoredSlackCredentials({
        botToken,
        signingSecret,
        botUserId: auth.botUserId,
      });
      return c.json({
        ok: true,
        ...(auth.teamId ? { teamId: auth.teamId } : {}),
        ...(auth.teamName ? { team: auth.teamName } : {}),
        ...(auth.botName ? { botName: auth.botName } : {}),
        ...(auth.botUserId ? { botUserId: auth.botUserId } : {}),
        note: 'Signing secret saved; Slack proves it on the first signed event.',
      });
    } catch (err) {
      return internalError(c, err);
    }
  });

  // SPA catch-all, registered LAST: every client-routed page path
  // (/admin/profiles, /admin/channels/T/C, ...) serves the same page so deep
  // links and refreshes work. Unmatched /admin/api/* stays a 404, never HTML.
  app.get('/admin/*', (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith('/admin/api/')) return c.notFound();
    return c.html(renderAdminPage());
  });

  return app;
}

// The origin Slack must call back into, resolved fail-closed against header
// spoofing (the events URL this origin builds becomes a stored Slack config):
//   1. SLACK_TAG_PUBLIC_URL, when set, is the operator's explicit pin and wins
//      outright — no request header can override it.
//   2. On the Cloudflare target the edge terminates TLS and rewrites Host, so
//      the request URL / Host ARE the public origin; x-forwarded-* here is
//      caller-supplied and untrusted, so it is ignored entirely.
//   3. On Node behind a reverse proxy, honor x-forwarded-proto/host but take
//      the LAST comma-separated hop — the value the proxy nearest this app set
//      — not the first, which a client can forge by pre-seeding the header.
function requestOrigin(c: Context): string {
  const pinned = process.env.SLACK_TAG_PUBLIC_URL?.trim();
  if (pinned) {
    return pinned.replace(/\/+$/, '');
  }
  const url = new URL(c.req.url);
  if (isCloudflareTarget()) {
    return `${url.protocol.replace(/:$/, '')}://${c.req.header('host') || url.host}`;
  }
  const forwardedProto = lastForwardedHop(c.req.header('x-forwarded-proto'));
  const forwardedHost = lastForwardedHop(c.req.header('x-forwarded-host'));
  const proto = forwardedProto || url.protocol.replace(/:$/, '');
  const host = forwardedHost || c.req.header('host') || url.host;
  return `${proto}://${host}`;
}

// Per-isolate memo of the last origin we wrote to slack.publicUrl, so the
// opportunistic persist below is a no-op read/write on the steady state (every
// admin request would otherwise hit the settings store).
let lastPersistedPublicUrl: string | undefined;

/**
 * Persist the request origin as slack.publicUrl so the Slack reply footer /
 * onboarding "Configure" deep link works on a button deploy where
 * SLACK_TAG_PUBLIC_URL is never set. Best-effort and non-blocking to the
 * response: an env pin already wins at resolution time, and a settings write
 * failure must never break an admin request. Skips the write when the origin is
 * unchanged since this isolate last wrote it.
 */
async function persistRequestOrigin(c: Context, store: SettingsStore): Promise<void> {
  const origin = requestOrigin(c);
  if (!origin || origin === lastPersistedPublicUrl) {
    return;
  }
  try {
    await store.setSetting(SLACK_SETTING_KEYS.publicUrl, origin);
    primeStoredSlackPublicUrl(origin);
    lastPersistedPublicUrl = origin;
  } catch (err) {
    console.error(
      '[chickpea] failed to persist slack.publicUrl:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// The trusted hop of an X-Forwarded-* header is the LAST value: each proxy
// appends, so the rightmost entry is the one set by the proxy closest to this
// app. Taking the first would trust a value a client can pre-populate.
function lastForwardedHop(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const hops = header
    .split(',')
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length ? hops[hops.length - 1] : undefined;
}

/**
 * Slack's "create an app from a manifest" deep link. The committed manifest
 * carries the `https://<YOUR_PUBLIC_HOST>` placeholder in its URL fields;
 * substituting the real origin here (server-side, from the admin request)
 * removes the copy-the-events-URL step entirely. `$schema` is editor tooling,
 * not part of Slack's manifest schema — strip it from the deep link.
 */
function slackManifestUrl(origin: string): string {
  const { $schema: _schema, ...manifest } = slackAppManifest;
  const json = JSON.stringify(manifest).replaceAll('https://<YOUR_PUBLIC_HOST>', origin);
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(json)}`;
}

// Any GET under /admin that is a PAGE navigation (the SPA serves every
// client-routed path), as opposed to an /admin/api/* call.
function isAdminPageGet(c: Context): boolean {
  if (c.req.method !== 'GET') return false;
  const pathname = c.req.path;
  return (
    pathname === '/admin' ||
    (pathname.startsWith('/admin/') && !pathname.startsWith('/admin/api/'))
  );
}

function isAdminLoginPost(c: Context): boolean {
  return c.req.method === 'POST' && c.req.path === '/admin/login';
}

async function readAdminLogin(
  c: Context,
): Promise<{ token: string | undefined; returnTo: string }> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  const contentLength = Number(c.req.header('content-length'));
  if (
    contentType !== 'application/x-www-form-urlencoded' ||
    (Number.isFinite(contentLength) && contentLength > MAX_ADMIN_LOGIN_BODY_BYTES)
  ) {
    return { token: undefined, returnTo: '/admin' };
  }

  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_ADMIN_LOGIN_BODY_BYTES) {
    return { token: undefined, returnTo: '/admin' };
  }
  const params = new URLSearchParams(raw);
  return {
    token: params.get('token') ?? undefined,
    returnTo: safeAdminReturnPath(params.get('returnTo')),
  };
}

function safeAdminReturnPath(candidate: string | null | undefined): string {
  if (!candidate) return '/admin';
  try {
    const parsed = new URL(candidate, 'https://chickpea.invalid');
    if (
      parsed.origin !== 'https://chickpea.invalid' ||
      parsed.pathname !== candidate ||
      parsed.pathname === '/admin/login' ||
      parsed.pathname === '/admin/api' ||
      parsed.pathname.startsWith('/admin/api/') ||
      !(parsed.pathname === '/admin' || parsed.pathname.startsWith('/admin/'))
    ) {
      return '/admin';
    }
    return parsed.pathname;
  } catch {
    return '/admin';
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer (.+)$/);
  return match?.[1];
}

// Cookie value = a hash of the admin token, so the cookie is not itself the
// admin credential (can't be sent as a Bearer, doesn't leak TAG_ADMIN_TOKEN).
function cookieTokenFor(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isHttps(c: Context): boolean {
  const forwarded = c.req.header('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function toAgentConfig(input: v.InferOutput<typeof agentSchema>): CustomAgentConfig {
  return {
    id: input.id,
    name: input.name,
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    skills: input.skills,
    mcpServers: toMcpServers(input.mcpServers),
  };
}

// Valibot's `v.optional(...)` infers `key?: T | undefined`, which is not
// assignable to the exact-optional (`key?: T`) fields on McpConnectionConfig
// under `exactOptionalPropertyTypes`. Rebuild each server with conditional
// spreads so an absent optional stays absent (never `undefined`).
function toMcpServers(
  servers: v.InferOutput<typeof mcpServersSchema>,
): CustomAgentConfig['mcpServers'] {
  return servers.map((server) => ({
    id: server.id,
    displayName: server.displayName,
    url: server.url,
    transport: server.transport,
    authMode: server.authMode,
    headerNames: server.headerNames,
    enabled: server.enabled,
    lifecycleStatus: server.lifecycleStatus,
    statusText: server.statusText,
    discoveredTools: server.discoveredTools.map((tool) => ({
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
    })),
    allowedTools: server.allowedTools,
    ...(server.lastCheckedAt !== undefined ? { lastCheckedAt: server.lastCheckedAt } : {}),
    ...(server.presetId !== undefined ? { presetId: server.presetId } : {}),
  }));
}

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null };

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.skills !== undefined) patch.skills = input.skills;
  if (input.mcpServers !== undefined) patch.mcpServers = toMcpServers(input.mcpServers);
  return patch;
}

function toAssignment(input: v.InferOutput<typeof assignmentSchema>): ChannelAssignment {
  return {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    agentId: input.agentId,
    enabled: input.enabled,
    ...(input.channelLabel !== undefined ? { channelLabel: input.channelLabel } : {}),
    ...(input.channelPromptAddendum !== undefined
      ? { channelPromptAddendum: input.channelPromptAddendum }
      : {}),
  };
}

// Team-identity resolution that never throws: a backfill auth.test that cannot
// reach Slack must not fail the whole assignment PUT / channels GET — the caller
// treats an empty result as "team unknown, skip the workspace check".
async function resolveTeamInfoSafely(
  env: PlatformEnv | undefined,
  store: SettingsStore,
): Promise<SlackTeamInfo> {
  try {
    return await resolveSlackTeamInfo(env, store);
  } catch {
    return { teamId: undefined, teamName: undefined };
  }
}

function connectedWorkspaceLabel(team: SlackTeamInfo): string {
  if (team.teamName && team.teamId) return `${team.teamName} (${team.teamId})`;
  return team.teamName ?? team.teamId ?? 'the connected workspace';
}

function workspaceMismatchMessage(team: SlackTeamInfo, workspaceId: string): string {
  return (
    `Chickpea is connected to ${connectedWorkspaceLabel(team)}, but this channel belongs to a ` +
    `different workspace (${workspaceId}). Add Tag to ${team.teamName ?? 'the connected workspace'} ` +
    `in Slack, or connect Chickpea to that workspace instead.`
  );
}

function channelNotFoundMessage(channelId: string, team: SlackTeamInfo): string {
  const where = team.teamName ? ` in ${team.teamName}` : '';
  return (
    `Slack could not find channel ${channelId}${where}. Check for a typo, make sure the channel ` +
    `is in the connected workspace, and if it is private invite @Tag to it first — then try again.`
  );
}

function modelResolutionError(agent: ModelResolvableAgent): ModelResolutionError | undefined {
  try {
    resolveAgentModel(agent);
    return undefined;
  } catch (err) {
    if (err instanceof ModelResolutionError) {
      return err;
    }
    throw err;
  }
}

function modelNotResolvable(
  c: { json(body: { error: string; message: string }, status: 422): Response },
  err: ModelResolutionError,
): Response {
  return c.json({ error: 'model_not_resolvable', message: err.message }, 422);
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function assignmentKey(c: { req: { query(name: string): string | undefined } }):
  | { workspaceId: string; channelId: string }
  | undefined {
  const workspaceId = c.req.query('workspaceId');
  const channelId = c.req.query('channelId');
  if (!workspaceId || !channelId) {
    return undefined;
  }
  return { workspaceId, channelId };
}

function invalidRequest(c: { json(body: { error: string }, status: 400): Response }): Response {
  return c.json({ error: 'invalid_request' }, 400);
}

// Free text accepts any provider/model specifier (locked model-picker
// decision: warn, never block — the registry approximates Flue/Pi's real
// provider surface, so an unknown prefix may still work at runtime). A warning
// on the success body keeps the pre-check honest without false blocking. An
// empty registry means "unknown environment" (route module used without
// src/app.ts registrations, e.g. unit tests) — no warning either way.
function providerWarnings(
  model: string | null | undefined,
  known: ReadonlySet<string>,
): { warnings?: Array<{ code: string; provider: string; knownProviders: string[] }> } {
  if (!model || known.size === 0) return {};
  const prefix = model.slice(0, model.indexOf('/'));
  if (known.has(prefix)) return {};
  return {
    warnings: [{ code: 'unknown_provider', provider: prefix, knownProviders: [...known].sort() }],
  };
}

interface ProviderSummary {
  id: AdminProviderId;
  status: ProviderKeySource;
  modelCount: number | null;
}

function providerSummary(id: AdminProviderId, status: ProviderKeySource): ProviderSummary {
  return {
    id,
    status,
    modelCount: cachedProviderModelCount(id) ?? null,
  };
}

function workersAiStatus(env: PlatformEnv | undefined): ProviderKeySource {
  if (hasWorkersAiBinding(env)) {
    return 'env';
  }
  return process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID ? 'env' : 'missing';
}

function hasWorkersAiBinding(env: PlatformEnv | undefined): boolean {
  const ai = env?.AI;
  return Boolean(ai && typeof ai === 'object' && typeof (ai as { models?: unknown }).models === 'function');
}

function providerApiKeyFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const value = record.apiKey ?? record.key;
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function providerFavoritesFromBody(body: unknown): string[] | undefined {
  const raw = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).favorites)
      ? ((body as Record<string, unknown>).favorites as unknown[])
      : undefined;
  if (!raw) {
    return undefined;
  }
  const favorites = raw.filter((value): value is string => typeof value === 'string');
  return favorites.length === raw.length ? favorites : undefined;
}

async function countPinnedProfiles(configStore: ConfigStore, provider: string): Promise<number> {
  const agents = await configStore.listAgents();
  return agents.filter((agent) => modelBelongsToProvider(agent.model, provider)).length;
}

function modelBelongsToProvider(model: string | undefined, provider: string): boolean {
  if (!model) {
    return false;
  }
  if (provider === 'workers-ai') {
    return model.startsWith('cloudflare/') || model.startsWith('cloudflare-workers-ai/');
  }
  return model.startsWith(`${provider}/`);
}

// Never echo internal error text (raw SQLite messages) to API clients; log it
// server-side and return a stable retriable status instead.
function internalError(
  c: { json(body: { error: string }, status: 500): Response },
  err: unknown,
): Response {
  console.error('[chickpea] admin API failure:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'internal_error' }, 500);
}

function effectiveConfigResponse(config: EffectiveSlackConfig): object {
  return {
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    agentId: config.agentId,
    profile: {
      id: config.agent.id,
      name: config.agent.name,
      enabled: config.agent.enabled,
      model: config.agent.model ?? null,
    },
    model: config.model,
    provider: config.provider,
    instructions: config.instructions,
    instructionLayers: config.instructionLayers,
    snapshotHash: computeSnapshotHash(config),
  };
}
