import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type CreditBackReason,
} from '../src/config/platform-funding.ts';
import type { RoutineFailureClass } from '../src/routines/types.ts';
import { creditBackReason, hostedRun, type SlackFailureKind } from '../src/usage/run-settlement.ts';
import { NO_RUN_FEES } from './helpers/platform-funding.ts';

/**
 * The credit-back policy in one place: each way a Slack turn or a scheduled
 * run can fail, and what is credited back when Chickpea pays the run's
 * provider (`platform`), when the workspace's own key does (`customer`), and
 * when Chickpea pays and the run had already called a tool (`platformAfterToolCall`).
 */
const EXPECTED: Record<
  SlackFailureKind | RoutineFailureClass,
  {
    readonly platform: CreditBackReason | null;
    readonly customer: CreditBackReason | null;
    readonly platformAfterToolCall: CreditBackReason | null;
  }
> = {
  agent: { platform: 'chickpea', customer: 'chickpea', platformAfterToolCall: 'chickpea' },
  provider: { platform: 'provider', customer: null, platformAfterToolCall: 'provider' },
  'invalid-output': { platform: 'provider', customer: null, platformAfterToolCall: 'provider' },
  'openai-subscription-reconnect': { platform: null, customer: null, platformAfterToolCall: null },
  'openai-subscription-quota': { platform: null, customer: null, platformAfterToolCall: null },
  'openai-subscription-policy': { platform: null, customer: null, platformAfterToolCall: null },
  'credits-exhausted': { platform: null, customer: null, platformAfterToolCall: null },
  sandbox: { platform: 'sandbox', customer: 'sandbox', platformAfterToolCall: 'sandbox' },
  'sandbox-session-cap': { platform: null, customer: null, platformAfterToolCall: null },

  creator_ineligible: { platform: null, customer: null, platformAfterToolCall: null },
  channel_ineligible: { platform: null, customer: null, platformAfterToolCall: null },
  assignment_missing: { platform: null, customer: null, platformAfterToolCall: null },
  access_denied: { platform: null, customer: null, platformAfterToolCall: null },
  credential_unavailable: { platform: null, customer: null, platformAfterToolCall: null },
  policy_denied: { platform: null, customer: null, platformAfterToolCall: null },
  capacity_limited: { platform: null, customer: null, platformAfterToolCall: null },
  spend_limited: { platform: null, customer: null, platformAfterToolCall: null },
  schedule_invalid: { platform: null, customer: null, platformAfterToolCall: null },
  admission_unknown: { platform: 'chickpea', customer: 'chickpea', platformAfterToolCall: 'chickpea' },
  workflow_interrupted: { platform: 'chickpea', customer: 'chickpea', platformAfterToolCall: 'chickpea' },
  internal_error: { platform: 'chickpea', customer: 'chickpea', platformAfterToolCall: 'chickpea' },
  deadline_exceeded: { platform: 'timeout', customer: 'timeout', platformAfterToolCall: 'timeout' },
  tool_failed: { platform: 'provider', customer: null, platformAfterToolCall: null },
  unknown_external_outcome: { platform: null, customer: null, platformAfterToolCall: null },
  result_invalid: { platform: 'provider', customer: null, platformAfterToolCall: null },
  slack_rate_limited: { platform: 'chickpea', customer: 'chickpea', platformAfterToolCall: 'chickpea' },
  direct_thread_unavailable: { platform: null, customer: null, platformAfterToolCall: null },
  channel_destination_unavailable: { platform: null, customer: null, platformAfterToolCall: null },
  delivery_unknown: { platform: null, customer: null, platformAfterToolCall: null },
};

test('each failure kind and class is credited back only when the failure was on Chickpea\'s side', () => {
  for (const [kind, expected] of Object.entries(EXPECTED) as Array<[keyof typeof EXPECTED, typeof EXPECTED[keyof typeof EXPECTED]]>) {
    assert.deepEqual(
      {
        platform: creditBackReason(kind, { funding: 'platform', toolCallCount: 0 }),
        customer: creditBackReason(kind, { funding: 'customer', toolCallCount: 0 }),
        platformAfterToolCall: creditBackReason(kind, { funding: 'platform', toolCallCount: 1 }),
      },
      expected,
      kind,
    );
  }
});

test('only a dispatched run on a hosted installation with a host port is the ledger\'s', (t) => {
  const hosted = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: 'inst_gate' });
  assert.equal(hostedRun(hosted, 'sub_gate'), undefined, 'no port');
  configurePlatformFunding({
    funding: async () => 'customer', admit: async () => 'admitted', charge: async () => undefined, ...NO_RUN_FEES,
  });
  t.after(() => resetPlatformFundingForTests());
  assert.deepEqual(hostedRun(hosted, 'sub_gate'), { installationId: 'inst_gate', runId: 'sub_gate' });
  assert.equal(hostedRun(hosted, undefined), undefined, 'not dispatched');
  assert.equal(hostedRun(undefined, 'sub_gate'), undefined, 'standalone');
  assert.equal(hostedRun({}, 'sub_gate'), undefined, 'standalone');
  // A scope copied onto a standalone deployment's env is still standalone.
  assert.equal(hostedRun({ ...hosted, CHICKPEA_TENANCY: 'standalone' }, 'sub_gate'), undefined, 'standalone tenancy');
});
