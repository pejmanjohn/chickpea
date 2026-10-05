import { AsyncLocalStorage } from 'node:async_hooks';

import {
  useResponseFinish,
  type FlueEventContext,
  type FlueExecutionInterceptor,
  type FlueObservation,
  type PromptUsage,
} from '@flue/runtime';

export const CHICKPEA_RESPONSE_METADATA_KEY = 'chickpea';

export interface ChickpeaResponseMetadata {
  schemaVersion: 1;
  requestedModel: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** The part of `cacheWrite` written for one hour; present only when non-zero. */
    cacheWrite1h?: number;
    totalTokens: number;
  };
  returnedModel?: {
    provider: string;
    id: string;
  };
}

interface ResponseMetadataState {
  returnedModel?: ChickpeaResponseMetadata['returnedModel'];
  cacheWrite1h?: number;
}

const responseMetadataState = new AsyncLocalStorage<ResponseMetadataState>();

/** Restore one metadata cell around the complete root-agent operation. */
export const responseMetadataInterceptor: FlueExecutionInterceptor = async (
  operation,
  _context,
  next,
) => operation.type === 'agent'
  ? responseMetadataState.run({}, next)
  : next();

/**
 * Track only the last successful primary agent turn. Compaction model calls
 * contribute to Flue's aggregate token usage but must never masquerade as the
 * model that authored the user-facing response. One-hour cache writes are
 * summed from each step's message, because Flue's aggregate drops that split.
 */
export function observeResponseMetadata(
  event: FlueObservation,
  _context: FlueEventContext,
): void {
  const state = responseMetadataState.getStore();
  if (!state) return;
  if (event.type === 'message_end' && event.message.role === 'assistant') {
    state.cacheWrite1h = (state.cacheWrite1h ?? 0) + boundedTokenCount(event.message.usage.cacheWrite1h ?? 0);
    return;
  }
  if (event.type !== 'turn' || event.purpose !== 'agent' || event.isError) return;
  const id = nonEmpty(event.response.responseModel) ?? event.request.requestedModel;
  state.returnedModel = {
    provider: event.request.providerId,
    id,
  };
}

/** Mount the sole measured-usage envelope consumed by Chickpea relays. */
export function useChickpeaResponseMetadata(requestedModel: string): void {
  useResponseFinish(({ response }) => {
    const state = responseMetadataState.getStore();
    return {
      [CHICKPEA_RESPONSE_METADATA_KEY]: responseUsageMetadata(
        requestedModel,
        response.usage,
        state?.returnedModel,
        state?.cacheWrite1h,
      ),
    };
  });
}

export function responseUsageMetadata(
  requestedModel: string,
  usage: PromptUsage,
  returnedModel?: ChickpeaResponseMetadata['returnedModel'],
  cacheWrite1h = 0,
): ChickpeaResponseMetadata {
  const longCacheWrite = boundedTokenCount(cacheWrite1h);
  return {
    schemaVersion: 1,
    requestedModel,
    usage: {
      input: boundedTokenCount(usage.input),
      output: boundedTokenCount(usage.output),
      cacheRead: boundedTokenCount(usage.cacheRead),
      cacheWrite: boundedTokenCount(usage.cacheWrite),
      ...(longCacheWrite > 0 ? { cacheWrite1h: longCacheWrite } : {}),
      totalTokens: boundedTokenCount(usage.totalTokens),
    },
    ...(returnedModel ? { returnedModel } : {}),
  };
}

/** The envelope `useChickpeaResponseMetadata` wrote, or undefined when absent or malformed. */
export function parseChickpeaResponseMetadata(value: unknown): ChickpeaResponseMetadata | undefined {
  const record = asRecord(value);
  if (!record || record.schemaVersion !== 1) return undefined;
  const requestedModel = nonEmpty(record.requestedModel);
  const usage = asRecord(record.usage);
  if (!requestedModel || !usage) return undefined;
  if (![usage.input, usage.output, usage.totalTokens].every(isTokenCount)) return undefined;
  const returned = asRecord(record.returnedModel);
  const provider = nonEmpty(returned?.provider);
  const id = nonEmpty(returned?.id);
  const longCacheWrite = isTokenCount(usage.cacheWrite1h) ? Number(usage.cacheWrite1h) : 0;
  return {
    schemaVersion: 1,
    requestedModel,
    usage: {
      input: Number(usage.input),
      output: Number(usage.output),
      cacheRead: isTokenCount(usage.cacheRead) ? Number(usage.cacheRead) : 0,
      cacheWrite: isTokenCount(usage.cacheWrite) ? Number(usage.cacheWrite) : 0,
      ...(longCacheWrite > 0 ? { cacheWrite1h: longCacheWrite } : {}),
      totalTokens: Number(usage.totalTokens),
    },
    ...(provider && id ? { returnedModel: { provider, id } } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function boundedTokenCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
