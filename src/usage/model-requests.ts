import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai';

import { installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { estimateUsage } from './pricing/estimate.ts';
import type { UsageEstimateResult } from './pricing/types.ts';

/** How a provider request ended: its stream completed, was stopped part way, or failed. */
export type ModelRequestOutcome = 'completed' | 'stopped' | 'error';

/** Who paid the provider for a request. Platform funding arrives with credits. */
export type ModelRequestFundingSource = 'customer';

/** Who a request is attributed to, fixed when its model access is bound. */
export interface ModelRequestAttribution {
  readonly installationId: string;
  /** The Flue submission, or the stateless call, the request ran under. */
  readonly runId: string;
  /** One binding of model access: a new, retried or resumed attempt, or one stateless call. */
  readonly attemptId: string;
  /** The Agent whose run sent the request; null for a call no Agent owns, such as the classifier. */
  readonly agentId: string | null;
}

/**
 * One provider request the model-access proxy sent, written once when its
 * stream ends. `cacheWrite1hTokens` is the part of `cacheWriteTokens` written
 * for one hour and `reasoningTokens` the part of `outputTokens` spent
 * reasoning; each is null when the provider reports no split.
 */
export interface ModelRequestRecord extends ModelRequestAttribution {
  /** The idempotency key, minted once per request: a provider retry is a new request. */
  readonly requestId: string;
  /** The provider the request was billed by, with an alias route mapped to it. */
  readonly provider: string;
  readonly model: string;
  readonly fundingSource: ModelRequestFundingSource;
  readonly outcome: ModelRequestOutcome;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheWrite1hTokens: number | null;
  readonly reasoningTokens: number | null;
  /** The catalog version that priced the request; null when it is unpriced. */
  readonly priceVersionId: string | null;
  /** The list-price estimate in USD micros; null when it is unpriced. */
  readonly listPriceUsdMicros: number | null;
  readonly priceUnknownReason: UsageEstimateResult['priceUnknownReason'];
  readonly finishedAt: number;
}

export interface ModelRequestEnd {
  readonly requestId: string;
  readonly attribution: ModelRequestAttribution;
  readonly provider: string;
  readonly model: string;
  readonly fundingSource: ModelRequestFundingSource;
  /** The request's final message: its usage so far when stopped, zero when it failed before any. */
  readonly message: AssistantMessage;
  readonly finishedAt: number;
}

const OUTCOME_BY_STOP_REASON: Readonly<Record<StopReason, ModelRequestOutcome>> = {
  stop: 'completed',
  length: 'completed',
  toolUse: 'completed',
  aborted: 'stopped',
  error: 'error',
  pending: 'error',
};

/** The record of a request whose stream ended, priced from the release catalog. */
export function modelRequestRecord(end: ModelRequestEnd): ModelRequestRecord {
  const { usage } = end.message;
  const price = estimateUsage({
    observedAt: end.finishedAt,
    providerRoute: end.provider,
    requestedProvider: end.provider,
    requestedModel: end.model,
    returnedProvider: null,
    returnedModel: null,
    usageCompleteness: 'complete',
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: usage.cacheWrite1h ?? null,
    totalTokens: usage.totalTokens,
  });
  const priced = price.estimateCompleteness === 'complete';
  return {
    requestId: end.requestId,
    installationId: end.attribution.installationId,
    runId: end.attribution.runId,
    attemptId: end.attribution.attemptId,
    agentId: end.attribution.agentId,
    provider: end.provider,
    model: end.model,
    fundingSource: end.fundingSource,
    outcome: OUTCOME_BY_STOP_REASON[end.message.stopReason],
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    cacheWrite1hTokens: usage.cacheWrite1h ?? null,
    reasoningTokens: usage.reasoning ?? null,
    priceVersionId: priced ? price.priceVersionId : null,
    listPriceUsdMicros: priced ? price.estimateAmountMicros : null,
    priceUnknownReason: priced ? null : price.priceUnknownReason,
    finishedAt: end.finishedAt,
  };
}

/** The installation a usage row names: the hosted scope, or this deployment's own. */
export function usageInstallationId(
  platformEnv: PlatformEnv | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const scope = installationScopeOf(platformEnv);
  if (scope) return scope.installationId;
  const configured = platformEnv?.CHICKPEA_INSTALLATION_ID ?? processEnv.CHICKPEA_INSTALLATION_ID;
  if (typeof configured === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/.test(configured)) {
    return configured;
  }
  return 'chickpea';
}
