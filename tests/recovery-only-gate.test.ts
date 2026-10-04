import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { recoveryOnlyGate } from '../src/auth/request-auth-control.ts';
import { mintDeploymentActivation } from '../src/auth/deployment-activation.mjs';
import { provisionDeploymentRecovery } from '../src/auth/deployment-recovery.ts';
import { objectInstallationEnv, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  getIdentityStore,
  getSettingsStore,
  getSlackCredentialDependencies,
  type PlatformEnv,
} from '../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import type { AuthControl, IdentityStore } from '../src/identity/types.ts';
import {
  buildSlackAppManifest,
  SLACK_RECOVERY_CALLBACK_PATH,
  slackManifestFingerprint,
} from '../src/slack/app-manifest.ts';
import { generateCredentialKeyring, workerCredentialKeySlot } from '../src/slack/credential-keyring.ts';
import {
  promoteSlackCredentialBundle,
  resolveSlackInstallationCredentials,
  SlackCredentialRecoveryOnlyError,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import { SLACK_PENDING_ENVELOPE_SETTING } from '../src/slack/installation-handshake.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { DoSqlStateDb } from '../src/state/do-state-db.ts';
import { buildTagStateStores, type TagStateStores } from '../src/state/tag-state-stores.ts';
import { FakeObjectStorage } from './helpers/installation-objects.ts';

// The application keeps Node state in this process's state database; give it
// a private one before it loads.
const stateDir = mkdtempSync(join(tmpdir(), 'chickpea-recovery-gate-'));
process.env.SLACK_STATE_DB_PATH = join(stateDir, 'state.db');
process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(stateDir, 'keyring.json');
const { default: app } = await import('../src/app.ts');
after(() => rmSync(stateDir, { recursive: true, force: true }));

const ORIGIN = 'https://app.example';
const RECOVERY_TOKEN = 'a'.repeat(64);
const VERSION = 'version-recovery-gate';

/** Slack credential recovery and the paths with their own capability. */
const EXCEPTIONS = [
  ['GET', '/admin/recovery'],
  ['POST', '/admin/recovery'],
  ['GET', '/auth/slack/continue.js'],
  ['GET', SLACK_RECOVERY_CALLBACK_PATH],
  ['POST', '/internal/deployment/ready'],
  ['POST', '/internal/deployment/recover-delivery'],
  ['GET', '/internal/environment/authority'],
] as const;

/** Everything else, the exceptions' near neighbours included, stays not found. */
const CLOSED = [
  ['GET', '/admin'],
  ['GET', '/admin/agents'],
  ['GET', '/admin/api/providers'],
  ['GET', '/admin/setup'],
  ['GET', '/admin/recovery/'],
  ['GET', '/admin/recovery/finish'],
  ['GET', '/admin/recoveryx'],
  ['GET', '/auth/slack/recovery'],
  ['GET', '/auth/slack/recovery/callback'],
  ['GET', `${SLACK_RECOVERY_CALLBACK_PATH}/`],
  ['GET', '/auth/slack/sign-in'],
  ['GET', '/auth/slack/install/callback'],
  ['GET', '/auth/slack/install/callback/other'],
  ['GET', '/api/auth/get-session'],
  ['GET', '/connect.md'],
  ['POST', '/mcp'],
  ['POST', '/channels/slack/events'],
  ['POST', '/internal/deployment/other'],
  ['POST', '/internal/deployment/ready/'],
  ['GET', '/internal/environment/models'],
  ['POST', '/internal/environment/seed'],
] as const;

/** Paths whose own handlers answer something other than not found outside recovery-only. */
const OPEN_WHEN_NORMAL = [
  ['GET', '/admin/api/providers'],
  ['GET', '/connect.md'],
  ['POST', '/channels/slack/events'],
] as const;

function recoveryOnly(identity: IdentityStore): Promise<AuthControl> {
  return identity.ensureAuthControl({ healthGate: 'recovery_only' }).then((control) =>
    control.healthGate === 'recovery_only'
      ? control
      : identity.updateAuthControl({ expectedRevision: control.revision, healthGate: 'recovery_only' }));
}

/** The installed Slack app recovery repairs: an active connected bundle. */
async function installSlackApp(env: PlatformEnv | undefined): Promise<void> {
  const credentials = getSlackCredentialDependencies(env);
  const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
  const appRevision = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation', purpose: 'app_credentials', expectedActiveRevision: null,
    appId: 'A12345678', manifestFingerprint: slackManifestFingerprint(manifest),
    secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret' },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    candidateRevision: appRevision.revision, expectedActiveRevision: null,
  });
  const connected = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    identityClass: 'workspace_installation', purpose: 'connected_credentials',
    expectedActiveRevision: appRevision.revision, appId: 'A12345678', teamId: 'TACME', botUserId: 'UBOT',
    grantedScopes: [...REQUIRED_SLACK_BOT_SCOPES], manifestFingerprint: slackManifestFingerprint(manifest),
    secrets: {
      clientId: '123.456', clientSecret: 'client-secret', signingSecret: 'signing-secret', botToken: 'xoxb-token',
    },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID,
    candidateRevision: connected.revision, expectedActiveRevision: appRevision.revision,
  });
}

/** The bindings recovery and deployment activation read, and activation's bearer capability. */
async function deploymentBindings() {
  const activation = await mintDeploymentActivation();
  return {
    activation,
    bindings: {
      CHICKPEA_RECOVERY_TOKEN: RECOVERY_TOKEN,
      CHICKPEA_DEPLOYMENT_ACTIVATION_DIGEST: activation.digest,
      CHICKPEA_DEPLOYMENT_ACTIVATION_ISSUED_AT: String(activation.issuedAt),
      CF_VERSION_METADATA: { id: VERSION },
    },
  };
}

/** A deploy's recovery authority for this Worker version, as readiness provisions it. */
async function provisionRecovery(env: PlatformEnv | undefined, activation: { digest: string; issuedAt: number }) {
  await provisionDeploymentRecovery(getSettingsStore(env), VERSION, activation.digest, activation.issuedAt);
}

function send(env: PlatformEnv, method: string, path: string, init: RequestInit = {}) {
  return app.request(`${ORIGIN}${path}`, { method, ...init }, env);
}

/**
 * Walks every exception the way its caller would, and checks each answer
 * comes from its own handler: the recovery page, the recovery form, Slack's
 * callback, deployment readiness, delivery recovery and lane attestation.
 */
async function assertExceptionsReachable(env: PlatformEnv, capability: string): Promise<void> {
  const entry = await send(env, 'GET', '/admin/recovery');
  assert.equal(entry.status, 200, 'GET /admin/recovery');
  assert.match(await entry.text(), /repairs only the existing Slack app/i);

  const begun = await send(env, 'POST', '/admin/recovery', {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
    },
    body: new URLSearchParams({ action: 'begin', recoveryToken: RECOVERY_TOKEN }).toString(),
  });
  assert.equal(begun.status, 200, 'POST /admin/recovery');
  assert.match(await begun.text(), /A12345678/);
  const cookie = begun.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  assert.match(cookie, /__Secure-chickpea_slack_recovery=/);

  // No bot authorization was started, so the callback refuses the session on
  // its recovery page.
  const callback = await send(env, 'GET', `${SLACK_RECOVERY_CALLBACK_PATH}?state=unknown&code=unknown`, {
    headers: { cookie },
  });
  assert.notEqual(callback.status, 404, `GET ${SLACK_RECOVERY_CALLBACK_PATH}`);
  assert.match(callback.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await callback.text(), /Slack/);

  // The Slack handoff page's script, so recovery's handoff opens Slack itself.
  const script = await send(env, 'GET', '/auth/slack/continue.js');
  assert.equal(script.status, 200, 'GET /auth/slack/continue.js');
  assert.match(script.headers.get('content-type') ?? '', /javascript/);

  const ready = await send(env, 'POST', '/internal/deployment/ready', {
    headers: { authorization: `Bearer ${capability}` },
  });
  assert.equal(ready.status, 400, 'POST /internal/deployment/ready');
  assert.deepEqual(await ready.json(), { error: 'invalid_target_version' });

  const recovered = await send(env, 'POST', '/internal/deployment/recover-delivery', {
    headers: { authorization: `Bearer ${capability}`, 'x-chickpea-target-version': VERSION },
  });
  assert.equal(recovered.status, 204, 'POST /internal/deployment/recover-delivery');

  // Attestation answers an unregistered lane with its own empty JSON refusal.
  const authority = await send(env, 'GET', '/internal/environment/authority');
  assert.equal(authority.status, 404);
  assert.match(authority.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(await authority.text(), '{}', 'GET /internal/environment/authority');
}

async function assertClosed(env: PlatformEnv, paths: readonly (readonly [string, string])[]): Promise<void> {
  for (const [method, path] of paths) {
    const response = await send(env, method, path, method === 'POST' ? { body: '{}' } : {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal(await response.text(), '404 Not Found', `${method} ${path}`);
  }
}

async function assertOpen(env: PlatformEnv): Promise<void> {
  for (const [method, path] of OPEN_WHEN_NORMAL) {
    const response = await send(env, method, path, method === 'POST' ? { body: '{}' } : {});
    assert.notEqual(response.status, 404, `${method} ${path}`);
  }
}

/** Runs `fn` as the Worker build does: `isCloudflareTarget()` is true inside. */
function onWorker(t: TestContext): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
}

/**
 * A TAG_STATE namespace whose objects answer the identity and settings RPCs,
 * and the workspace installation read, as the state Durable Object does, over
 * the stores it builds. Under installation tenancy each installation's object
 * is bound to its IDs. `identityKinds` collects every identity RPC's kind.
 */
function stateNamespace(platform: Record<string, unknown>, identityKinds: string[] = []) {
  const objects = new Map<string, TagStateStores>();
  const call = <T>(fn: () => T) => {
    try {
      return Promise.resolve({ ok: true as const, value: fn() });
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: (error as Error).message } });
    }
  };
  return {
    stores(name: string): TagStateStores {
      let stores = objects.get(name);
      if (!stores) {
        const env = objectInstallationEnv({ id: { name } }, platform as PlatformEnv);
        const storage = new FakeObjectStorage();
        stores = buildTagStateStores(new DoSqlStateDb(storage.asDurableObjectStorage()), env, { gatewayLeaseOwner: 'test' });
        const scope = env.CHICKPEA_TENANCY === 'installation' ? name.split('~')[1] : undefined;
        if (scope) stores.installationBinding.bind({ organizationId: `org_${scope}`, installationId: scope });
        objects.set(name, stores);
      }
      return stores;
    },
    getByName(name: string) {
      const stores = this.stores(name);
      return {
        identityExecute: (request: Parameters<TagStateStores['identity']['execute']>[0]) => {
          identityKinds.push(request.kind);
          return call(() => stores.identity.execute(request));
        },
        configGetWorkspaceInstallation: (workspaceId: string) =>
          call(() => stores.config.getWorkspaceInstallation(workspaceId) ?? null),
        settingGet: (key: string) => call(() => stores.settings.getSetting(key) ?? null),
        settingGetMany: (keys: readonly string[]) =>
          call(() => stores.settings.getSettings(keys).map((value) => value ?? null)),
        settingSet: (key: string, value: string) => call(() => { stores.settings.setSetting(key, value); return null; }),
        settingDelete: (key: string) => call(() => { stores.settings.deleteSetting(key); return null; }),
        settingApplyPatch: (patch: Parameters<TagStateStores['settings']['applySettingsPatch']>[0]) =>
          call(() => stores.settings.applySettingsPatch(patch)),
      };
    },
  };
}

test('the recovery gate passes recovery-only exceptions and closes everything else', async () => {
  let reads = 0;
  const identity = {
    getAuthControl: async () => {
      reads += 1;
      return { healthGate: 'recovery_only' } as AuthControl;
    },
  } as IdentityStore;
  const probe = new Hono();
  probe.use('*', recoveryOnlyGate(() => identity));
  probe.all('*', (c) => c.text('reached'));
  for (const [method, path] of EXCEPTIONS) {
    const response = await probe.request(`${ORIGIN}${path}`, { method });
    assert.equal(await response.text(), 'reached', `${method} ${path}`);
  }
  for (const [method, path] of CLOSED) {
    const response = await probe.request(`${ORIGIN}${path}`, { method });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  // Only Slack credential recovery and the closed paths read auth control.
  assert.equal(reads, 4 + CLOSED.length);
});

test('the application and Admin mount the one recovery gate, so their exceptions cannot drift', () => {
  for (const file of ['../src/app.ts', '../src/admin/routes.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /app\.use\('\*', recoveryOnlyGate\(/, file);
    assert.doesNotMatch(source, /healthGate === 'recovery_only'/, `${file} keeps no recovery gate of its own`);
  }
});

test('a recovery-only path with a responder serves only what it answers', async () => {
  let control: AuthControl = { healthGate: 'recovery_only' } as AuthControl;
  const identity = { getAuthControl: async () => control } as IdentityStore;
  const asked: string[] = [];
  const probe = new Hono();
  probe.use('*', recoveryOnlyGate(() => identity, new Map([['/channels/slack/events', async (c) => {
    const body = await c.req.text();
    asked.push(body);
    return body === 'proof' ? c.text('answered') : undefined;
  }]])));
  probe.all('*', (c) => c.text('reached'));
  const post = (path: string, body: string) => probe.request(`${ORIGIN}${path}`, { method: 'POST', body });
  assert.equal(await (await post('/channels/slack/events', 'proof')).text(), 'answered');
  const other = await post('/channels/slack/events', 'event');
  assert.equal(other.status, 404);
  assert.equal(await other.text(), '404 Not Found');
  // A responder answers for its own path only.
  assert.equal((await post('/channels/slack/interactions', 'proof')).status, 404);
  assert.deepEqual(asked, ['proof', 'event']);
  // Outside recovery-only the route itself answers, and the responder is not asked.
  control = { healthGate: 'normal' } as AuthControl;
  assert.equal(await (await post('/channels/slack/events', 'event')).text(), 'reached');
  assert.deepEqual(asked, ['proof', 'event']);
});

test('public assets are served while recovery-only, without reading auth control', async () => {
  const identity = {
    getAuthControl: async () => { throw new Error('auth control unavailable'); },
  } as unknown as IdentityStore;
  const probe = new Hono();
  probe.use('*', recoveryOnlyGate(() => identity));
  probe.all('*', (c) => c.text('reached'));
  probe.onError((_error, c) => c.text('unavailable', 500));
  // The recovery pages' brand and favicon, which a Worker serves before it runs.
  for (const path of ['/chickpea-mark-128.png', '/chickpea-favicon-32.png', '/chickpea-wordmark-512.png']) {
    assert.equal(await (await probe.request(`${ORIGIN}${path}`)).text(), 'reached', path);
  }
  assert.equal((await probe.request(`${ORIGIN}/chickpea-mark-128.png/`)).status, 500);
  assert.equal((await probe.request(`${ORIGIN}/assets/chickpea-mark-128.png`)).status, 500);
});

test('the capability paths answer without reading auth control', async () => {
  const identity = {
    getAuthControl: async () => { throw new Error('auth control unavailable'); },
  } as unknown as IdentityStore;
  const probe = new Hono();
  probe.use('*', recoveryOnlyGate(() => identity));
  probe.all('*', (c) => c.text('reached'));
  probe.onError((_error, c) => c.text('unavailable', 500));
  for (const path of ['/internal/deployment/ready', '/internal/deployment/recover-delivery', '/internal/environment/authority']) {
    const response = await probe.request(`${ORIGIN}${path}`, { method: 'POST' });
    assert.equal(await response.text(), 'reached', path);
  }
  assert.equal((await probe.request(`${ORIGIN}/admin/recovery`)).status, 500);
});

test('a recovery-only Node installation serves Slack credential recovery and deployment activation, and nothing else', async () => {
  const { activation, bindings } = await deploymentBindings();
  const env = bindings as PlatformEnv;
  await installSlackApp(undefined);
  await provisionRecovery(undefined, activation);
  await assertOpen(env);
  await recoveryOnly(getIdentityStore());
  await assertClosed(env, CLOSED);
  await assertExceptionsReachable(env, activation.capability);
  // Node serves public assets itself; the recovery pages' brand still loads.
  const mark = await send(env, 'GET', '/chickpea-mark-128.png');
  assert.equal(mark.status, 200, 'GET /chickpea-mark-128.png');
  assert.equal(mark.headers.get('content-type'), 'image/png');
  assert.equal((await getIdentityStore().getAuthControl())?.healthGate, 'recovery_only');
});

test('a recovery-only Worker installation serves Slack credential recovery and deployment activation, and nothing else', async (t) => {
  onWorker(t);
  const keyring = generateCredentialKeyring('key_v1');
  const { activation, bindings } = await deploymentBindings();
  const env = {
    TAG_STATE: stateNamespace({}),
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
    ...bindings,
  } as PlatformEnv;
  await installSlackApp(env);
  await provisionRecovery(env, activation);
  await assertOpen(env);
  await recoveryOnly(getIdentityStore(env));
  await assertClosed(env, CLOSED);
  await assertExceptionsReachable(env, activation.capability);
  assert.equal((await getIdentityStore(env).getAuthControl())?.healthGate, 'recovery_only');
});

test('a recovery-only hosted installation stays closed: its recovery is the host\'s, not these routes', async (t) => {
  onWorker(t);
  const keyring = generateCredentialKeyring('key_v1');
  const { bindings } = await deploymentBindings();
  const platform: Record<string, unknown> = {
    CHICKPEA_TENANCY: 'installation',
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
    ...bindings,
  };
  platform.TAG_STATE = stateNamespace(platform);
  const env = scopeInstallationEnv(platform as PlatformEnv, { installationId: 'inst_recovering' });
  await recoveryOnly(getIdentityStore(env));
  await assertClosed(env, [...EXCEPTIONS, ...CLOSED]);
  assert.equal((await getIdentityStore(env).getAuthControl())?.healthGate, 'recovery_only');
});

/** Slack's answers to the recovery callback: the bot token exchange and its checks. */
function fakeSlack(t: TestContext): string[] {
  const called: string[] = [];
  const scopes = REQUIRED_SLACK_BOT_SCOPES.join(',');
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const method = new URL(input instanceof Request ? input.url : String(input)).pathname.split('/').pop() ?? '';
    called.push(method);
    switch (method) {
      case 'oauth.v2.access': return Response.json({
        ok: true, access_token: 'xoxb-recovered-token', token_type: 'bot', scope: scopes,
        bot_user_id: 'UBOT', app_id: 'A12345678', team: { id: 'TACME' }, authed_user: { id: 'UOWNER' },
      });
      case 'auth.test': return Response.json({
        ok: true, team_id: 'TACME', team: 'Acme', user: 'chickpea', user_id: 'UBOT', bot_id: 'BBOT', app_id: 'A12345678',
      }, { headers: { 'x-oauth-scopes': scopes } });
      case 'users.info': return Response.json({ ok: true, user: { id: 'UBOT', profile: { display_name: 'Chickpea' } } });
      case 'users.list': return Response.json({ ok: true, members: [], response_metadata: { next_cursor: '' } });
      case 'conversations.list': return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: '' } });
      default: return Response.json({ ok: false, error: 'unknown_method' }, { status: 404 });
    }
  });
  return called;
}

/** A browser's recovery form post, with the cookies recovery set. */
function postRecovery(env: PlatformEnv, cookie: string, fields: Record<string, string>) {
  return send(env, 'POST', '/admin/recovery', {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A delivery to the Events URL, signed as Slack signs with `signingSecret`. */
function signedEvent(env: PlatformEnv, signingSecret: string, body: Record<string, unknown>) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return send(env, 'POST', '/channels/slack/events', {
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`,
    },
    body: rawBody,
  });
}

/** Slack sends a browser back only to a URL at or below a Redirect URL the app registered. */
function slackAcceptsRedirect(registered: readonly string[], redirect: URL): boolean {
  return registered.some((value) => {
    const url = new URL(value);
    return url.origin === redirect.origin &&
      (redirect.pathname === url.pathname || redirect.pathname.startsWith(`${url.pathname}/`));
  });
}

const URL_VERIFICATION = { token: 'unused', type: 'url_verification', challenge: 'recovery-events-proof' };
const APP_EVENT = {
  token: 'unused', team_id: 'TACME', api_app_id: 'A12345678', type: 'event_callback', event_id: 'EvRecovery',
  event_time: Math.floor(Date.now() / 1_000), event: { type: 'app_context_changed' },
};

/**
 * The repair an operator makes in a browser: the recovery token, the app's
 * credentials, Slack's bot authorization (which returns to the redirect URI
 * recovery asked for), the Events URL check Slack signs, and finalize.
 */
async function repairOverHttp(t: TestContext, env: PlatformEnv, signingSecret: string): Promise<void> {
  const slackCalls = fakeSlack(t);
  const begun = await postRecovery(env, '', { action: 'begin', recoveryToken: RECOVERY_TOKEN });
  assert.equal(begun.status, 200);
  const cookie = begun.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  const staged = await postRecovery(env, cookie, {
    action: 'stage', appId: 'A12345678', teamId: 'TACME', clientId: '123.456',
    clientSecret: 'client-secret', signingSecret,
  });
  assert.equal(staged.status, 200);
  const href = (await staged.text()).match(/data-slack-authorization-link href="([^"]+)"/)?.[1];
  assert.ok(href, 'the handoff page links to Slack');
  const authorization = new URL(href.replaceAll('&amp;', '&'));
  const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '');
  const registered = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }).oauth_config.redirect_urls ?? [];
  assert.ok(slackAcceptsRedirect(registered, redirect), `Slack refuses ${redirect.href}`);

  const callback = await send(env, 'GET', `${redirect.pathname}?${new URLSearchParams({
    state: authorization.searchParams.get('state') ?? '', code: 'recovery-code',
  })}`, { headers: { cookie } });
  assert.equal(callback.status, 200, await callback.clone().text());
  assert.match(await callback.text(), /name="action" value="finalize"/);
  assert.deepEqual(slackCalls.filter((method) => method === 'oauth.v2.access'), ['oauth.v2.access']);
  const early = await postRecovery(env, cookie, { action: 'finalize' });
  assert.notEqual(early.status, 200, 'finalize needs Slack\'s signed Events proof');

  // Signed with anything but the staged secret, Slack's check proves nothing.
  const forged = await signedEvent(env, 'some-other-secret', URL_VERIFICATION);
  assert.notEqual(forged.status, 200);
  assert.equal(await getSettingsStore(env).getSetting(SLACK_PENDING_ENVELOPE_SETTING), undefined);
  const proof = await signedEvent(env, signingSecret, URL_VERIFICATION);
  assert.equal(proof.status, 200);
  assert.deepEqual(await proof.json(), { challenge: 'recovery-events-proof' });

  const finalized = await postRecovery(env, cookie, { action: 'finalize' });
  assert.equal(finalized.status, 200);
  assert.match(await finalized.text(), /Slack connection repaired/);
}

test('a Worker that lost its key root recovers over HTTP and serves Slack with the recovered app', async (t) => {
  onWorker(t);
  const lost = generateCredentialKeyring('key_v1');
  const replacement = generateCredentialKeyring('key_v2');
  const { bindings } = await deploymentBindings();
  const state = stateNamespace({});
  const before = {
    TAG_STATE: state, ...bindings,
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: 'key_v1', [workerCredentialKeySlot('key_v1')]: lost.keys.key_v1,
  } as PlatformEnv;
  await installSlackApp(before);
  // The deployment now holds only a new key version: the bundle cannot be read.
  const env = {
    TAG_STATE: state, ...bindings,
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: 'key_v2', [workerCredentialKeySlot('key_v2')]: replacement.keys.key_v2,
  } as PlatformEnv;
  await assert.rejects(resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, env), SlackCredentialRecoveryOnlyError);
  assert.equal((await getIdentityStore(env).getAuthControl())?.healthGate, 'recovery_only');

  await repairOverHttp(t, env, 'signing-secret');
  assert.equal((await getIdentityStore(env).getAuthControl())?.healthGate, 'normal');
  assert.deepEqual(await resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, env), {
    botToken: 'xoxb-recovered-token', signingSecret: 'signing-secret', botUserId: 'UBOT',
    connectionRevision: (await getIdentityStore(env).getActiveSlackCredentialRevision(WORKSPACE_SLACK_INSTALLATION_ID))?.revision,
  });
  // Slack's deliveries verify against the recovered bundle again.
  assert.equal((await signedEvent(env, 'signing-secret', APP_EVENT)).status, 200);
});

test('while recovery-only waits on Events proof, the Events URL answers only that proof', async (t) => {
  onWorker(t);
  const keyring = generateCredentialKeyring('key_v1');
  const { bindings } = await deploymentBindings();
  const env = {
    TAG_STATE: stateNamespace({}), ...bindings,
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
  } as PlatformEnv;
  await installSlackApp(env);
  await recoveryOnly(getIdentityStore(env));
  // No recovery waits yet: Slack's check is not found like everything else.
  assert.equal((await signedEvent(env, 'signing-secret', URL_VERIFICATION)).status, 404);

  fakeSlack(t);
  const begun = await postRecovery(env, '', { action: 'begin', recoveryToken: RECOVERY_TOKEN });
  const cookie = begun.headers.getSetCookie().map((value) => value.split(';', 1)[0]).join('; ');
  const staged = await postRecovery(env, cookie, {
    action: 'stage', appId: 'A12345678', teamId: 'TACME', clientId: '123.456',
    clientSecret: 'client-secret', signingSecret: 'signing-secret',
  });
  const authorization = new URL((await staged.text())
    .match(/data-slack-authorization-link href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&') ?? '');
  const callback = await send(env, 'GET', `${new URL(authorization.searchParams.get('redirect_uri') ?? '').pathname}?${
    new URLSearchParams({ state: authorization.searchParams.get('state') ?? '', code: 'recovery-code' })}`, {
    headers: { cookie },
  });
  assert.equal(callback.status, 200);
  for (const response of [
    await signedEvent(env, 'signing-secret', APP_EVENT),
    await signedEvent(env, 'some-other-secret', URL_VERIFICATION),
    await send(env, 'GET', '/channels/slack/events'),
  ]) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '404 Not Found');
  }
  assert.equal(await getSettingsStore(env).getSetting(SLACK_PENDING_ENVELOPE_SETTING), undefined);
  assert.equal((await getIdentityStore(env).getAuthControl())?.healthGate, 'recovery_only');
});

test('recovery of a regenerated signing secret takes Slack\'s proof signed with the new secret', async (t) => {
  onWorker(t);
  const keyring = generateCredentialKeyring('key_v1');
  const { bindings } = await deploymentBindings();
  const env = {
    TAG_STATE: stateNamespace({}), ...bindings,
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
  } as PlatformEnv;
  await installSlackApp(env);
  // The active bundle still reads, but Slack now signs with a secret it lacks.
  await repairOverHttp(t, env, 'regenerated-signing-secret');
  assert.equal(
    (await resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, env)).signingSecret,
    'regenerated-signing-secret',
  );
  assert.equal((await signedEvent(env, 'regenerated-signing-secret', APP_EVENT)).status, 200);
  assert.equal((await signedEvent(env, 'signing-secret', APP_EVENT)).status, 401);
});

test('Slack\'s ordinary deliveries do not look for a recovery', async (t) => {
  onWorker(t);
  const keyring = generateCredentialKeyring('key_v1');
  const { bindings } = await deploymentBindings();
  const identityKinds: string[] = [];
  const env = {
    TAG_STATE: stateNamespace({}, identityKinds), ...bindings,
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
  } as PlatformEnv;
  await installSlackApp(env);
  identityKinds.length = 0;
  assert.equal((await signedEvent(env, 'signing-secret', APP_EVENT)).status, 200);
  assert.ok(identityKinds.length > 0);
  assert.ok(!identityKinds.includes('get_waiting_slack_recovery_session'), identityKinds.join());
  // Slack's URL check is the one delivery a recovery may be waiting on.
  assert.equal((await signedEvent(env, 'signing-secret', URL_VERIFICATION)).status, 200);
  assert.ok(identityKinds.includes('get_waiting_slack_recovery_session'));
});
