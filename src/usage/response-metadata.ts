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
    totalTokens: number;
  };
  returnedModel?: {
    provider: string;
    id: string;
  };
}

interface ResponseMetadataState {
  returnedModel?: ChickpeaResponseMetadata['returnedModel'];
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
 * model that authored the user-facing response.
 */
export function observeResponseMetadata(
  event: FlueObservation,
  _context: FlueEventContext,
): void {
  if (event.type !== 'turn' || event.purpose !== 'agent' || event.isError) return;
  const state = responseMetadataState.getStore();
  if (!state) return;
  const id = nonEmpty(event.response.responseModel) ?? event.request.requestedModel;
  state.returnedModel = {
    provider: event.request.providerId,
    id,
  };
}

/** Mount the sole measured-usage envelope consumed by Chickpea relays. */
export function useChickpeaResponseMetadata(requestedModel: string): void {
  useResponseFinish(({ response }) => ({
    [CHICKPEA_RESPONSE_METADATA_KEY]: responseUsageMetadata(
      requestedModel,
      response.usage,
      responseMetadataState.getStore()?.returnedModel,
    ),
  }));
}

export function responseUsageMetadata(
  requestedModel: string,
  usage: PromptUsage,
  returnedModel?: ChickpeaResponseMetadata['returnedModel'],
): ChickpeaResponseMetadata {
  return {
    schemaVersion: 1,
    requestedModel,
    usage: {
      input: boundedTokenCount(usage.input),
      output: boundedTokenCount(usage.output),
      totalTokens: boundedTokenCount(usage.totalTokens),
    },
    ...(returnedModel ? { returnedModel } : {}),
  };
}

function boundedTokenCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
