import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_ACTION_TTL_MS,
  BrowserActionError,
  browserActionReplyWord,
  claimApprovedBrowserAction,
  createBrowserAction,
  getBrowserAction,
  resolveBrowserActionReply,
  sweepBrowserActions,
  type BrowserActionScope,
} from '../src/browser/actions.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { slackBrowserActionReply } from '../src/slack/interaction-intent.ts';

const SCOPE: BrowserActionScope = {
  workspaceId: 'T_TEST',
  channelId: 'C_TEST',
  threadTs: '1800000000.000100',
  agentId: 'agent_ops',
  actorSlackUserId: 'U_ASKER',
  actorMembershipId: 'membership_asker',
};
const T0 = Date.UTC(2026, 8, 22, 14, 0);
let counter = 0;
const nextId = () => (counter += 1).toString(16).padStart(32, '0');

async function pending(settings: SqliteSettingsStore, overrides: Partial<Parameters<typeof createBrowserAction>[1]> = {}) {
  return createBrowserAction(settings, {
    ...SCOPE,
    loginId: `wl_${'a'.repeat(32)}`,
    host: 'billing.example.com',
    url: 'https://billing.example.com/plan',
    title: 'Plan',
    ref: 'e4',
    role: 'button',
    name: 'Confirm change',
    occurrence: 0,
    action: 'click',
    description: 'click "Confirm change"',
    now: T0,
    randomId: nextId,
    ...overrides,
  });
}

test('the reply word is exactly approve or stop, with an optional trailing period', () => {
  for (const text of ['approve', 'Approve', 'APPROVE.', ' approve ', 'stop', 'Stop.']) {
    assert.ok(browserActionReplyWord(text), text);
  }
  for (const text of ['approved', 'approve!', 'approve it', 'yes', 'stop now', 'ok approve', 'approve..']) {
    assert.equal(browserActionReplyWord(text), undefined, text);
  }
  assert.equal(slackBrowserActionReply('<@U123> Approve.'), 'approve');
  assert.equal(slackBrowserActionReply('stop'), 'stop');
  assert.equal(slackBrowserActionReply('please approve'), undefined);
});

test('a pending action is approved by the same person in the same thread, then claimed once by that message', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const record = await pending(settings);
  assert.equal(record.status, 'pending');
  assert.equal(record.expiresAt, T0 + BROWSER_ACTION_TTL_MS);
  assert.equal((await getBrowserAction(settings, record.id))?.description, 'click "Confirm change"');

  // Other people, threads, and Agents cannot answer it.
  for (const scope of [
    { ...SCOPE, actorSlackUserId: 'U_OTHER' },
    { ...SCOPE, actorMembershipId: 'membership_other' },
    { ...SCOPE, threadTs: '1800000000.000999' },
    { ...SCOPE, agentId: 'agent_other' },
    { ...SCOPE, channelId: 'C_OTHER' },
  ]) {
    assert.equal(await resolveBrowserActionReply({ settings, text: 'approve', scope, messageTs: '1800000001.000100', now: T0 + 1 }), undefined);
  }
  assert.equal(await resolveBrowserActionReply({ settings, text: 'sure', scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 1 }), undefined);

  const answer = await resolveBrowserActionReply({ settings, text: 'approve', scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 1 });
  assert.deepEqual(answer, { kind: 'approved', id: record.id });
  // A second "approve" finds nothing pending.
  assert.equal(await resolveBrowserActionReply({ settings, text: 'approve', scope: SCOPE, messageTs: '1800000002.000100', now: T0 + 2 }), undefined);

  // Only the turn for the approving message may claim it, and only once.
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: record.id, scope: SCOPE, messageTs: '1800000002.000100', now: T0 + 3 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'not_approved',
  );
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: record.id, scope: { ...SCOPE, actorSlackUserId: 'U_OTHER' }, messageTs: '1800000001.000100', now: T0 + 3 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'wrong_scope',
  );
  const claimed = await claimApprovedBrowserAction({ settings, id: record.id, scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 3 });
  assert.equal(claimed.status, 'consumed');
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: record.id, scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 4 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'consumed',
  );
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: 'f'.repeat(32), scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 4 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'not_found',
  );
  settings.close();
});

test('stop spends a pending action, and a newer question replaces the older one', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const first = await pending(settings);
  const second = await pending(settings, { ref: 'e9', description: 'click "Delete"' });
  // The thread points at the newest question; the older one cannot be approved.
  assert.deepEqual(
    await resolveBrowserActionReply({ settings, text: 'Stop.', scope: SCOPE, messageTs: '1800000001.000100', now: T0 + 1 }),
    { kind: 'stopped', id: second.id },
  );
  assert.equal((await getBrowserAction(settings, second.id))?.status, 'consumed');
  assert.equal((await getBrowserAction(settings, first.id))?.status, 'pending');
  assert.equal(await resolveBrowserActionReply({ settings, text: 'approve', scope: SCOPE, messageTs: '1800000002.000100', now: T0 + 2 }), undefined);
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: first.id, scope: SCOPE, messageTs: '1800000002.000100', now: T0 + 2 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'not_approved',
  );
  settings.close();
});

test('actions expire after 15 minutes, before or after approval, and the sweep clears settled records', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const late = await pending(settings);
  assert.equal(
    await resolveBrowserActionReply({ settings, text: 'approve', scope: SCOPE, messageTs: '1800000001.000100', now: T0 + BROWSER_ACTION_TTL_MS }),
    undefined,
  );
  assert.equal((await getBrowserAction(settings, late.id))?.status, 'expired');

  const approvedLate = await pending(settings);
  await resolveBrowserActionReply({ settings, text: 'approve', scope: SCOPE, messageTs: '1800000002.000100', now: T0 + 1 });
  await assert.rejects(
    claimApprovedBrowserAction({ settings, id: approvedLate.id, scope: SCOPE, messageTs: '1800000002.000100', now: T0 + BROWSER_ACTION_TTL_MS + 1 }),
    (error: unknown) => error instanceof BrowserActionError && error.code === 'expired',
  );
  assert.equal((await getBrowserAction(settings, approvedLate.id))?.status, 'expired');

  const stale = await pending(settings);
  assert.deepEqual(await sweepBrowserActions({ settings, now: T0 + BROWSER_ACTION_TTL_MS + 5 }), { expired: 1, removed: 0 });
  assert.equal((await getBrowserAction(settings, stale.id))?.status, 'expired');
  // Settled records are deleted after the retention window, with their thread pointer.
  assert.deepEqual(await sweepBrowserActions({ settings, now: T0 + 3 * 60 * 60_000 }), { expired: 0, removed: 3 });
  for (const id of [late.id, approvedLate.id, stale.id]) assert.equal(await getBrowserAction(settings, id), undefined);
  assert.equal(await settings.getSetting('browseraction_index'), undefined);
  settings.close();
});
