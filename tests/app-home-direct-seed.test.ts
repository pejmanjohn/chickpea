import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import type { AppStores } from '../src/config/state-backend.ts';
import type { AuthControl } from '../src/identity/types.ts';
import { resolveSlackPublicUrl } from '../src/slack/credentials.ts';
import { withDirectSlackInstall, type DirectSlackInstall } from './helpers/direct-slack-install.ts';

/**
 * A customer-owned (direct) install signed in through Slack never makes the
 * unsigned Admin request that stores `slack.publicUrl`. Setup steps now store
 * the canonical origin they pin; an install set up before that has it
 * backfilled once from the pinned origin, after which no identity read
 * happens. App Home's "Message <Agent>" seeds the private thread with the
 * Agent's avatar, or as the app when no origin is known at all.
 */

const ORIGIN = 'https://chickpea-direct.example.workers.dev';

async function withAppHomeInstall(
  t: TestContext,
  run: (install: DirectSlackInstall & { warnings: string[] }) => Promise<void>,
): Promise<void> {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); });
  await withDirectSlackInstall({
    origin: ORIGIN,
    answer: (method, body) => {
      const user = body.get('user') ?? 'U1';
      return method === 'users.info'
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
            : undefined;
    },
  }, async (install) => {
    await install.stores.config.createAgent({
      id: 'agent_ops', name: 'Ops', instructions: '', enabled: true, lifecycle: 'active',
      creatorMembershipId: install.ownerMembershipId, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'ops', normalizedHandle: 'ops', desiredState: 'unpublished', health: 'unpublished',
        avatar: { kind: 'generated', revision: 1, seed: 'ops' },
      },
    });
    await run({ ...install, warnings });
  });
}

async function pinCanonicalAdminOrigin(stores: AppStores, origin: string): Promise<void> {
  const control = await stores.identity.getAuthControl();
  assert.ok(control);
  await stores.identity.updateAuthControl({ expectedRevision: control.revision, canonicalAdminOrigin: origin });
}

function startAgent(install: DirectSlackInstall): Promise<Response> {
  return install.deliver('interactions', {
    type: 'block_actions', api_app_id: 'A1', team: { id: 'T1' }, user: { id: 'U1' },
    trigger_id: 'trigger-app-home',
    actions: [{ action_id: 'chickpea.agent.start', value: 'agent_ops', action_ts: '1800000007.000100' }],
  });
}

async function starterPost(install: DirectSlackInstall): Promise<URLSearchParams> {
  for (let tries = 0; tries < 200; tries += 1) {
    const posted = install.calls.find(({ method }) => method === 'chat.postMessage');
    if (posted) return posted.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the App Home starter was not posted');
}

/** An identity port that counts its reads. */
function countingIdentity(canonicalAdminOrigin: string | null) {
  const counter = { reads: 0 };
  return Object.assign(counter, {
    async getAuthControl() {
      counter.reads += 1;
      return { canonicalAdminOrigin } as AuthControl;
    },
  });
}

test('App Home seeds an Agent thread with its avatar, backfilling the pinned origin once', async (t) => {
  await withAppHomeInstall(t, async (install) => {
    await pinCanonicalAdminOrigin(install.stores, ORIGIN);
    assert.equal((await startAgent(install)).status, 200);
    const posted = await starterPost(install);
    assert.equal(posted.get('channel'), 'DHOME');
    assert.equal(posted.get('text'), 'Ops is ready.');
    assert.equal(posted.get('username'), 'Ops');
    assert.equal(posted.get('icon_url'), `${ORIGIN}/assets/agents/agent_ops/avatar/1`);
    assert.equal(await install.stores.settings.getSetting('slack.publicUrl'), ORIGIN);
    assert.deepEqual(install.warnings.filter((line) => /App Home starter/.test(line)), []);
  });
});

test('App Home seeds an Agent thread as the app when no public origin is known', async (t) => {
  await withAppHomeInstall(t, async (install) => {
    assert.equal((await startAgent(install)).status, 200);
    const posted = await starterPost(install);
    assert.equal(posted.get('channel'), 'DHOME');
    assert.equal(posted.get('text'), 'Ops is ready.');
    assert.equal(posted.get('username'), null);
    assert.equal(posted.get('icon_url'), null);
    assert.equal(install.warnings.filter((line) => /App Home starter posted as the app/.test(line)).length, 1);
  });
});

test('the public URL is backfilled once from the pinned origin, and never read from identity otherwise', async (t) => {
  await withAppHomeInstall(t, async ({ stores }) => {
    // A caller without an identity port (a runner's prefetch, the state
    // store's alarm executor and ledger driver) never resolves one, so it
    // makes no identity read and no call from the state store to itself.
    await pinCanonicalAdminOrigin(stores, ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings), undefined);
    assert.equal(await stores.settings.getSetting('slack.publicUrl'), undefined);

    // A host serving many installations names its own public URL.
    const hostedIdentity = countingIdentity(ORIGIN);
    const hosted = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_a' });
    assert.equal(await resolveSlackPublicUrl(hosted, stores.settings, hostedIdentity), undefined);
    assert.equal(hostedIdentity.reads, 0);

    // The first identity-carrying call stores the pinned origin; later ones
    // answer from the stored URL alone.
    const identity = countingIdentity(ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings, identity), ORIGIN);
    assert.equal(await stores.settings.getSetting('slack.publicUrl'), ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings, identity), ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings), ORIGIN);
    assert.equal(identity.reads, 1);

    // A stored URL wins over the pinned origin, and the env pin over both.
    await stores.settings.setSetting('slack.publicUrl', 'https://stored.example/');
    const unread = countingIdentity(ORIGIN);
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings, unread), 'https://stored.example');
    assert.equal(
      await resolveSlackPublicUrl({ SLACK_TAG_PUBLIC_URL: 'https://env.example' }, stores.settings, unread),
      'https://env.example',
    );
    assert.equal(unread.reads, 0);
  });
});

test('a failed backfill resolves no public URL, logged once, rather than failing the turn', async (t) => {
  await withAppHomeInstall(t, async ({ stores, warnings }) => {
    const unreadable = {
      async getAuthControl(): Promise<AuthControl> { throw new Error('state store unavailable'); },
    };
    assert.equal(await resolveSlackPublicUrl(undefined, stores.settings, unreadable), undefined);
    const unwritable = Object.create(stores.settings) as typeof stores.settings;
    unwritable.applySettingsPatch = async () => { throw new Error('settings write refused'); };
    assert.equal(await resolveSlackPublicUrl(undefined, unwritable, countingIdentity(ORIGIN)), undefined);
    assert.equal(await stores.settings.getSetting('slack.publicUrl'), undefined);
    assert.equal(warnings.filter((line) => /Slack public URL backfill failed/.test(line)).length, 1);
  });
});
