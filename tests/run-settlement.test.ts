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
 * provider (`platform`) and when the workspace's own key does (`customer`).
 */
const EXPECTED: Record<
  SlackFailureKind | RoutineFailureClass,
  { readonly platform: CreditBackReason | null; readonly customer: CreditBackReason | null }
> = {
  agent: { platform: 'chickpea', customer: 'chickpea' },
  provider: { platform: 'provider', customer: null },
  'invalid-output': { platform: 'provider', customer: null },
  'openai-subscription-reconnect': { platform: null, customer: null },
  'openai-subscription-quota': { platform: null, customer: null },
  'openai-subscription-policy': { platform: null, customer: null },
  'credits-exhausted': { platform: null, customer: null },
  sandbox: { platform: 'sandbox', customer: 'sandbox' },
  'sandbox-session-cap': { platform: null, customer: null },

  creator_ineligible: { platform: null, customer: null },
  channel_ineligible: { platform: null, customer: null },
  assignment_missing: { platform: null, customer: null },
  access_denied: { platform: null, customer: null },
  credential_unavailable: { platform: null, customer: null },
  policy_denied: { platform: null, customer: null },
  capacity_limited: { platform: null, customer: null },
  spend_limited: { platform: null, customer: null },
  schedule_invalid: { platform: null, customer: null },
  admission_unknown: { platform: 'chickpea', customer: 'chickpea' },
  workflow_interrupted: { platform: 'chickpea', customer: 'chickpea' },
  internal_error: { platform: 'chickpea', customer: 'chickpea' },
  deadline_exceeded: { platform: 'timeout', customer: 'timeout' },
  tool_failed: { platform: 'provider', customer: null },
  unknown_external_outcome: { platform: null, customer: null },
  result_invalid: { platform: 'provider', customer: null },
  slack_rate_limited: { platform: 'chickpea', customer: 'chickpea' },
  direct_thread_unavailable: { platform: null, customer: null },
  channel_destination_unavailable: { platform: null, customer: null },
  delivery_unknown: { platform: null, customer: null },
};

test('each failure kind and class is credited back only when the failure was on Chickpea\'s side', () => {
  for (const [kind, expected] of Object.entries(EXPECTED) as Array<[keyof typeof EXPECTED, typeof EXPECTED[keyof typeof EXPECTED]]>) {
    assert.deepEqual(
      { platform: creditBackReason(kind, 'platform'), customer: creditBackReason(kind, 'customer') },
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
