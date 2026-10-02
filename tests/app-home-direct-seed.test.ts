import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { Hono } from 'hono';

import { channel as slackChannel } from '../src/channels/slack.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../src/config/types.ts';
import { buildSlackAppManifest, slackManifestFingerprint } from '../src/slack/app-manifest.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { invalidateStoredSlackPublicUrl, resolveSlackPublicUrl } from '../src/slack/credentials.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../src/slack/installation-credentials.ts';
import { stopNodeTurnRelay } from '../src/slack/node-turn-relay.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

/**
 * A customer-owned (direct) install signed in through Slack never makes the
 * unsigned Admin request that stores `slack.publicUrl`; its setup pinned the
 * canonical Admin origin. App Home's "Message <Agent>" still seeds the
 * private thread, with the Agent's avatar from that origin, and with the
 * app's own identity when no origin is known at all.
 */

const ORIGIN = 'https://chickpea-direct.example.workers.dev';
const SIGNING_SECRET = 'direct-app-home-signing-secret';

interface SlackCall {
  method: string;
  body: URLSearchParams;
}

interface Harness {
  stores: AppStores;
  calls: SlackCall[];
  warnings: string[];
  pinCanonicalAdminOrigin(origin: string): Promise<void>;
  start(agentId: string): Promise<Response>;
  settle(until: () => boolean): Promise<void>;
}

async function withDirectInstall(t: TestContext, run: (harness: Harness) => Promise<void>): Promise<void> {
  await stopNodeTurnRelay();
  const keys = [
    'TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH',
    'CHICKPEA_CREDENTIAL_KEYRING_PATH', 'SLACK_TAG_PUBLIC_URL',
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-app-home-direct-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  delete process.env.SLACK_TAG_PUBLIC_URL;
  const previousFetch = globalThis.fetch;
  const warnings: string[] = [];
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  invalidateStoredSlackPublicUrl();
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  t.after(() => {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    invalidateStoredSlackPublicUrl();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  });

  const stores = resolveStores();
  const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'direct', appId: 'A1', botUserId: 'UBOT', teamId: 'T1',
  });
  await stores.config.createAgent({
    id: 'agent_ops', name: 'Ops', instructions: '', enabled: true, lifecycle: 'active',
    creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
    skills: [], mcpServers: [], apiConnections: [], repositories: [],
    slackPresence: {
      requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'unpublished', health: 'unpublished',
      avatar: { kind: 'generated', revision: 1, seed: 'ops' },
    },
  });
  const credentials = { state: stores.identity, keyring: loadCredentialKeyring() };
  const manifestFingerprint = slackManifestFingerprint(
    buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN }),
  );
  const app = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'app_credentials', expectedActiveRevision: null, appId: 'A1', manifestFingerprint,
    secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret: SIGNING_SECRET },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: app.revision, expectedActiveRevision: null,
  });
  const connected = await stageSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: 'connected_credentials', expectedActiveRevision: app.revision,
    appId: 'A1', teamId: 'T1', botUserId: 'UBOT', grantedScopes: ['chat:write'], validatedAt: Date.now(),
    manifestFingerprint,
    secrets: {
      clientId: '123.456', clientSecret: 'client-secret', signingSecret: SIGNING_SECRET,
      botToken: 'xoxb-direct-app-home',
    },
  });
  await promoteSlackCredentialBundle(credentials, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: connected.revision,
    expectedActiveRevision: app.revision,
  });

  const calls: SlackCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const method = new URL(request.url).pathname.split('/').at(-1)!;
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    calls.push({ method, body });
    const user = body.get('user') ?? 'U1';
    const answer = method === 'users.info'
      ? {
          ok: true,
          user: {
            id: user, team_id: 'T1', name: user, deleted: false, is_bot: false, is_app_user: false,
            is_restricted: false, is_ultra_restricted: false, is_stranger: false,
          },
        }
      : method === 'conversations.open'
        ? { ok: true, channel: { id: 'DHOME' } }
        : method.startsWith('chat.')
          ? { ok: true, ts: '1900000000.000100', channel: body.get('channel') ?? 'DHOME' }
          : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;

  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  await run({
    stores,
    calls,
    warnings,
    async pinCanonicalAdminOrigin(origin) {
      const control = await stores.identity.getAuthControl();
      assert.ok(control);
      await stores.identity.updateAuthControl({
        expectedRevision: control.revision,
        canonicalAdminOrigin: origin,
      });
    },
    async start(agentId) {
      const raw = new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions', api_app_id: 'A1', team: { id: 'T1' }, user: { id: 'U1' },
          trigger_id: 'trigger-app-home',
          actions: [{ action_id: 'chickpea.agent.start', value: agentId, action_ts: '1800000007.000100' }],
        }),
      }).toString();
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const signature = createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
      return ingress.request('/channels/slack/interactions', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': timestamp,
          'x-slack-signature': `v0=${signature}`,
        },
        body: raw,
      });
    },
    async settle(until) {
      for (let tries = 0; tries < 200; tries += 1) {
        if (until()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail('detached Slack work did not settle');
    },
  });
}

test('App Home seeds an Agent thread with its avatar from the pinned Admin origin', async (t) => {
  await withDirectInstall(t, async (h) => {
    await h.pinCanonicalAdminOrigin(ORIGIN);
    assert.equal((await h.start('agent_ops')).status, 200);
    await h.settle(() => h.calls.some(({ method }) => method === 'chat.postMessage'));
    const posted = h.calls.find(({ method }) => method === 'chat.postMessage')!;
    assert.equal(posted.body.get('channel'), 'DHOME');
    assert.equal(posted.body.get('text'), 'Ops is ready.');
    assert.equal(posted.body.get('username'), 'Ops');
    assert.equal(posted.body.get('icon_url'), `${ORIGIN}/assets/agents/agent_ops/avatar/1`);
    assert.deepEqual(h.warnings.filter((line) => /App Home starter/.test(line)), []);
  });
});

test('App Home seeds an Agent thread as the app when no public origin is known', async (t) => {
  await withDirectInstall(t, async (h) => {
    assert.equal((await h.start('agent_ops')).status, 200);
    await h.settle(() => h.calls.some(({ method }) => method === 'chat.postMessage'));
    const posted = h.calls.find(({ method }) => method === 'chat.postMessage')!;
    assert.equal(posted.body.get('channel'), 'DHOME');
    assert.equal(posted.body.get('text'), 'Ops is ready.');
    assert.equal(posted.body.get('username'), null);
    assert.equal(posted.body.get('icon_url'), null);
    assert.equal(h.warnings.filter((line) => /App Home starter posted as the app/.test(line)).length, 1);
  });
});

test('the public URL falls back to a standalone install\'s canonical Admin origin, after env and stored', async (t) => {
  await withDirectInstall(t, async (h) => {
    assert.equal(await resolveSlackPublicUrl(undefined, h.stores.settings), undefined);
    await h.pinCanonicalAdminOrigin(ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, h.stores.settings), ORIGIN);
    await h.stores.settings.setSetting('slack.publicUrl', 'https://stored.example/');
    assert.equal(await resolveSlackPublicUrl(undefined, h.stores.settings), 'https://stored.example');
    assert.equal(
      await resolveSlackPublicUrl({ SLACK_TAG_PUBLIC_URL: 'https://env.example' }, h.stores.settings),
      'https://env.example',
    );
    await h.stores.settings.deleteSetting('slack.publicUrl');
    // A caller inside the state store reads its own local identity, not a proxy.
    const local = {
      getAuthControl: async () => ({ canonicalAdminOrigin: 'https://local.example' }) as never,
    };
    assert.equal(await resolveSlackPublicUrl(undefined, h.stores.settings, local), 'https://local.example');
    // A host serving many installations names its own public URL.
    const hosted = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
    assert.equal(await resolveSlackPublicUrl(hosted, h.stores.settings), undefined);
  });
});
