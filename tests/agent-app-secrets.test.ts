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
  configurationTokenStatus,
  discardConfigurationToken,
  hasConfigurationToken,
  readAppSecrets,
  readOwnAppSecrets,
  saveConfigurationToken,
  type SecretDeps,
  withConfigurationToken,
  writeAppSecrets,
} from '../src/slack/agent-apps/secrets.ts';
import { type RotatedConfigurationToken, SlackRefused, SlackUnavailable, createAgentAppSlackApi } from '../src/slack/agent-apps/slack-api.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { CredentialKeyring } from '../src/slack/secret-envelope.ts';

const NOW = 1_800_000_000_000;
const TEAM = 'TACME';
const TWELVE_HOURS = 12 * 60 * 60_000;
const PASTED = 'xoxe-1-pasted-refresh-token-000';
const OWNER = 'UOWNER';

/**
 * Slack's configuration tokens. Each Generate Token starts a chain for one
 * person and workspace. A rotation spends its refresh token, and revokes the
 * access token two before the one it returns; that it does so for one that
 * has already expired too is assumed here, not measured. auth.revoke ends an
 * access token that has not expired, or a refresh token whose own access
 * token has not expired; one already revoked is done (the port reads Slack's
 * `token_revoked` so), and otherwise Slack answers `token_expired`. Slack
 * lists a token while the person holds any access token for the workspace
 * that is not revoked, expired ones included, and its row shows the newest of
 * those with the newest refresh token not revoked.
 */
interface SlackTokens {
  rotate(refreshToken: string): Promise<RotatedConfigurationToken>;
  revoke(token: string): Promise<void>;
  generate(refreshToken: string, person: string, team: string): void;
  listed(person: string, team: string): boolean;
  /** The row Your Apps shows for this person and workspace, if any. */
  shown(person: string, team: string): { accessToken: string; refreshToken: string } | undefined;
  /** Slack's own Delete on that row: the refresh token is revoked, then the access token. */
  slackDelete(person: string, team: string): Promise<void>;
  /** Slack takes this access token on an ordinary call. */
  accepts(accessToken: string): boolean;
  /** Slack rotates this refresh token. */
  rotates(refreshToken: string): boolean;
  calls: Array<{ method: 'rotate' | 'revoke'; token: string }>;
  /** Asked before each call acts; an error returned is thrown instead. */
  fault?: ((call: TokenCall) => Error | undefined) | undefined;
  /** Asked after each call acts; an error returned is thrown in place of Slack's answer. */
  lost?: ((call: TokenCall) => Error | undefined) | undefined;
}

interface TokenCall { method: 'rotate' | 'revoke'; token: string; index: number }
interface Chain { person: string; team: string; access: string[]; refresh: string[] }

function slackTokens(now: () => number, rotations: string[], flags: () => { refuse?: string | undefined; slow?: boolean | undefined }): SlackTokens {
  const access = new Map<string, { chain: Chain; revoked: boolean; expiresAt: number }>();
  const refresh = new Map<string, { chain: Chain; access: string; spent: boolean; revoked: boolean }>();
  const chains: Chain[] = [];
  const issue = (chain: Chain, accessToken: string, refreshToken: string) => {
    access.set(accessToken, { chain, revoked: false, expiresAt: now() + TWELVE_HOURS });
    chain.access.push(accessToken);
    refresh.set(refreshToken, { chain, access: accessToken, spent: false, revoked: false });
    chain.refresh.push(refreshToken);
  };
  const listedChain = (person: string, team: string) => chains.findLast((chain) => chain.person === person && chain.team === team &&
    chain.access.some((token) => !access.get(token)!.revoked));
  const revokeNow = (token: string) => {
    const a = access.get(token);
    if (a) {
      if (a.revoked) return;
      if (now() >= a.expiresAt) throw new SlackRefused('auth.revoke', 'token_expired');
      a.revoked = true;
      return;
    }
    const r = refresh.get(token);
    if (!r) throw new SlackRefused('auth.revoke', 'invalid_auth');
    if (r.revoked) return;
    if (now() >= access.get(r.access)!.expiresAt) throw new SlackRefused('auth.revoke', 'token_expired');
    r.revoked = true;
  };
  const fakes: SlackTokens = {
    calls: [],
    generate(refreshToken, person, team) {
      assert.equal(fakes.listed(person, team), false, 'Generate Token is unavailable while Slack lists a token');
      const chain: Chain = { person, team, access: [], refresh: [] };
      chains.push(chain);
      issue(chain, `xoxe.xoxp-1-generated-${chains.length}`, refreshToken);
    },
    async rotate(refreshToken) {
      if (flags().slow) await new Promise((resolve) => setImmediate(resolve));
      rotations.push(refreshToken);
      const call: TokenCall = { method: 'rotate', token: refreshToken, index: fakes.calls.length };
      const fault = fakes.fault?.(call);
      fakes.calls.push({ method: 'rotate', token: refreshToken });
      if (fault) throw fault;
      const refuse = flags().refuse;
      if (refuse) throw new SlackRefused('tooling.tokens.rotate', refuse);
      const held = refresh.get(refreshToken);
      if (!held || held.spent || held.revoked) throw new SlackRefused('tooling.tokens.rotate', 'invalid_refresh_token');
      held.spent = true;
      const n = rotations.length;
      const accessToken = `xoxe.xoxp-1-access-${n}`;
      const next = `xoxe-1-refresh-${n}`;
      issue(held.chain, accessToken, next);
      const retired = held.chain.access.at(-3);
      if (retired) access.get(retired)!.revoked = true;
      const lost = fakes.lost?.(call);
      if (lost) throw lost;
      return { accessToken, refreshToken: next, teamId: held.chain.team, expiresAt: access.get(accessToken)!.expiresAt };
    },
    async revoke(token) {
      const call: TokenCall = { method: 'revoke', token, index: fakes.calls.length };
      const fault = fakes.fault?.(call);
      fakes.calls.push({ method: 'revoke', token });
      if (fault) throw fault;
      revokeNow(token);
      const lost = fakes.lost?.(call);
      if (lost) throw lost;
    },
    listed: (person, team) => listedChain(person, team) !== undefined,
    shown(person, team) {
      const chain = listedChain(person, team);
      const accessToken = chain?.access.findLast((token) => !access.get(token)!.revoked);
      const refreshToken = chain?.refresh.findLast((token) => !refresh.get(token)!.revoked);
      return accessToken && refreshToken ? { accessToken, refreshToken } : undefined;
    },
    async slackDelete(person, team) {
      const row = fakes.shown(person, team);
      assert.ok(row, 'Slack shows a row to delete');
      revokeNow(row.refreshToken);
      revokeNow(row.accessToken);
    },
    accepts: (accessToken) => {
      const a = access.get(accessToken);
      return !!a && !a.revoked && now() < a.expiresAt;
    },
    rotates: (refreshToken) => {
      const r = refresh.get(refreshToken);
      return !!r && !r.spent && !r.revoked;
    },
  };
  return fakes;
}

interface Fixture extends SecretDeps {
  settings: SqliteSettingsStore;
  rotations: string[];
  refuse?: string;
  /** Resolves each rotation on the next macrotask so concurrent callers interleave. */
  slow?: boolean;
  tokens: SlackTokens;
}

function fixture(t: TestContext, options: { keyring?: CredentialKeyring; settings?: SqliteSettingsStore; now?: () => number } = {}): Fixture {
  const settings = options.settings ?? new SqliteSettingsStore(':memory:');
  if (!options.settings) t.after(() => settings.close());
  const rotations: string[] = [];
  const now = options.now ?? (() => NOW);
  let flags: { refuse?: string | undefined; slow?: boolean | undefined } = {};
  const tokens = slackTokens(now, rotations, () => flags);
  const fixtureState: Fixture = {
    settings,
    rotations,
    credentials: settings,
    keyring: options.keyring ?? generateCredentialKeyring('k1'),
    now,
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    tokens,
    slack: tokens,
  };
  flags = fixtureState;
  tokens.generate(PASTED, OWNER, TEAM);
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

  d.tokens.generate('xoxe-1-other-workspace-token-000', OWNER, 'TOTHER');
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-other-workspace-token-000'), 'other_workspace');
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
  stale.slack = { ...stale.tokens, async rotate() { throw new Error('the holder died before rotating'); } };
  await assert.rejects(() => withConfigurationToken(stale, TEAM, async () => 'unused'), /holder died/);
  assert.equal(await withConfigurationToken(d, TEAM, async (token) => token), 'xoxe.xoxp-1-access-2');
  assert.deepEqual(d.rotations, [PASTED, 'xoxe-1-refresh-1']);

  // A live claim nobody finishes is re-read three times, then reads as Slack not answering: the token is not known to
  // be bad, so the caller retries and nobody is asked for a new one.
  now = now + TWELVE_HOURS;
  const holder = fixture(t, { settings: d.settings, keyring: d.keyring, now: () => now });
  let reads = 0;
  holder.slack = { ...holder.tokens, async rotate() { return new Promise(() => {}); } };
  void withConfigurationToken(holder, TEAM, async () => 'never');
  await new Promise((resolve) => setImmediate(resolve));
  const waiter = fixture(t, { settings: d.settings, keyring: d.keyring, now: () => now });
  waiter.sleep = async () => { reads += 1; };
  await assert.rejects(() => withConfigurationToken(waiter, TEAM, async () => 'unused'), (error: unknown) =>
    error instanceof SlackUnavailable && error.reason === 'rotation_claimed');
  assert.equal(reads, 3);
  assert.deepEqual(waiter.rotations, []);
  assert.equal(await hasConfigurationToken(d, TEAM), true, 'the pair is kept');
});

// Defects caught: a rate-limited rotation, or any refusal that is not a spent refresh token, deleting the customer's
// token and asking an Owner for a new one, when the next try would have worked.
for (const code of ['ratelimited', 'request_timeout', 'invalid_arguments']) {
  test(`a rotation Slack answers ${code} keeps the pair, reads as Slack not answering, and the next try rotates it`, async (t) => {
    let now = NOW;
    const d = fixture(t, { now: () => now });
    assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
    now = NOW + TWELVE_HOURS;
    d.refuse = code;
    await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), (error: unknown) =>
      error instanceof SlackUnavailable && error.reason === code);
    assert.equal(await hasConfigurationToken(d, TEAM), true, 'the pair is kept');
    delete d.refuse;
    now += ROTATION_CLAIM_MS;
    assert.equal(await withConfigurationToken(d, TEAM, async (token) => token), 'xoxe.xoxp-1-access-3', 'once the claim lapses');
  });
}

// Defects caught: a token Slack says is dead read as Slack not answering, so every caller waits forever and nobody is
// asked for a token; or the pair deleted for it; or its claim left standing, so the next caller reads Slack not answering.
for (const code of ['token_revoked', 'invalid_auth', 'account_inactive']) {
  test(`a rotation Slack answers ${code} asks for a token at once, for every caller, and keeps the pair`, async (t) => {
    let now = NOW;
    const d = fixture(t, { now: () => now });
    assert.equal(await saveConfigurationToken(d, TEAM, PASTED, 'UOWNER'), 'saved');
    now = NOW + TWELVE_HOURS;
    d.refuse = code;
    await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded);
    await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded, 'the claim is released');
    assert.deepEqual(d.rotations, [PASTED, 'xoxe-1-refresh-1', 'xoxe-1-refresh-1']);
    assert.deepEqual(await configurationTokenStatus(d, TEAM), { stored: true, pastedBy: 'UOWNER', pastedAt: NOW }, 'the pair is kept');
  });
}

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

test('removing a freshly pasted token leaves Slack listing nothing, so its Owner can generate another; then it asks for a paste', async (t) => {
  const d = fixture(t);
  assert.equal(await discardConfigurationToken(d, TEAM), 'none');
  assert.deepEqual(d.tokens.calls, [], 'nothing stored, nothing to end');
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED, OWNER), 'saved');
  assert.equal(d.tokens.listed(OWNER, TEAM), true);
  assert.deepEqual(await configurationTokenStatus(d, TEAM), { stored: true, pastedBy: OWNER, pastedAt: NOW });
  assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
  assert.equal(d.tokens.listed(OWNER, TEAM), false, 'Slack lists nothing');
  d.tokens.generate('xoxe-1-generated-again-token-000', OWNER, TEAM);
  assert.equal(await hasConfigurationToken(d, TEAM), false, 'and no pair Slack returned is stored');
  assert.deepEqual(await configurationTokenStatus(d, TEAM), { stored: false });
  const calls = d.tokens.calls.length;
  await assert.rejects(() => withConfigurationToken(d, TEAM, async () => 'unused'), ConfigTokenNeeded);
  assert.equal(d.tokens.calls.length, calls, 'the next start makes no Slack call');
  assert.equal(await discardConfigurationToken(d, TEAM), 'none', 'a second removal makes no claim');
});

// The fake assumes a rotation also revokes an access token that had already expired; this test is only as true as that.
test('removing a pair whose access tokens expired long ago still leaves Slack listing nothing', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  now = NOW + 30 * TWELVE_HOURS;
  assert.equal(d.tokens.listed(OWNER, TEAM), true, 'expired access tokens are still listed');
  assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
  assert.equal(d.tokens.listed(OWNER, TEAM), false);
});

test('a paste over another person\'s stored token ends that person\'s chain, and the new pair works', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED, OWNER), 'saved');
  d.tokens.generate('xoxe-1-second-owner-token-000', 'USECOND', TEAM);
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-second-owner-token-000', 'USECOND'), 'saved');
  assert.equal(d.tokens.listed(OWNER, TEAM), false, 'the first Owner can generate a token again');
  const access = await withConfigurationToken(d, TEAM, async (token) => token);
  assert.equal(d.tokens.accepts(access), true, 'the new pair works');
  assert.equal(d.tokens.listed('USECOND', TEAM), true);
});

// Defect caught: ending the replaced chain when the Owner pasted the newest token of that same chain, which revokes
// the pair just stored and leaves the workspace with no working token.
test('pasting the newest token of the chain Chickpea already holds keeps the new pair working', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-refresh-1'), 'saved', 'the stored refresh token itself, copied from Slack');
  now = NOW + TWELVE_HOURS;
  const rotated = await withConfigurationToken(d, TEAM, async (token) => token);
  assert.equal(d.tokens.accepts(rotated), true, 'the pair from that paste rotates and works');

  // Slack rotated once more and Chickpea never heard the answer; the Owner copies the newest token from Slack.
  const { refreshToken: newest } = await d.tokens.rotate('xoxe-1-refresh-3');
  const revokes = d.tokens.calls.filter((call) => call.method === 'revoke').length;
  assert.equal(await saveConfigurationToken(d, TEAM, newest), 'saved');
  assert.equal(d.tokens.calls.filter((call) => call.method === 'revoke').length, revokes, 'nothing is revoked');
  const access = await withConfigurationToken(d, TEAM, async (token) => token);
  assert.equal(d.tokens.accepts(access), true, 'the new pair works');
  now += TWELVE_HOURS;
  assert.equal(d.tokens.accepts(await withConfigurationToken(d, TEAM, async (token) => token)), true, 'and its refresh token rotates');
});

test('a token for another workspace leaves that workspace listing nothing and stores nothing', async (t) => {
  const d = fixture(t);
  d.tokens.generate('xoxe-1-other-workspace-token-000', OWNER, 'TOTHER');
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-other-workspace-token-000'), 'other_workspace');
  assert.equal(d.tokens.listed(OWNER, 'TOTHER'), false);
  assert.equal(await hasConfigurationToken(d, TEAM), false);
});

// Defect caught: a token for another workspace whose end at Slack fails, leaving that workspace a listed token whose
// refresh token no longer rotates, or storing it here.
test('a token for another workspace whose end at Slack fails is still not stored, and pasting the token Slack lists there ends it', async (t) => {
  const d = fixture(t);
  d.tokens.generate('xoxe-1-other-workspace-token-000', OWNER, 'TOTHER');
  const from = d.tokens.calls.length;
  d.tokens.fault = (call) => call.index - from === 1 ? new SlackUnavailable('tooling.tokens.rotate', 'network_error') : undefined;
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-other-workspace-token-000'), 'other_workspace');
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  delete d.tokens.fault;
  const row = d.tokens.shown(OWNER, 'TOTHER');
  assert.ok(row && d.tokens.rotates(row.refreshToken), 'that workspace lists a token whose Refresh Token still rotates');
  assert.equal(await saveConfigurationToken(d, TEAM, row.refreshToken), 'other_workspace');
  assert.equal(d.tokens.listed(OWNER, 'TOTHER'), false);
  assert.equal(await hasConfigurationToken(d, TEAM), false);
});

const STEPS = ['first rotation', 'second rotation', 'newest access token', 'earlier access token', 'refresh token'] as const;
const AGES = [['freshly stored', 0], ['stored long ago', 30 * TWELVE_HOURS]] as const;
// Defects caught: a step that fails and lets a later one run; a removal that keeps the stored copy; and a failure that
// leaves Slack listing a token with no refresh token that rotates, so the route Admin names (paste the listed Refresh
// Token, remove again) cannot end it. "answer lost" is Slack acting and the answer never arriving.
for (const [step, name] of STEPS.entries()) {
  for (const kind of ['refused', 'unanswered', 'answer lost'] as const) {
    for (const [age, after] of AGES) {
      test(`a removal of a pair ${age} whose ${name} step is ${kind} stops there, and Admin's route ends what Slack still lists`, async (t) => {
        let now = NOW;
        const d = fixture(t, { now: () => now });
        assert.equal(await saveConfigurationToken(d, TEAM, PASTED, OWNER), 'saved');
        now += after;
        const from = d.tokens.calls.length;
        const method = step < 2 ? 'rotate' : 'revoke';
        const failing = (call: TokenCall) => call.index - from === step || (kind !== 'refused' && method === 'revoke' && call.index - from === step + 1);
        const failure = () => kind === 'refused'
          ? new SlackRefused(method === 'rotate' ? 'tooling.tokens.rotate' : 'auth.revoke', 'invalid_auth')
          : new SlackUnavailable(method, 'network_error');
        if (kind === 'answer lost') d.tokens.lost = (call) => failing(call) ? failure() : undefined;
        else d.tokens.fault = (call) => failing(call) ? failure() : undefined;
        const warn = t.mock.method(console, 'warn', () => undefined);
        assert.equal(await discardConfigurationToken(d, TEAM), step === 0 ? 'unconfirmed' : 'left_listed');
        const made = d.tokens.calls.slice(from).map((call) => call.method);
        const expected = ['rotate', 'rotate', 'revoke', 'revoke', 'revoke'].slice(0, step + 1);
        if (kind !== 'refused' && method === 'revoke') expected.push('revoke');
        assert.deepEqual(made, expected, 'a revoke Slack did not answer is tried once more, a rotation never, and nothing follows the failure');
        assert.equal(await hasConfigurationToken(d, TEAM), false, 'the stored copy is deleted');
        assert.equal(await discardConfigurationToken(d, TEAM), 'none');
        assert.equal(JSON.stringify(warn.mock.calls).includes('xoxe'), false, 'no token is logged');

        delete d.tokens.fault;
        delete d.tokens.lost;
        const row = d.tokens.shown(OWNER, TEAM);
        if (row) {
          assert.equal(await saveConfigurationToken(d, TEAM, row.refreshToken, OWNER), 'saved', 'the Refresh Token Slack shows still rotates');
          assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
        }
        assert.equal(d.tokens.listed(OWNER, TEAM), false, 'nothing is listed at the end');
        d.tokens.generate('xoxe-1-generated-again-token-000', OWNER, TEAM);
      });
    }
  }
}

// Why Admin never names Slack's own Delete: after a second rotation Slack refused, of a pair stored long ago, Delete
// clears the newest row and the list falls back to an expired access token whose refresh token is spent.
test('Slack\'s own Delete after a removal stopped at its second rotation can leave a token nobody can delete or replace', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED, OWNER), 'saved');
  now += 30 * TWELVE_HOURS;
  const from = d.tokens.calls.length;
  d.tokens.fault = (call) => call.index - from === 1 ? new SlackRefused('tooling.tokens.rotate', 'ratelimited') : undefined;
  assert.equal(await discardConfigurationToken(d, TEAM), 'left_listed');
  delete d.tokens.fault;
  await d.tokens.slackDelete(OWNER, TEAM);
  const row = d.tokens.shown(OWNER, TEAM);
  assert.ok(row, 'Slack still lists a token');
  assert.equal(d.tokens.rotates(row.refreshToken), false, 'and its Refresh Token no longer rotates');
  await assert.rejects(() => d.tokens.slackDelete(OWNER, TEAM), (error: unknown) => error instanceof SlackRefused && error.code === 'token_expired');
});

test('a revoke Slack does not answer once and then confirms still ends the chain', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  let dropped = false;
  d.tokens.fault = (call) => call.method === 'revoke' && !dropped ? (dropped = true, new SlackUnavailable('auth.revoke', 'network_error')) : undefined;
  assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
  assert.equal(d.tokens.listed(OWNER, TEAM), false);
});

test('no path that ends a chain logs a token', async (t) => {
  const lines: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { lines.push(args); });
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  d.tokens.generate('xoxe-1-second-owner-token-000', 'USECOND', TEAM);
  d.tokens.fault = (call) => call.method === 'revoke' ? new SlackRefused('auth.revoke', 'token_expired') : undefined;
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-second-owner-token-000'), 'saved');
  d.tokens.generate('xoxe-1-other-workspace-token-000', OWNER, 'TOTHER');
  d.tokens.fault = (call) => call.method === 'rotate' && call.token !== 'xoxe-1-other-workspace-token-000' ? new SlackUnavailable('tooling.tokens.rotate', 'network_error') : undefined;
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-other-workspace-token-000'), 'other_workspace');
  d.tokens.fault = (call) => call.method === 'revoke' ? new Error('a fault in the client') : undefined;
  assert.equal(await discardConfigurationToken(d, TEAM), 'left_listed');
  assert.ok(lines.length >= 3, 'each stop is logged');
  assert.equal(JSON.stringify(lines).includes('xoxe'), false, 'no token is logged');
});

// Defect caught: Slack's `errors` list on a token call reaching a log line, where it could quote the token sent.
test('a refusal of a token call that quotes the token sent logs only its step and code', async (t) => {
  const lines: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) t.mock.method(console, method, (...args: unknown[]) => { lines.push(args); });
  let rotations = 0;
  const port = (refuse: 'tooling.tokens.rotate' | 'auth.revoke') => createAgentAppSlackApi({
    apiBaseUrl: 'https://slack.test/api',
    fetch: async (input, init) => {
      const method = String(input).slice('https://slack.test/api/'.length);
      const sent = [...new URLSearchParams(String(init?.body)).values()][0];
      if (method === refuse) {
        return Response.json({ ok: false, error: 'invalid_auth', errors: [{ message: `not a token: ${sent}`, pointer: '/token' }] });
      }
      rotations += 1;
      return Response.json({ ok: true, token: `xoxe.xoxp-1-port-access-${rotations}`, refresh_token: `xoxe-1-port-refresh-${rotations}`, team_id: TEAM, exp: NOW / 1_000 + 43_200 });
    },
  });
  const d = fixture(t);
  assert.equal(await saveConfigurationToken({ ...d, slack: port('tooling.tokens.rotate') }, TEAM, PASTED), 'rejected', 'the paste');
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  assert.equal(await discardConfigurationToken({ ...d, slack: port('tooling.tokens.rotate') }, TEAM), 'unconfirmed', 'a removal stopped at a rotation');
  assert.equal(await saveConfigurationToken({ ...d, slack: port('auth.revoke') }, TEAM, 'xoxe-1-another-pasted-token-000'), 'saved');
  assert.equal(await discardConfigurationToken({ ...d, slack: port('auth.revoke') }, TEAM), 'left_listed', 'a removal stopped at a revoke');
  const refusals = lines.map((line) => (line as [Record<string, unknown>])[0]).filter((line) => line?.event === 'chickpea.agent_app.slack_refused');
  assert.deepEqual(refusals.map((line) => [line.step, line.code, line.errors]), [
    ['rotate', 'invalid_auth', []], ['rotate', 'invalid_auth', []], ['revoke', 'invalid_auth', []],
  ]);
  assert.equal(JSON.stringify(lines).includes('xoxe'), false, 'no token is logged');
});

test('a refused rotation still deletes the stored copy and says so; so does a pair that cannot be opened', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  d.refuse = 'invalid_refresh_token';
  assert.equal(await discardConfigurationToken(d, TEAM), 'unconfirmed');
  assert.equal(await hasConfigurationToken(d, TEAM), false);

  const settings = new SqliteSettingsStore(':memory:');
  t.after(() => settings.close());
  assert.equal(await saveConfigurationToken(fixture(t, { settings, keyring: generateCredentialKeyring('k1') }), TEAM, PASTED), 'saved');
  const rekeyed = fixture(t, { settings, keyring: generateCredentialKeyring('k2') });
  assert.deepEqual(await configurationTokenStatus(rekeyed, TEAM), { stored: false }, 'an unopenable pair reads as none');
  assert.equal(await discardConfigurationToken(rekeyed, TEAM), 'unconfirmed');
  assert.deepEqual(rekeyed.rotations, []);
  assert.equal(await settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined);
});

test('who pasted the token, and when, is kept through every rotation', async (t) => {
  let now = NOW;
  const d = fixture(t, { now: () => now });
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED, 'UOWNER'), 'saved');
  now = NOW + TWELVE_HOURS;
  assert.equal(await withConfigurationToken(d, TEAM, async (token) => token), 'xoxe.xoxp-1-access-2');
  assert.deepEqual(await configurationTokenStatus(d, TEAM), { stored: true, pastedBy: 'UOWNER', pastedAt: NOW });
});

test('removing the token when the removal rotates first: the rotation is refused, forgets the pair, and the removal ended the chain', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  const rotator: SecretDeps = { ...d, now: () => NOW + TWELVE_HOURS };
  let rotations = 1;
  d.credentials = Object.assign(Object.create(d.settings) as SqliteSettingsStore, {
    async deleteEncryptedCredentialRevision(key: string, expected: string) {
      // The removal already spent the stored refresh token; a rotation claims the pair before the removal deletes it.
      if (rotations-- > 0) await assert.rejects(() => withConfigurationToken(rotator, TEAM, async () => 'rotated'), ConfigTokenNeeded);
      return d.settings.deleteEncryptedCredentialRevision(key, expected);
    },
  });
  assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
  assert.equal(await d.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined, 'nothing is stored');
  assert.deepEqual(d.rotations.slice(1), ['xoxe-1-refresh-1', 'xoxe-1-refresh-2', 'xoxe-1-refresh-1'],
    'the removal ended the stored chain, and Slack refused the rotation that came second');
  assert.equal(d.tokens.listed(OWNER, TEAM), false);
});

// The removal tried the stored refresh token, which the rotation had spent, then ended the newer chain. Slack lists
// nothing, but the answer stays the more cautious of the two: a removal cannot tell a token another caller spent on
// the same chain from one Slack refused for another reason.
test('removing the token when a rotation rotates first: the removal ends the newer pair, Slack lists nothing, and the answer errs cautious; a pair that keeps changing is reported', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  const rotator: SecretDeps = { ...d, now: () => NOW + TWELVE_HOURS };
  let rotations = 1;
  const removal: SecretDeps = {
    ...d,
    slack: {
      ...d.tokens,
      async rotate(refreshToken) {
        // A rotation lands between the removal's read of the pair and its own rotation.
        if (rotations-- > 0) await withConfigurationToken(rotator, TEAM, async () => 'rotated');
        return d.slack.rotate(refreshToken);
      },
    },
  };
  assert.equal(await discardConfigurationToken(removal, TEAM), 'unconfirmed', 'cautious, though the chain ended');
  assert.equal(await d.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), undefined, 'the newer pair is gone too');
  assert.deepEqual(d.rotations.slice(1, 4), ['xoxe-1-refresh-1', 'xoxe-1-refresh-1', 'xoxe-1-refresh-2'],
    'the rotation spent the stored token, Slack refused the removal its spent token, and the removal ended the newer one');
  assert.equal(d.tokens.listed(OWNER, TEAM), false);

  d.tokens.generate('xoxe-1-pasted-again-token-000', OWNER, TEAM);
  assert.equal(await saveConfigurationToken(d, TEAM, 'xoxe-1-pasted-again-token-000'), 'saved');
  rotations = Infinity;
  await assert.rejects(() => discardConfigurationToken(removal, TEAM), LostRevision);
  assert.ok(await d.settings.getEncryptedCredentialRevision(configurationTokenKey(TEAM)), 'a pair that keeps changing is reported, not called removed');
});

// Defect caught: a removal whose delete loses to a rotation's claim running the chain again on the refresh token it
// just ended, which Slack refuses, so a removal that ended everything answers unconfirmed.
test('a removal that loses its delete to a rotation\'s claim deletes the pair without ending it again, and says it ended', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED), 'saved');
  const key = configurationTokenKey(TEAM);
  const holder: SecretDeps = { ...d, now: () => NOW + TWELVE_HOURS, slack: { ...d.tokens, rotate: () => new Promise(() => {}) } };
  let claims = 1;
  d.credentials = Object.assign(Object.create(d.settings) as SqliteSettingsStore, {
    async deleteEncryptedCredentialRevision(name: string, expected: string) {
      if (claims-- > 0) {
        // A rotation claims the pair (same tokens, new revision) and is still waiting on Slack.
        void withConfigurationToken(holder, TEAM, async () => 'unused');
        while ((await d.settings.getEncryptedCredentialRevision(key))?.revision === expected) await new Promise((resolve) => setImmediate(resolve));
      }
      return d.settings.deleteEncryptedCredentialRevision(name, expected);
    },
  });
  const from = d.tokens.calls.length;
  assert.equal(await discardConfigurationToken(d, TEAM), 'discarded');
  assert.equal(d.tokens.calls.slice(from).filter((call) => call.method === 'rotate').length, 2, 'the chain is ended once');
  assert.equal(await d.settings.getEncryptedCredentialRevision(key), undefined, 'nothing is stored');
  assert.equal(d.tokens.listed(OWNER, TEAM), false);
});

// Defect caught: two removals at once leaving a stored copy, or each ending the chain again from a spent token.
test('two removals at once delete the stored copy and leave Slack listing nothing; the one Slack refused errs cautious', async (t) => {
  const d = fixture(t);
  assert.equal(await saveConfigurationToken(d, TEAM, PASTED, OWNER), 'saved');
  d.slow = true;
  const from = d.tokens.calls.length;
  const answers = await Promise.all([discardConfigurationToken(d, TEAM), discardConfigurationToken(d, TEAM)]);
  assert.deepEqual(answers.sort(), ['discarded', 'unconfirmed']);
  assert.deepEqual(d.tokens.calls.slice(from).map((call) => call.method).sort(), ['revoke', 'revoke', 'revoke', 'rotate', 'rotate', 'rotate'],
    'one removal ends the chain, the other tries the token once and stops');
  assert.equal(await hasConfigurationToken(d, TEAM), false);
  assert.equal(d.tokens.listed(OWNER, TEAM), false);
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

test("an app is an Agent's only when its record exists, opens and names that Agent; another Agent's record is logged once", async (t) => {
  const d = fixture(t);
  const revision = await writeAppSecrets(d, 'A0C8APP', 'agent_support', { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-1' }, null);
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.deepEqual(await readOwnAppSecrets(d, 'A0C8APP', 'agent_support', 'update'), {
    kind: 'own', revision, secrets: { clientSecret: 'cs', signingSecret: 'ss', botToken: 'xoxb-1' },
  });
  assert.equal(warn.mock.callCount(), 0);

  assert.deepEqual(await readOwnAppSecrets(d, 'A0C8APP', 'agent_finance', 'delete'), { kind: 'another_agent' });
  assert.deepEqual(warn.mock.calls.map((call) => call.arguments[0]), [{
    event: 'chickpea.agent_app.record_refused', use: 'delete', agentId: 'agent_finance', appId: 'A0C8APP', recordAgentId: 'agent_support',
  }]);
  assert.equal(JSON.stringify(warn.mock.calls).includes('xoxb-1'), false, 'no secret in the log');

  assert.deepEqual(await readOwnAppSecrets(d, 'A0C8NONE', 'agent_support', 'delete'), { kind: 'missing' });
  const rekeyed = { ...d, keyring: generateCredentialKeyring('k2') };
  assert.deepEqual(await readOwnAppSecrets(rekeyed, 'A0C8APP', 'agent_support', 'delete'), { kind: 'unreadable' });
  assert.equal(warn.mock.calls.at(-1)?.arguments[0], '[chickpea] agent_app_secrets_unreadable {"appId":"A0C8APP"}');

  const unreachable = Object.assign(Object.create(d.settings) as SqliteSettingsStore, {
    getEncryptedCredentialRevision: async () => { throw new Error('realm unreachable'); },
  });
  await assert.rejects(() => readOwnAppSecrets({ ...d, credentials: unreachable }, 'A0C8APP', 'agent_support', 'delete'), /realm unreachable/,
    'a store that cannot be reached throws rather than reading as no record');
});
