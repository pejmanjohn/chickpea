import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasShownOnboardingReply,
  isDeliveredOnboardingReply,
} from '../src/admin/onboarding-proof.ts';
import { opaqueId } from '../src/work/admission.ts';
import type { WorkRunListItem, WorkStore } from '../src/work/types.ts';
import { onboardingRunFixture as fixture } from './helpers/onboarding-runs.ts';

const TARGET = { workspaceId: 'T123', slackUserId: 'U_OWNER', tryStartedAt: 100 };

test('onboarding proof requires one delivered installer DM after Try', () => {
  const delivered = fixture();
  assert.equal(isDeliveredOnboardingReply(delivered, TARGET), true);

  for (const changed of [
    fixture({ run: { triggerKind: 'slack_app_mention' }, binding: { configMode: 'frozen_on_open' } }),
    fixture({ run: { triggerKind: 'slack_message' } }),
    fixture({ run: { createdAt: 99 } }),
    fixture({ run: { actorRef: opaqueId('actor', 'slack:T123:U_SOMEONE_ELSE') } }),
    fixture({ run: { terminalDisposition: 'failed' } }),
    fixture({ run: { deliveryStatus: 'pending' } }),
    fixture({ run: { deliveryMethod: 'slack_reaction_add' } }),
    fixture({ run: { deliveryRef: 'slack:C456:1900000000.000001' } }),
    fixture({ binding: { externalAccountId: opaqueId('account', 'slack:T999') } }),
  ]) assert.equal(isDeliveredOnboardingReply(changed, TARGET), false);

  assert.equal(isDeliveredOnboardingReply(fixture({
    run: { triggerKind: 'slack_app_mention' },
  }), TARGET), true, 'an explicit @Chickpea inside the DM remains valid');
});

test('onboarding proof follows bounded pages and stops once runs predate Try', async () => {
  const calls: unknown[] = [];
  const pages = [
    {
      items: [fixture({ run: { deliveryStatus: 'pending', createdAt: 120 } })],
      nextCursor: { createdAt: 120, runId: 'run_page_one' },
    },
    { items: [fixture({ run: { createdAt: 110 } })], nextCursor: null },
  ];
  const paged = {
    async listRuns(input: unknown) {
      calls.push(input);
      return pages.shift()!;
    },
  } as unknown as WorkStore;
  assert.equal(await hasShownOnboardingReply(paged, TARGET), true);
  assert.equal(calls.length, 2);

  let cutoffCalls = 0;
  const cutoff = {
    async listRuns() {
      cutoffCalls += 1;
      return {
        items: [fixture({ run: { createdAt: 99 } })],
        nextCursor: { createdAt: 99, runId: 'run_older' },
      };
    },
  } as unknown as WorkStore;
  assert.equal(await hasShownOnboardingReply(cutoff, TARGET), false);
  assert.equal(cutoffCalls, 1);
});

test('the proof lists the newest runs of every status, stopping at the first run before Try', async () => {
  const calls: unknown[] = [];
  const work = {
    async listRuns(input: unknown) {
      calls.push(input);
      return { items: [fixture({ run: { createdAt: 99 } })], nextCursor: { createdAt: 99, runId: 'run_older' } };
    },
  } as unknown as WorkStore;
  assert.equal(await hasShownOnboardingReply(work, TARGET, async () => undefined), false);
  assert.deepEqual(calls, [{ kind: 'interactive', limit: 100, cursor: null }]);
});

const STREAMING = { run: { status: 'executing', terminalDisposition: null, deliveryStatus: 'pending', deliveryRef: null, settledAt: null } } as const;
const shown = (channelId: string, acknowledgedByteLength: number) =>
  async (runId: string) => runId === 'run_onboarding' ? { root: { channelId }, stream: { acknowledgedByteLength } } : undefined;
const onePage = (item: WorkRunListItem) => ({
  async listRuns() { return { items: [item], nextCursor: null }; },
}) as unknown as WorkStore;

test('a reply already showing answer text in the Owner\'s DM counts before its run settles', async () => {
  const streaming = fixture(STREAMING);
  assert.equal(isDeliveredOnboardingReply(streaming, TARGET), false, 'not settled, so not delivered');
  assert.equal(await hasShownOnboardingReply(onePage(streaming), TARGET, shown('D456', 42)), true);

  for (const [label, item, reader] of [
    ['a stream with only its task plan', streaming, shown('D456', 0)],
    ['text in a channel, not the DM', streaming, shown('C456', 42)],
    ['another person\'s DM', fixture({ ...STREAMING, run: { ...STREAMING.run, actorRef: opaqueId('actor', 'slack:T123:U_SOMEONE_ELSE') } }), shown('D456', 42)],
    ['a run before Try', fixture({ ...STREAMING, run: { ...STREAMING.run, createdAt: 99 } }), shown('D456', 42)],
    ['another workspace', fixture({ ...STREAMING, binding: { externalAccountId: opaqueId('account', 'slack:T999') } }), shown('D456', 42)],
    ['no presentation yet', streaming, async () => undefined],
    ['a reader that fails', streaming, async () => { throw new Error('state store unavailable'); }],
  ] as const) {
    assert.equal(await hasShownOnboardingReply(onePage(item), TARGET, reader), false, label);
  }
  assert.equal(await hasShownOnboardingReply(onePage(streaming), TARGET), false, 'no reader: not shown yet');
});
