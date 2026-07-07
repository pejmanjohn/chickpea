import { createHash } from 'node:crypto';

import { Hono, type Context, type Next } from 'hono';
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
import { resolveAgentModel, type ModelResolvableAgent } from '../config/model-policy.ts';
import { knownProviderIds, listRuntimeModelProviders } from '../config/providers.ts';
import { SEED_DEFAULT_MODELS } from '../config/seed.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getSettingsStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../config/types.ts';
import {
  describeSlackCredentialSources,
  primeStoredSlackCredentials,
  slackAuthTest,
  SLACK_SETTING_KEYS,
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
}

const ADMIN_COOKIE = 'flue_admin';

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));

const defaultModelsSchema = v.object({
  claude: nonEmptyString,
  'workers-ai': nonEmptyString,
});

const agentSchema = v.object({
  id: nonEmptyString,
  name: nonEmptyString,
  description: v.string(),
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  defaultModels: defaultModelsSchema,
  allowedTools: v.array(v.string()),
});

const agentPatchSchema = v.partial(
  v.object({
    name: nonEmptyString,
    description: v.string(),
    instructions: nonEmptyString,
    enabled: v.boolean(),
    model: v.nullable(modelSpecifier),
    defaultModels: defaultModelsSchema,
    allowedTools: v.array(v.string()),
  }),
);

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

  const adminGate = async (c: Context, next: Next) => {
    const expected = adminToken();
    if (!expected) {
      return c.notFound();
    }

    // The cookie carries a hash of the token, never the token itself: a captured
    // cookie can't be replayed as a Bearer credential and doesn't reveal
    // TAG_ADMIN_TOKEN. Bearer/query still send the raw token (standard), but the
    // long-lived browser credential is the derived value.
    const cookieValue = cookieTokenFor(expected);

    const queryToken = c.req.query('token');
    if (constantTimeEquals(queryToken, expected)) {
      setCookie(c, ADMIN_COOKIE, cookieValue, {
        path: '/admin',
        httpOnly: true,
        sameSite: 'Lax',
        // Send only over TLS when the request arrived over TLS; on plain-http
        // dev there is no transport to protect, so forcing Secure would just
        // drop the cookie and break login.
        secure: isHttps(c),
      });
      // Strip ?token= from the URL so the secret does not linger in the address
      // bar, browser history, or proxy access logs, and is not a standing query
      // credential. Only redirect the page GET; API callers using ?token get the
      // cookie set and proceed (they have no address bar to leak into).
      if (c.req.method === 'GET' && new URL(c.req.url).pathname === '/admin') {
        return c.redirect('/admin', 303);
      }
      return next();
    }

    const candidate = bearerToken(c.req.header('authorization'));
    if (candidate !== undefined) {
      if (!constantTimeEquals(candidate, expected)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return next();
    }

    if (!constantTimeEquals(getCookie(c, ADMIN_COOKIE), cookieValue)) {
      // A browser navigating to the /admin PAGE with no valid session gets a
      // minimal token-entry form instead of a bare JSON 401 — otherwise the
      // documented "/admin?token=..." login has no visible entry point. XHR
      // and /admin/api/* callers still get the JSON 401 they can handle. Kept
      // at 401 (not 200) so it is never cached as a real page; `invalidToken`
      // is set only when a ?token= was supplied and rejected.
      if (isAdminPageGet(c)) {
        return c.html(renderAdminLogin({ invalidToken: queryToken !== undefined }), 401);
      }
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };

  app.use('/admin', adminGate);
  app.use('/admin/*', adminGate);

  app.get('/admin', (c) => c.html(renderAdminPage()));

  app.get('/admin/api/agents', async (c) => c.json({ agents: await store(c).listAgents() }));

  app.get('/admin/api/models', (c) =>
    c.json({
      automatic: { label: 'Automatic (provider default)', value: null },
      providers: modelProviders(),
      defaultModels: SEED_DEFAULT_MODELS,
    }),
  );

  app.post('/admin/api/agents', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const agent = toAgentConfig(parsed.output);
    if (!isModelResolvable(agent)) {
      return c.json({ error: 'model_not_resolvable' }, 422);
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
        defaultModels: patch.defaultModels ?? current.defaultModels,
      };
      if (!isModelResolvable(next)) {
        return c.json({ error: 'model_not_resolvable' }, 422);
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
    try {
      const deleted = await configStore.deleteAgent(agentId);
      return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (err instanceof AgentStillAssignedError) {
        return c.json({ error: 'agent_still_assigned' }, 409);
      }
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
    try {
      return c.json({ assignment: await store(c).putAssignment(toAssignment(parsed.output)) });
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        return c.json({ error: 'unknown_agent' }, 404);
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
        return c.json({ error: 'model_not_resolvable' }, 422);
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
      const credentials = await describeSlackCredentialSources(
        c.env as PlatformEnv | undefined,
        settings(c),
      );
      const requestUrl = `${requestOrigin(c)}/channels/slack/events`;
      return c.json({
        credentials,
        // Connected = both wire credentials resolvable somewhere. The bot
        // user id is not required for a connection (it resolves via
        // auth.test at event time when absent).
        connected: credentials.botToken !== 'missing' && credentials.signingSecret !== 'missing',
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
        '[tag-team] wizard auth.test unreachable:',
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
        ...(auth.teamName ? { team: auth.teamName } : {}),
        ...(auth.botName ? { botName: auth.botName } : {}),
        ...(auth.botUserId ? { botUserId: auth.botUserId } : {}),
        note: 'Signing secret saved; Slack proves it on the first signed event.',
      });
    } catch (err) {
      return internalError(c, err);
    }
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

// A top-level GET of the /admin page (a browser navigation), as opposed to an
// /admin/api/* XHR — the only request that should receive the HTML login form
// rather than a JSON 401.
function isAdminPageGet(c: Context): boolean {
  if (c.req.method !== 'GET') return false;
  try {
    return new URL(c.req.url).pathname === '/admin';
  } catch {
    return false;
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
    description: input.description,
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    defaultModels: input.defaultModels,
    allowedTools: input.allowedTools,
  };
}

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null };

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.defaultModels !== undefined) patch.defaultModels = input.defaultModels;
  if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
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

function isModelResolvable(agent: ModelResolvableAgent): boolean {
  try {
    resolveAgentModel(agent);
    return true;
  } catch {
    return false;
  }
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

// Never echo internal error text (raw SQLite messages) to API clients; log it
// server-side and return a stable retriable status instead.
function internalError(
  c: { json(body: { error: string }, status: 500): Response },
  err: unknown,
): Response {
  console.error('[tag-team] admin API failure:', err instanceof Error ? err.message : String(err));
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
      description: config.agent.description,
      enabled: config.agent.enabled,
    },
    model: config.model,
    provider: config.provider,
    allowedTools: config.allowedTools,
    instructions: config.instructions,
    instructionLayers: config.instructionLayers,
    snapshotHash: computeSnapshotHash(config),
  };
}
