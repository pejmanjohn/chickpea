import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { deploymentServesManyInstallations, installationScopeOf } from '../config/installation-scope.ts';
import {
  creditBackRun,
  platformFundingConfigured,
  type CreditBackReason,
  type RunRef,
} from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { RoutineFailureClass } from '../routines/types.ts';
import type { FlueSettlementCheckpointV1 } from '../slack/turn-job-types.ts';
import type { ModelRequestFundingSource } from './model-requests.ts';

export const CREDITED_BACK_TEXT = 'Usage for this reply was credited back to your plan.';

export type SlackFailureKind = Extract<FlueSettlementCheckpointV1, { outcome: 'failed' | 'aborted' }>['failureKind'];

/** The executor gave the turn up after an eviction or wall-time yield, or a reconciliation it could not settle. */
export type RecoveryFailure = 'recovery-failure';

type FailureKind = SlackFailureKind | RoutineFailureClass | RecoveryFailure;

type NotOurs =
  | 'out_of_usage'
  | 'workspace_limit'
  | 'customer_account'
  | 'customer_setup'
  | 'customer_destination'
  | 'may_have_posted'
  | 'cause_unrecorded';

type Owner =
  | { readonly ours: CreditBackReason; readonly unlessToolCalled?: true }
  | { readonly notOurs: NotOurs };

const ours = (reason: CreditBackReason): Owner => ({ ours: reason });
const oursUnlessToolCalled = (reason: CreditBackReason): Owner => ({ ours: reason, unlessToolCalled: true });
const notOurs = (why: NotOurs): Owner => ({ notOurs: why });

const FAILURE_OWNERS: Record<FailureKind, Owner> = {
  agent: ours('chickpea'),
  provider: ours('provider'),
  'invalid-output': oursUnlessToolCalled('provider'),
  'openai-subscription-reconnect': notOurs('customer_account'),
  'openai-subscription-quota': notOurs('customer_account'),
  'openai-subscription-policy': notOurs('customer_account'),
  'credits-exhausted': notOurs('out_of_usage'),
  sandbox: ours('sandbox'),
  'sandbox-session-cap': notOurs('workspace_limit'),
  'recovery-failure': ours('evicted'),

  creator_ineligible: notOurs('customer_setup'),
  channel_ineligible: notOurs('customer_setup'),
  assignment_missing: notOurs('customer_setup'),
  access_denied: notOurs('customer_setup'),
  schedule_invalid: notOurs('customer_setup'),
  credential_unavailable: notOurs('customer_account'),
  policy_denied: notOurs('customer_account'),
  capacity_limited: notOurs('customer_account'),
  spend_limited: notOurs('out_of_usage'),
  admission_unknown: ours('chickpea'),
  workflow_interrupted: ours('chickpea'),
  internal_error: ours('chickpea'),
  deadline_exceeded: ours('timeout'),
  tool_failed: oursUnlessToolCalled('provider'),
  unknown_external_outcome: notOurs('cause_unrecorded'),
  result_invalid: oursUnlessToolCalled('provider'),
  slack_rate_limited: ours('chickpea'),
  direct_thread_unavailable: notOurs('customer_destination'),
  channel_destination_unavailable: notOurs('customer_destination'),
  delivery_unknown: notOurs('may_have_posted'),
};

export interface FailedRun {
  readonly funding: ModelRequestFundingSource;
  readonly toolCallCount?: number | undefined;
}

export function creditBackReason(kind: FailureKind, run: FailedRun): CreditBackReason | null {
  const owner = FAILURE_OWNERS[kind];
  if ('notOurs' in owner) return null;
  if (owner.unlessToolCalled && (run.toolCallCount ?? 0) > 0) return null;
  return owner.ours === 'provider' && run.funding !== 'platform' ? null : owner.ours;
}

export function planFunding(plan: Pick<RuntimePlanV2, 'modelCredential'> | undefined): ModelRequestFundingSource {
  return plan?.modelCredential?.fundingSource ?? 'customer';
}

export function hostedRun(env: PlatformEnv | undefined, runId: string | undefined): RunRef | undefined {
  if (!runId || !platformFundingConfigured() || !deploymentServesManyInstallations(env)) return undefined;
  const installationId = installationScopeOf(env)?.installationId;
  return installationId ? { installationId, runId } : undefined;
}

export async function creditBackFailedRun(run: RunRef | undefined, reason: CreditBackReason | null): Promise<boolean> {
  if (!run || !reason) return false;
  const outcome = await creditBackRun(run, reason);
  return outcome?.kind === 'credited' || outcome?.kind === 'duplicate';
}

export function withCreditedBack(text: string, creditedBack: boolean): string {
  return creditedBack ? `${text} ${CREDITED_BACK_TEXT}` : text;
}
