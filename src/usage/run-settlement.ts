import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { deploymentServesManyInstallations, installationScopeOf } from '../config/installation-scope.ts';
import {
  creditBackRun,
  platformFundingConfigured,
  readRunCost,
  type CreditBackReason,
  type RunRef,
} from '../config/platform-funding.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { RoutineFailureClass } from '../routines/types.ts';
import type { FlueSettlementCheckpointV1 } from '../slack/turn-job-types.ts';
import type { ModelRequestFundingSource } from './model-requests.ts';
import { formatUsageDollars } from './usage-display.ts';

export const CREDITED_BACK_TEXT = 'Usage for this reply was credited back to your plan.';

/** A Slack turn's failure as its settlement records it. */
export type SlackFailureKind = Extract<FlueSettlementCheckpointV1, { outcome: 'failed' | 'aborted' }>['failureKind'];

// Only failures on Chickpea's side, never one the customer's destination,
// permissions, key or provider account caused. Keyed by both failure unions:
// a kind added to either fails to compile until it is classified here.
const CREDIT_BACK_REASONS: Record<SlackFailureKind | RoutineFailureClass, CreditBackReason | null> = {
  agent: 'chickpea',
  provider: 'provider',
  'invalid-output': 'provider',
  'openai-subscription-reconnect': null,
  'openai-subscription-quota': null,
  'openai-subscription-policy': null,
  'credits-exhausted': null,
  sandbox: 'sandbox',
  // A workspace limit, like running out of usage.
  'sandbox-session-cap': null,

  creator_ineligible: null,
  channel_ineligible: null,
  assignment_missing: null,
  access_denied: null,
  credential_unavailable: null,
  policy_denied: null,
  capacity_limited: null,
  spend_limited: null,
  schedule_invalid: null,
  admission_unknown: 'chickpea',
  workflow_interrupted: 'chickpea',
  internal_error: 'chickpea',
  deadline_exceeded: 'timeout',
  // The run failed as a whole, most often at the model provider; the class cannot tell.
  tool_failed: 'provider',
  // A recorded class that hides its cause; a live attempt classifies the cause instead.
  unknown_external_outcome: null,
  result_invalid: 'provider',
  // Slack refused a completed run's result for load: the customer got nothing.
  slack_rate_limited: 'chickpea',
  // The customer's destination is gone.
  direct_thread_unavailable: null,
  channel_destination_unavailable: null,
  // The result may have been posted.
  delivery_unknown: null,
};

/** On the workspace's own key the provider is the customer's, so its failures are not credited back. */
export function creditBackReason(
  kind: SlackFailureKind | RoutineFailureClass,
  funding: ModelRequestFundingSource,
): CreditBackReason | null {
  const reason = CREDIT_BACK_REASONS[kind];
  return reason === 'provider' && funding !== 'platform' ? null : reason;
}

/** The funding a run's frozen plan names; a plan without a platform credential runs on the workspace's key. */
export function planFunding(plan: Pick<RuntimePlanV2, 'modelCredential'> | undefined): ModelRequestFundingSource {
  return plan?.modelCredential?.fundingSource ?? 'customer';
}

/** The ledger's run on a hosted installation with a funding port; undefined standalone, without a port, or before dispatch. */
export function hostedRun(env: PlatformEnv | undefined, runId: string | undefined): RunRef | undefined {
  if (!runId || !platformFundingConfigured() || !deploymentServesManyInstallations(env)) return undefined;
  const installationId = installationScopeOf(env)?.installationId;
  return installationId ? { installationId, runId } : undefined;
}

/** Whether the host restored what the run used: credited now, or already. */
export async function creditBackFailedRun(run: RunRef | undefined, reason: CreditBackReason | null): Promise<boolean> {
  if (!run || !reason) return false;
  const outcome = await creditBackRun(run, reason);
  return outcome?.kind === 'credited' || outcome?.kind === 'duplicate';
}

export function withCreditedBack(text: string, creditedBack: boolean): string {
  return creditedBack ? `${text} ${CREDITED_BACK_TEXT}` : text;
}

/** "This reply used $0.31" when the host shows the run's cost; undefined otherwise. */
export async function runCostLine(run: RunRef | undefined): Promise<string | undefined> {
  const cost = run && await readRunCost(run);
  return cost?.shown ? `This reply used ${formatUsageDollars(cost.usageMicros)}` : undefined;
}
