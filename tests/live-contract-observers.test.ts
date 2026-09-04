import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LIVE_MANIFEST } from '../qa/live/manifest.ts';
import {
  CAPABILITY_INVENTORY,
  LC02_AVATAR_SOURCE_CAPABILITY,
  inventoryManifestCapabilities,
} from '../qa/live/observers/capabilities.ts';
import {
  CHICKPEA_KNOWN_BAD_FIXTURE,
  observeChickpea,
} from '../qa/live/observers/chickpea.ts';
import {
  PROVIDER_KNOWN_BAD_FIXTURE,
  observeProvider,
} from '../qa/live/observers/provider.ts';
import {
  SLACK_KNOWN_BAD_FIXTURE,
  observeSlack,
} from '../qa/live/observers/slack.ts';
import {
  CLOUDFLARE_KNOWN_BAD_FIXTURE,
  observeCloudflare,
} from '../qa/live/observers/cloudflare.ts';
import {
  InMemoryOperatorChallengeLedger,
  OperatorChallengeError,
  OperatorDriver,
} from '../qa/live/drivers/operator.ts';
import { ASSERTION_TOKENS, OBSERVER_IDS } from '../qa/live/schema.ts';

const RESOURCE_BINDING_DIGEST = `sha256:${'a'.repeat(64)}`;

test('every declared observer and scored manifest assertion has a capability entry', () => {
  assert.deepEqual(Object.keys(CAPABILITY_INVENTORY).sort(), [...OBSERVER_IDS].sort());
  assert.deepEqual(new Set(Object.values(CAPABILITY_INVENTORY).flatMap((entry) => entry.allowedTokens)),
    new Set(ASSERTION_TOKENS));
  const inventory = inventoryManifestCapabilities(LIVE_MANIFEST);
  assert.equal(inventory.blocked.length > 0, true);
  assert.equal(inventory.resolved.length > 0, true);
  assert.equal(CAPABILITY_INVENTORY['slack.messages.read'].source, 'computer_use_ui');
  assert.equal(CAPABILITY_INVENTORY['agent.read'].source, 'computer_use_ui');
  assert.equal(CAPABILITY_INVENTORY['provider.read'].source, 'computer_use_ui');
  assert.equal(LC02_AVATAR_SOURCE_CAPABILITY.status, 'blocked');
  assert.equal(LC02_AVATAR_SOURCE_CAPABILITY.reason, 'authoritative_projection_missing');
  assert.deepEqual(new Set([...inventory.resolved, ...inventory.blocked].map((entry) => entry.token)), new Set(
    LIVE_MANIFEST.contracts.flatMap((contract) => contract.variants.flatMap((variant) =>
      [...variant.expected, ...variant.forbidden].map((assertion) => assertion.token)
    )),
  ));
  assert.equal(ASSERTION_TOKENS.includes('agent.exists'), true);
});

test('deterministic bad fixtures fail closed without returning upstream content', async () => {
  const chickpea = await observeChickpea({
    observerId: 'agent.read',
    read: async () => CHICKPEA_KNOWN_BAD_FIXTURE,
  });
  const provider = await observeProvider({
    deadlineMs: 50,
    read: async () => PROVIDER_KNOWN_BAD_FIXTURE,
  });
  const slack = await observeSlack({
    observerId: 'slack.messages.read',
    deadlineMs: 50,
    sleep: async () => undefined,
    read: async () => SLACK_KNOWN_BAD_FIXTURE,
  });
  const cloudflare = await observeCloudflare({
    deadlineMs: 50,
    read: async () => CLOUDFLARE_KNOWN_BAD_FIXTURE,
  });

  for (const observation of [chickpea, provider, slack, cloudflare]) {
    assert.equal(observation.status, 'blocked');
    assert.deepEqual(observation.tokens, []);
    const serialized = JSON.stringify(observation);
    assert.equal(serialized.includes('customer'), false);
    assert.equal(serialized.includes('upstream'), false);
    assert.equal(serialized.includes('secret'), false);
  }
});

test('Slack 429 honors Retry-After by repeating only readback', async () => {
  let reads = 0;
  let actions = 1;
  const sleeps: number[] = [];
  const observation = await observeSlack({
    observerId: 'slack.messages.read',
    deadlineMs: 5_000,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    read: async () => {
      reads += 1;
      return reads === 1
        ? { status: 429, retryAfter: '2' }
        : { status: 200, tokens: ['slack.message_matches'], count: 1 };
    },
  });

  assert.equal(observation.status, 'blocked');
  assert.deepEqual(observation.tokens, []);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(reads, 2);
  assert.equal(actions, 1);
});

test('valid product API responses remain diagnostic-only and cannot emit scored proof', async () => {
  const observations = await Promise.all([
    observeChickpea({
      observerId: 'agent.read',
      read: async () => ({ status: 200, tokens: ['agent.exists'], revision: 'revision-1' }),
    }),
    observeProvider({
      deadlineMs: 50,
      read: async () => ({ status: 200, tokens: ['forbidden.no_duplicate'], count: 1 }),
    }),
    observeSlack({
      observerId: 'slack.messages.read', deadlineMs: 50, sleep: async () => undefined,
      read: async () => ({ status: 200, tokens: ['slack.message_matches'], count: 1 }),
    }),
  ]);
  for (const observation of observations) {
    assert.equal(observation.status, 'blocked');
    assert.deepEqual(observation.tokens, []);
  }
});

test('Slack observer bounds a hung read and treats an exact Retry-After deadline as rate limited', async () => {
  const hung = await observeSlack({
    observerId: 'slack.messages.read', deadlineMs: 5, sleep: async () => undefined,
    read: async () => new Promise<never>(() => undefined),
  });
  assert.equal(hung.status, 'unavailable');

  const boundary = await observeSlack({
    observerId: 'slack.messages.read', deadlineMs: 2_000, now: () => 0,
    sleep: async () => { throw new Error('must not sleep'); },
    read: async () => ({ status: 429, retryAfter: '2' }),
  });
  assert.deepEqual(boundary, {
    observerId: 'slack.messages.read', status: 'rate_limited', tokens: [],
    metadata: { attempts: 1, retryAfterSeconds: 2 },
  });
});

test('provider errors return bounded metadata and never the upstream error body', async () => {
  const observation = await observeProvider({
    deadlineMs: 50,
    read: async () => {
      throw new Error('customer sheet contents and bearer secret');
    },
  });
  assert.deepEqual(observation, {
    observerId: 'provider.read',
    status: 'unavailable',
    tokens: [],
    metadata: { attempts: 1 },
  });
});

test('operator challenges are one-use and expose semantic reminders only', () => {
  const ledger = new InMemoryOperatorChallengeLedger();
  const driverA = new OperatorDriver(ledger, { now: () => 1_000 });
  const action = driverA.issue({
    runId: 'run-one',
    caseId: 'LC04-V1-personal-read',
    stepId: 'authorize',
    attempt: 1,
    expectedRevision: 'revision-7',
    mutation: 'authorize',
    targetAlias: 'dedicated-qa',
    actorAlias: 'qa-member-one',
    expectedRole: 'member',
    browserProfileAlias: 'member-one-browser-profile',
    semanticAction: 'Authorize the run-marked Personal read-only connection.',
    completionSignal: 'A matching durable authorization receipt exists.',
    expiresAt: 2_000,
  });

  assert.deepEqual(Object.keys(action).sort(), [
    'actorAlias', 'attempt', 'browserProfileAlias', 'caseId', 'challengeId',
    'completionSignal', 'expectedRevision', 'expectedRole', 'expiresAt', 'mutation',
    'runId', 'semanticAction', 'stepId', 'targetAlias',
  ]);
  assert.equal(/url|dom|network|screenshot|storage/i.test(Object.keys(action).join(',')), false);

  const driverB = new OperatorDriver(ledger, { now: () => 1_000 });
  const receipt = driverB.complete({
    challengeId: action.challengeId,
    runId: action.runId,
    caseId: action.caseId,
    stepId: action.stepId,
    attempt: action.attempt,
    expectedRevision: action.expectedRevision,
    mutation: action.mutation,
    actorAlias: action.actorAlias,
    expectedRole: action.expectedRole,
    browserProfileAlias: action.browserProfileAlias,
    receiptId: 'receipt-one',
    resourceBindingDigest: RESOURCE_BINDING_DIGEST,
  });
  assert.equal(receipt.receiptId, 'receipt-one');
  const driverC = new OperatorDriver(ledger, { now: () => 1_000 });
  assert.throws(
    () => driverC.complete({ ...receipt, challengeId: action.challengeId }),
    (error: unknown) => error instanceof OperatorChallengeError && error.code === 'CHALLENGE_REPLAYED',
  );
});

test('a mismatched actor-bound completion is consumed and cannot be retried', () => {
  const driver = new OperatorDriver(new InMemoryOperatorChallengeLedger(), { now: () => 1_000 });
  const action = driver.issue({
    runId: 'run-one', caseId: 'LC04-V3-editor-race', stepId: 'authorize', attempt: 2,
    expectedRevision: 'revision-3', mutation: 'authorize', targetAlias: 'dedicated-qa',
    actorAlias: 'qa-member-two', expectedRole: 'member',
    browserProfileAlias: 'member-two-browser-profile', semanticAction: 'Complete setup.',
    completionSignal: 'The exact actor-bound receipt exists.', expiresAt: 2_000,
  });
  const wrong = {
    challengeId: action.challengeId,
    runId: action.runId,
    caseId: action.caseId,
    stepId: action.stepId,
    attempt: action.attempt,
    expectedRevision: action.expectedRevision,
    mutation: action.mutation,
    actorAlias: 'qa-member-one',
    expectedRole: action.expectedRole,
    browserProfileAlias: action.browserProfileAlias,
    receiptId: 'receipt-wrong-actor',
    resourceBindingDigest: RESOURCE_BINDING_DIGEST,
  } as const;
  assert.throws(
    () => driver.complete(wrong),
    (error: unknown) => error instanceof OperatorChallengeError && error.code === 'CHALLENGE_MISMATCH',
  );
  assert.throws(
    () => driver.complete({ ...wrong, actorAlias: action.actorAlias }),
    (error: unknown) => error instanceof OperatorChallengeError && error.code === 'CHALLENGE_REPLAYED',
  );
});

test('live observer modules do not import or construct local persistence adapters', () => {
  for (const file of ['chickpea.ts', 'slack.ts', 'provider.ts', 'cloudflare.ts']) {
    const source = readFileSync(new URL(`../qa/live/observers/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"][^'"]*(?:store|sqlite|journal)[^'"]*['"]/i, file);
    assert.doesNotMatch(source, /new\s+(?:Sqlite|.*Store\b)/, file);
  }
});
