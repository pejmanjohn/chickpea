import type { AssistantMessage, StopReason } from '@earendil-works/pi-ai';

import { installationScopeOf } from '../config/installation-scope.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { isRecord } from '../security/content-validation.ts';
import { canonicalPriceProviderId } from './pricing/catalog.ts';
import { estimateUsage } from './pricing/estimate.ts';
import type { UsageEstimateResult } from './pricing/types.ts';
import { isStorableRequestText } from './validation.ts';

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
    providerResponseId: isStorableRequestText(end.message.responseId) ? end.message.responseId : null,
    finishedAt: end.finishedAt,
  };
}

const REPORTED_COST_WAIT_MS = 1_000;

export interface ReportedCostReader {
  readonly fetch: typeof fetch;
  lastReportedCostUsdMicros(): Promise<number | null>;
}

type CostBodyReader = (copy: Response, found: (parsed: unknown) => void) => Promise<void>;

const COST_BODY_READERS = new Map<string, CostBodyReader>([
  ['text/event-stream', readEventStreamCost],
  ['application/json', async (copy, found) => found(JSON.parse(await copy.text()))],
]);

/**
 * The library recomputes cost from its own price table, so the cost
 * OpenRouter reports is read here, from a copy of each response body.
 */
export function openRouterCostReader(base: typeof fetch | undefined): ReportedCostReader {
  let cost: number | null = null;
  const reads: Promise<void>[] = [];
  const found = (parsed: unknown) => {
    cost = reportedCostUsdMicros(parsed) ?? cost;
  };
  return {
    fetch: async (input, init) => {
      const response = await (base ?? globalThis.fetch)(input, init);
      const read = response.ok && response.body ? COST_BODY_READERS.get(mediaType(response.headers)) : undefined;
      if (read) reads.push(readCopy(response.clone(), read, found));
      return response;
    },
    async lastReportedCostUsdMicros() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REPORTED_COST_WAIT_MS);
      });
      await Promise.race([Promise.all(reads), waited]);
      clearTimeout(timer);
      return cost;
    },
  };
}

async function readCopy(copy: Response, read: CostBodyReader, found: (parsed: unknown) => void): Promise<void> {
  try {
    await read(copy, found);
  } catch {}
}

async function readEventStreamCost(copy: Response, found: (parsed: unknown) => void): Promise<void> {
  const reader = copy.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let data: string[] = [];
  const dispatch = () => {
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]' || !payload.includes('"usage"')) return;
    try {
      found(JSON.parse(payload));
    } catch {}
  };
  const take = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') dispatch();
    else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  };
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let start = 0;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n', start)) {
      take(pending.slice(start, end));
      start = end + 1;
    }
    pending = pending.slice(start);
    if (done) break;
  }
  if (pending) take(pending);
  dispatch();
}

function reportedCostUsdMicros(parsed: unknown): number | null {
  const usage = isRecord(parsed) ? parsed.usage : undefined;
  const cost = isRecord(usage) ? usage.cost : undefined;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  // OpenRouter's unit is the credit, one US dollar. Rounding the product to 15
  // significant digits first keeps binary error off a half-micro boundary.
  const micros = Math.round(Number((cost * 1_000_000).toPrecision(15)));
  return Number.isSafeInteger(micros) ? micros : null;
}

function mediaType(headers: Headers): string {
  return headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
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
