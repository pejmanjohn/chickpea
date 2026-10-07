import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai';

import { installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { canonicalPriceProviderId } from './pricing/catalog.ts';
import { estimateUsage } from './pricing/estimate.ts';
import type { UsageEstimateResult } from './pricing/types.ts';
import { isRequestText } from './validation.ts';

export type ModelRequestOutcome = 'completed' | 'stopped' | 'error';

/** Who pays the provider: the installation's own key, or Chickpea's, drawn from the installation's credits. */
export type ModelRequestFundingSource = 'customer' | 'platform';

export interface ModelRequestAttribution {
  readonly installationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly agentId: string | null;
}

/** A part the provider reported is already counted in `total`; null when it reports no split. */
export interface CacheWriteTokens {
  readonly total: number;
  readonly oneHour: number | null;
}

export interface OutputTokens {
  readonly total: number;
  readonly reasoning: number | null;
}

export interface ModelRequestRecord extends ModelRequestAttribution {
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly fundingSource: ModelRequestFundingSource;
  readonly outcome: ModelRequestOutcome;
  readonly inputTokens: number;
  readonly outputTokens: OutputTokens;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: CacheWriteTokens;
  readonly priceVersionId: string | null;
  readonly listPriceUsdMicros: number | null;
  readonly priceUnknownReason: UsageEstimateResult['priceUnknownReason'];
  readonly providerCostUsdMicros: number | null;
  readonly providerResponseId: string | null;
  readonly finishedAt: number;
}

export interface ModelRequestEnd {
  readonly requestId: string;
  readonly attribution: ModelRequestAttribution;
  /** The registered provider the request was sent through, an alias route included. */
  readonly route: string;
  readonly model: string;
  readonly fundingSource: ModelRequestFundingSource;
  readonly message: AssistantMessage;
  readonly providerCostUsdMicros: number | null;
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

export function modelRequestRecord(end: ModelRequestEnd): ModelRequestRecord {
  const { usage } = end.message;
  const provider = canonicalPriceProviderId(end.route);
  const price = estimateUsage({
    observedAt: end.finishedAt,
    providerRoute: provider,
    requestedProvider: provider,
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
    singleRequest: true,
  });
  const priced = price.estimateCompleteness === 'complete';
  return {
    requestId: end.requestId,
    installationId: end.attribution.installationId,
    runId: end.attribution.runId,
    attemptId: end.attribution.attemptId,
    agentId: end.attribution.agentId,
    provider,
    model: end.model,
    fundingSource: end.fundingSource,
    outcome: OUTCOME_BY_STOP_REASON[end.message.stopReason],
    inputTokens: usage.input,
    outputTokens: { total: usage.output, reasoning: usage.reasoning ?? null },
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: { total: usage.cacheWrite, oneHour: usage.cacheWrite1h ?? null },
    priceVersionId: priced ? price.priceVersionId : null,
    listPriceUsdMicros: priced ? price.estimateAmountMicros : null,
    priceUnknownReason: priced ? null : price.priceUnknownReason,
    providerCostUsdMicros: end.providerCostUsdMicros,
    // A provider ID the store would refuse is dropped, never the whole record.
    providerResponseId: isRequestText(end.message.responseId) ? end.message.responseId : null,
    finishedAt: end.finishedAt,
  };
}

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
