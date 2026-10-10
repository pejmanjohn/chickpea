import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import {
  ACCESS_TOKEN_MARGIN_MS,
  AgentAppSecretsUnreadable,
  ConfigTokenNeeded,
  LostRevision,
  ROTATION_CLAIM_MS,
  agentAppSecretKey,
  configurationTokenKey,
  deleteAppSecrets,
  deleteConfigurationToken,
  hasConfigurationToken,
  readAppSecrets,
  saveConfigurationToken,
  type SecretDeps,
  withConfigurationToken,
  writeAppSecrets,
} from '../src/slack/agent-apps/secrets.ts';
import { SlackRefused } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const TWELVE_HOURS = 12 * 60 * 60_000;
const PASTED = 'xoxe-1-pasted-refresh-token-000';

interface Fixture extends SecretDeps {
  settings: SqliteSettingsStore;
  rotations: string[];
  refuse?: string;
  team: string;
  /** Resolves each rotation on the next macrotask so concurrent callers interleave. */
  slow?: boolean;
}

function fixture(t: TestContext, options: { keyring?: CredentialKeyring; settings?: SqliteSettingsStore; now?: () => number } = {}): Fixture {
  const settings = options.settings ?? new SqliteSettingsStore(':memory:');
  if (!options.settings) t.after(() => settings.close());
  const rotations: string[] = [];
  const fixtureState: Fixture = {
    settings,
    rotations,
    team: TEAM,
    credentials: settings,
    keyring: options.keyring ?? generateCredentialKeyring('k1'),
    now: options.now ?? (() => NOW),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    slack: {
      async rotate(refreshToken) {
        if (fixtureState.slow) await new Promise((resolve) => setImmediate(resolve));
        rotations.push(refreshToken);
        if (fixtureState.refuse) throw new SlackRefused('tooling.tokens.rotate', fixtureState.refuse);
        const n = rotations.length;
        return {
          accessToken: `xoxe.xoxp-1-access-${n}`,
          refreshToken: `xoxe-1-refresh-${n}`,
          teamId: fixtureState.team,
          expiresAt: (fixtureState.now?.() ?? NOW) + TWELVE_HOURS,
        };
      },
    },
  };
  return fixtureState;
}

async function realmRow(settings: SqliteSettingsStore, key: string): Promise<string> {
  return JSON.stringify(await settings.getEncryptedCredentialRevision(key));
}

test('a pasted refresh token rotates once and the pair is stored only in the encrypted realm', async (t) => {
  const d = fixture(t);
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  assert.equal(await saveConfigurationToken(d, TEAM, ` ${PASTED} `), 'saved');
  assert.deepEqual(d.rotations, [PASTED]);
  assert.equal(await hasConfigurationToken(d, TEAM), true);
  assert.equal(await withConfigurationToken(d, TEAM, async (token) => token), 'xoxe.xoxp-1-access-1');
  assert.equal(d.rotations.length, 1, 'a fresh access token is used as is');

  const row = await realmRow(d.settings, configurationTokenKey(TEAM));
  for (const secret of [PASTED, 'xoxe.xoxp-1-access-1', 'xoxe-1-refresh-1']) {
    assert.equal(row.includes(secret), false, 'the realm row never shows the token');
  }
  assert.equal(await d.settings.getSetting(configurationTokenKey(TEAM)), undefined, 'never an ordinary settings row');
});

test('an access token, another workspace, or a refusal stores nothing', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe.xoxp-1-this-is-an-access-token'), 'not_refresh_token');
  assert.deepEqual(d.rotations, [], 'an access token is refused before Slack is asked');

  d.team = 'TOTHER';
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'other_workspace');
  d.team = TEAM;
  d.refuse = 'invalid_refresh_token';
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'rejected');
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded);
});

test('two rotators make one Slack rotation and both use the new token', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  now = NOW + TWELVE_HOURS - ACCESS_TOKEN_MARGIN_MS;
  d.slow = true;
  const [first, second] = await Promise.all([
    withConfigurationToken(d, TEAM, async (token) => token),
    withConfigurationToken(d, TEAM, async (token) => token),
  ]);
  assert.equal(first, 'xoxe.xoxp-1-access-2');
  assert.equal(second, 'xoxe.xoxp-1-access-2');
  assert.deepEqual(d.rotations, [PASTED, 'xoxe-1-refresh-1']);
});

test('a stale claim is taken over, and a held one is waited on three times', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  now = NOW + TWELVE_HOURS;

  // Another rotator claimed and died: the claim is taken over by compare-and-set.
  const stale = fixture(t, { settings: d.settings, keyring: d.keyring, now: () => now - ROTATION_CLAIM_MS - 1 });
  stale.rotations.push('unused-first');
  stale.slack = { async rotate() { throw new Error('the holder died before rotating'); } };
  await assert.rejects(() => withConfigurationToken(stale, TEAM, async () => 'unused'), /holder died/);
  assert.equal(await withConfigurationToken(d, TEAM, async (token) => token), 'xoxe.xoxp-1-access-2');
  assert.deepEqual(d.rotations, [PASTED, 'xoxe-1-refresh-1']);

  // A live claim nobody finishes is re-read three times, then the Owner is asked.
  now = now + TWELVE_HOURS;
  const holder = fixture(t, { settings: d.settings, keyring: d.keyring, now: () => now });
  let reads = 0;
  holder.slack = { async rotate() { return new Promise(() => {}); } };
  void withConfigurationToken(holder, TEAM, async () => 'never');
  await new Promise((resolve) => setImmediate(resolve));
  const waiter = fixture(t, { settings: d.settings, keyring: d.keyring, now: () => now });
  waiter.sleep = async () => { reads += 1; };
  await assert.rejects(() => withConfigurationToken(waiter, TEAM, async () => 'unused'), ConfigTokenNeeded);
  assert.equal(reads, 3);
  assert.deepEqual(waiter.rotations, []);
});

test('a spent pair with no newer one asks the Owner again and is forgotten', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  now = NOW + TWELVE_HOURS;
  d.refuse = 'invalid_refresh_token';
  await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded);
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  assert.deepEqual(d.rotations, [PASTED, 'xoxe-1-refresh-1']);
});

test('a pair that cannot be opened asks the Owner again, and a paste replaces it', async (t) => {
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  assert.equal(await saveConfigurationToken(fixture(t, { settings, keyring: generateCredentialKeyring('k1') }), TEAM, PASTED), 'saved');
  const rekeyed = fixture(t, { settings, keyring: generateCredentialKeyring('k2') });
  await assert.rejects(() => withConfigurationToken(rekeyed, TEAM, async () => 'unused'), ConfigTokenNeeded);
  assert.equal(await saveConfigurationToken(rekeyed, TEAM, PASTED), 'saved');
  assert.equal(await withConfigurationToken(rekeyed, TEAM, async (token) => token), 'xoxe.xoxp-1-access-1');
});

test('removing the token deletes the stored pair and asks for a paste next time, with no Slack call', async (t) => {
  const d = fixture(t);
  assert.equal(await deleteConfigurationToken(d, TEAM), 'none');
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  assert.equal(await deleteConfigurationToken(d, TEAM), 'deleted');
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  assert.equal(await d.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined);
  await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded);
  assert.deepEqual(d.rotations, [PASTED], 'removal and the next start make no Slack call');
});

test('app secrets are written by compare-and-set, extended with the bot token, and deleted once', async (t) => {
  const d = fixture(t);
  const first = await writeAppSecrets(d, 'A0C8APP', 'agent_support', { clientSecret: 'cs', signingSecret: 'ss' }, null);
  assert.deepEqual(await readAppSecrets(d, 'A0C8APP'), {
    agentId: 'agent_support', revision: first, secrets: { clientSecret: 'cs', signingSecret: 'ss' },
  });
  await assert.rejects(
    () => writeAppSecrets(d, 'A0C8APP', 'agent_support', { clientSecret: 'cs', signingSecret: 'ss' }, null),
    LostRevision,
  );
  await assert.rejects(
    () => writeAppSecrets(d, 'A0C8APP', 'agent_support', { clientSecret: 'cs', signingSecret: 'ss' }, 'stale'),
    LostRevision,
  );
  const second = await writeAppSecrets(d, 'A0C8APP', 'agent_support', { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-1' }, first);
  assert.deepEqual((await readAppSecrets(d, 'A0C8APP'))?.secrets, { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-1' });
  const row = await realmRow(d.settings, agentAppSecretKey('A0C8APP'));
  assert.equal(row.includes('xoxb-1'), false);
  await assert.rejects(() => deleteAppSecrets(d, 'A0C8APP', first), LostRevision);
  await deleteAppSecrets(d, 'A0C8APP', second);
  assert.equal(await readAppSecrets(d, 'A0C8APP'), undefined);
  await deleteAppSecrets(d, 'A0C8APP', second);
});

test("an unopenable app envelope fails only that Agent and never the tenant's recovery gate", async (t) => {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => identity.close());
  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  const before = (await identity.getAuthControl())?.healthGate;
  assert.notEqual(before, 'recovery_only');

  const first = fixture(t, { settings, keyring: generateCredentialKeyring('k1') });
  const second = fixture(t, { settings, keyring: generateCredentialKeyring('k2') });
  await writeAppSecrets(first, 'A0C8APPA', 'agent_a', { clientSecret: 'csa', signingSecret: 'ssa' }, null);
  await writeAppSecrets(second, 'A0C8APPB', 'agent_b', { clientSecret: 'csb', signingSecret: 'ssb' }, null);

  await assert.rejects(() => readAppSecrets(second, 'A0C8APPA'), (error: unknown) =>
    error instanceof AgentAppSecretsUnreadable && error.appId === 'A0C8APPA');
  assert.deepEqual((await readAppSecrets(second, 'A0C8APPB'))?.secrets, { clientSecret: 'csb', signingSecret: 'ssb' });
  assert.equal((await identity.getAuthControl())?.healthGate, before);
  assert.equal('identity' in first, false, 'custody never holds the identity store');
});
