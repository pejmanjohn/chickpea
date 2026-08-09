import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hasDeliveredOnboardingReply,
  isDeliveredOnboardingReply,
} from '../src/admin/onboarding-proof.ts';
import { opaqueId } from '../src/work/admission.ts';
import type { WorkRunListItem, WorkStore } from '../src/work/types.ts';

const TARGET = { workspaceId: 'T123', channelId: 'C456', tryStartedAt: 100 };

test('onboarding proof requires one delivered selected-channel mention after Try', () => {
  const delivered = fixture();
  assert.equal(isDeliveredOnboardingReply(delivered, TARGET), true);

  for (const changed of [
    fixture({ run: { triggerKind: 'slack_message' } }),
    fixture({ run: { createdAt: 99 } }),
    fixture({ run: { terminalDisposition: 'failed' } }),
    fixture({ run: { deliveryStatus: 'pending' } }),
    fixture({ run: { deliveryMethod: 'slack_reaction_add' } }),
    fixture({ run: { deliveryRef: 'slack:C999:1900000000.000001' } }),
    fixture({ binding: { externalAccountId: opaqueId('account', 'slack:T999') } }),
  ]) assert.equal(isDeliveredOnboardingReply(changed, TARGET), false);
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
  assert.equal(await hasDeliveredOnboardingReply(paged, TARGET), true);
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
  assert.equal(await hasDeliveredOnboardingReply(cutoff, TARGET), false);
  assert.equal(cutoffCalls, 1);
});

function fixture(
  override: {
    run?: Partial<WorkRunListItem['run']>;
    binding?: Partial<WorkRunListItem['binding']>;
  } = {},
): WorkRunListItem {
  return {
    work: { id: 'work_onboarding' as WorkRunListItem['work']['id'], kind: 'conversation', lifecycle: 'open', maximumSensitivity: 'private', createdAt: 90, updatedAt: 120, closedAt: null },
    binding: {
      id: 'binding_onboarding' as WorkRunListItem['binding']['id'],
      workId: 'work_onboarding' as WorkRunListItem['binding']['workId'],
      adapterKind: 'slack',
      externalAccountId: opaqueId('account', 'slack:T123'),
      externalConversationId: 'conversation_opaque',
      generation: 1,
      lifecycle: 'active',
      sourceVisibility: 'private',
      configMode: 'resolve_each_run',
      pinnedConfigRevisionId: null,
      orderingKey: 'slack:T123:C456',
      createdAt: 90,
      expiredAt: null,
      ...override.binding,
    },
    run: {
      id: 'run_onboarding' as WorkRunListItem['run']['id'],
      workId: 'work_onboarding' as WorkRunListItem['run']['workId'],
      bindingId: 'binding_onboarding' as WorkRunListItem['run']['bindingId'],
      kind: 'interactive',
      admissionSequence: 1,
      triggerKind: 'slack_app_mention',
      triggerRef: 'slack:event:one',
      dedupeKey: 'event-one',
      actorRef: null,
      actorTrustTier: 'member',
      sourceContextWatermark: null,
      triggerContentRef: null,
      preparedInputRef: null,
      configRevisionId: 'config_onboarding' as WorkRunListItem['run']['configRevisionId'],
      effectiveCapabilityDigest: 'a'.repeat(64),
      executionAuthority: 'ledger',
      coordinatorKind: 'interactive',
      authorityEpoch: 1,
      policyApprovedOutputRef: null,
      renderedPayloadRef: null,
      status: 'settled',
      terminalDisposition: 'succeeded',
      deliveryStatus: 'delivered',
      deliveryMethod: 'slack_chat_postMessage',
      deliveryAttemptId: 'attempt-one',
      deliveryRef: 'slack:C456:1900000000.000001',
      deliveryFinalizedAt: 120,
      leaseOwner: null,
      leaseUntil: null,
      fencingToken: 1,
      safeFailureCode: null,
      recoveryResolutionKind: null,
      recoveryAdminCredentialId: null,
      recoveryOperatorLabel: null,
      recoveryAuthOrigin: null,
      recoveryReasonCode: null,
      recoveryRequestId: null,
      recoveryResolvedAt: null,
      createdAt: 110,
      updatedAt: 120,
      settledAt: 120,
      ...override.run,
    },
  };
}
