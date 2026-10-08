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
import { formatUsageDollars } from './usage-display.ts';

export const CREDITED_BACK_TEXT = 'Usage for this reply was credited back to your plan.';

/** A Slack turn's failure as its settlement records it. */
export type SlackFailureKind = Extract<FlueSettlementCheckpointV1, { outcome: 'failed' | 'aborted' }>['failureKind'];

// Keyed by both failure unions: a kind added to either fails to compile until
// it is classified here.
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
  // The run failed as a whole: the class does not say whose model, sandbox or code.
  tool_failed: 'chickpea',
  unknown_external_outcome: 'chickpea',
  result_invalid: 'provider',
  // A completed run whose result could not be posted: the customer got nothing.
  slack_rate_limited: 'chickpea',
  direct_thread_unavailable: 'chickpea',
  channel_destination_unavailable: 'chickpea',
  delivery_unknown: 'chickpea',
};

export function creditBackReason(kind: SlackFailureKind | RoutineFailureClass): CreditBackReason | null {
  return CREDIT_BACK_REASONS[kind];
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
