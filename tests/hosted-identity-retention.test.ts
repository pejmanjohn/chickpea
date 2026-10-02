import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  HOSTED_CREDENTIAL_CANDIDATE_MAX_AGE_MS,
  identityRetentionMinute,
  runHostedIdentityRetentionDuty,
  sweepInstallationIdentityRetention,
} from '../src/identity/hosted-retention.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { stageSlackCredentialBundle, writeHostedSlackBotCredentials } from '../src/slack/installation-credentials.ts';
import { HOSTED_SLACK_INSTALLATION_ID } from '../src/config/types.ts';

/**
 * The hosted Slack lifecycle parks a bot credential candidate during each
 * install; the retention sweep scrubs those older than a day. Under
 * installation tenancy Core's scheduled duties run it once a day per
 * installation; standalone never runs it.
 */

const HOSTED = { CHICKPEA_TENANCY: 'installation' } as const;
const DAY_START = Date.UTC(2026, 9, 2);

/** The scheduled time of a minute of the day. */
function minuteOf(minute: number, day = 0): number {
  return DAY_START + day * 86_400_000 + minute * 60_000;
}

/** An installation with an active bot bundle and a candidate parked at `parkedAt`. */
async function parkedCandidate(clock: { now: number }, parkedAt: number) {
  const identity = new SqliteIdentityStore(':memory:', { now: () => clock.now });
  const keyring = generateCredentialKeyring('key_retention');
  clock.now = parkedAt;
  const active = await writeHostedSlackBotCredentials({ state: identity, keyring }, null, {
    botToken: 'xoxb-active', botUserId: 'UBOT', appId: 'AHOSTED', teamId: 'T_RETAIN',
    grantedScopes: ['chat:write'], validatedAt: parkedAt,
  });
  const candidate = await stageSlackCredentialBundle({ state: identity, keyring }, {
    identityId: HOSTED_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation', purpose: 'connected_credentials',
    expectedActiveRevision: active, appId: 'AHOSTED', teamId: 'T_RETAIN', botUserId: 'UBOT',
    grantedScopes: ['chat:write'], validatedAt: parkedAt, manifestFingerprint: null,
    secrets: { botToken: 'xoxb-parked' },
  });
  return { identity, active, candidate };
}

/** Counts every store call; fails any when `untouchable`. */
function watched(store: IdentityStore, untouchable = false) {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        if (untouchable) throw new Error(`identity store read: ${String(property)}`);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { proxy, calls };
}

test('under installation tenancy the sweep runs once a day per installation, at its minute, and scrubs parked candidates', async (t) => {
  const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_retain_a' });
  const clock = { now: 0 };
  const { identity, active, candidate } = await parkedCandidate(clock, minuteOf(0) - HOSTED_CREDENTIAL_CANDIDATE_MAX_AGE_MS);
  t.after(() => identity.close());
  const minute = identityRetentionMinute('inst_retain_a');
  const { proxy, calls } = watched(identity);
  for (let offset = 1; offset < 1440; offset += 97) {
    clock.now = minuteOf((minute + offset) % 1440);
    await runHostedIdentityRetentionDuty(clock.now, env, proxy);
  }
  assert.deepEqual(calls, [], 'any other minute reads nothing');

  clock.now = minuteOf(minute);
  await runHostedIdentityRetentionDuty(clock.now, env, proxy);
  assert.deepEqual(calls, ['sweepSlackIdentityRetention']);
  const scrubbed = await identity.getSlackCredentialRevision(candidate.identityId, candidate.revision);
  assert.equal(scrubbed?.status, 'tombstoned');
  assert.equal(scrubbed?.envelope, null);
  assert.equal((await identity.getActiveSlackCredentialRevision(HOSTED_SLACK_INSTALLATION_ID))?.revision, active,
    'the active bundle stays');
  // The next day, at the same minute, again.
  await runHostedIdentityRetentionDuty(minuteOf(minute, 1), env, proxy);
  assert.equal(calls.length, 2);
});

test('a candidate parked for less than a day is kept, and installations spread across the day', async (t) => {
  const env = scopeInstallationEnv(HOSTED as Record<string, unknown>, { installationId: 'inst_retain_b' });
  const clock = { now: 0 };
  const { identity, candidate } = await parkedCandidate(clock, minuteOf(0) - 60_000);
  t.after(() => identity.close());
  const swept = await sweepInstallationIdentityRetention(env, minuteOf(0), identity);
  assert.equal(swept.scrubbedCredentialCandidates, 0);
  assert.equal((await identity.getSlackCredentialRevision(candidate.identityId, candidate.revision))?.status, 'candidate');

  const minutes = new Set(Array.from({ length: 50 }, (_, index) => identityRetentionMinute(`inst_${index}`)));
  assert.ok(minutes.size > 40, 'fifty installations land on many different minutes');
  assert.ok([...minutes].every((minute) => Number.isInteger(minute) && minute >= 0 && minute < 1440));
});

test('standalone never runs the sweep, at any minute', async (t) => {
  const identity = new SqliteIdentityStore(':memory:');
  t.after(() => identity.close());
  const { proxy, calls } = watched(identity, true);
  for (let minute = 0; minute < 1440; minute += 1) {
    await runHostedIdentityRetentionDuty(minuteOf(minute), {}, proxy);
  }
  assert.deepEqual(calls, []);
  await assert.rejects(sweepInstallationIdentityRetention({}, minuteOf(0), proxy), /one installation/);
});

test('Core\'s scheduled handler carries the duty beside OAuth keep-alive', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  assert.match(source, /duties: \[keepOAuthCredentialsAlive, runHostedIdentityRetentionDuty\]/);
});
