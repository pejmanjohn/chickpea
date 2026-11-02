/**
 * OpenAI prompt caching across Slack threads. pi-ai sends Flue's per-thread
 * affinity ID as `prompt_cache_key` and leaves only OpenAI's implicit write
 * at the end of the prompt, so a new thread never reads the tools and
 * constant block another thread wrote. On a model that takes explicit
 * breakpoints, a Slack turn whose developer message opens with a constant
 * block gets one breakpoint after that block and a key its installation
 * shares. `prompt_cache_options` stays as pi-ai built it: explicit mode would
 * drop the implicit write that same-thread follow-ups read.
 */
import type { Api, Model, OpenAIResponsesCompat } from '@earendil-works/pi-ai';

import { isRecord } from '../security/content-validation.ts';
import { sha256Hex } from '../security/digest.ts';
import { classifySlackSystemText, type SharedPrefixDecision } from './shared-prefix.ts';

type Payload = Record<string, unknown>;

/** `ckp1:` and 32 hex digits of SHA-256(installationId): under OpenAI's 64 characters, no raw ID, versioned for re-keying. */
export type PromptCacheKey = string & { readonly __promptCacheKey: true };

/** Requests in one scope may read each other's prefix. Never below an installation, never across two. */
export interface PromptCacheScope {
  readonly installationId: string;
}

/** Cut the developer text after `offset` UTF-16 units; the part before the cut ends in an explicit breakpoint. */
export interface PrefixCut {
  readonly offset: number;
}

export type LeaveReason =
  /** The model lacks pi-ai's flag, or the endpoint is not OpenAI's. */
  | 'breakpoints_unsupported'
  /** pi-ai sent no key, or explicit mode, which caches nothing without breakpoints. */
  | 'caching_off'
  | 'caller_breakpoints'
  /** `input[0]` is not a developer message with string content. */
  | 'no_developer_text'
  | 'not_shared_slack_turn'
  | 'reduced_slack_turn';

export type PromptCachePlan =
  | { readonly action: 'share'; readonly cuts: readonly [PrefixCut, ...PrefixCut[]] }
  | { readonly action: 'leave'; readonly reason: LeaveReason };

const OPENAI_ORIGIN = 'https://api.openai.com';

/** pi-ai's flag, set on GPT-5.6 and later, on OpenAI's own endpoint: a proxy may refuse the field. */
export function explicitBreakpointsOffered(model: Model<Api>): boolean {
  return model.api === 'openai-responses' &&
    (model.compat as OpenAIResponsesCompat | undefined)?.supportsExplicitPromptCacheMode === true &&
    httpsOrigin(model.baseUrl) === OPENAI_ORIGIN;
}

/** Pure. The model is checked before the payload is read. */
export function planPromptCache(payload: Payload, model: Model<Api>): PromptCachePlan {
  if (!explicitBreakpointsOffered(model)) return leave('breakpoints_unsupported');
  if (typeof payload.prompt_cache_key !== 'string' || explicitMode(payload.prompt_cache_options)) {
    return leave('caching_off');
  }
  const input = Array.isArray(payload.input) ? payload.input : [];
  if (input.some(carriesBreakpoint)) return leave('caller_breakpoints');
  const [developer] = input;
  if (!isRecord(developer) || developer.role !== 'developer' || typeof developer.content !== 'string') {
    return leave('no_developer_text');
  }
  const system = classifySlackSystemText(developer.content);
  if (system.kind === 'reduced') return leave('reduced_slack_turn');
  if (system.kind === 'other') return leave('not_shared_slack_turn');
  return { action: 'share', cuts: [{ offset: developer.content.length - system.tail.length }] };
}

export async function promptCacheKey(scope: PromptCacheScope): Promise<PromptCacheKey> {
  return `ckp1:${(await sha256Hex(scope.installationId)).slice(0, 32)}` as PromptCacheKey;
}

/**
 * For a payload `planPromptCache` shares: replaces only `prompt_cache_key`
 * and `input[0].content`, whose `input_text` parts join to the original
 * text. Copies, never mutates.
 */
export function applyPromptCachePlan(payload: Payload, cuts: readonly PrefixCut[], key: PromptCacheKey): Payload {
  const [developer, ...rest] = payload.input as [Payload, ...unknown[]];
  const text = developer.content as string;
  const bounds = [0, ...cuts.map((cut) => cut.offset), text.length];
  const content = bounds.slice(1).flatMap((end, index) => {
    const part = text.slice(bounds[index], end);
    if (part.length === 0) return [];
    return [index < cuts.length
      ? { type: 'input_text', text: part, prompt_cache_breakpoint: { mode: 'explicit' } }
      : { type: 'input_text', text: part }];
  });
  return { ...payload, prompt_cache_key: key, input: [{ ...developer, content }, ...rest] };
}

/** Any throw sends the payload as given. The charge's shared prefix stays Anthropic's alone. */
export async function shareOpenAIPromptCache(
  payload: Payload,
  request: { readonly requestId: string; readonly model: Model<Api>; readonly scope: PromptCacheScope },
): Promise<SharedPrefixDecision> {
  try {
    const plan = planPromptCache(payload, request.model);
    if (plan.action === 'leave') return { payload, sharedPrefix: null };
    return { payload: applyPromptCachePlan(payload, plan.cuts, await promptCacheKey(request.scope)), sharedPrefix: null };
  } catch (error) {
    console.warn('[chickpea] OpenAI prompt cache plan failed; the request goes out as built', {
      model: request.model.id,
      requestId: request.requestId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return { payload, sharedPrefix: null };
  }
}

function leave(reason: LeaveReason): PromptCachePlan {
  return { action: 'leave', reason };
}

function explicitMode(options: unknown): boolean {
  return isRecord(options) && options.mode === 'explicit';
}

/** A breakpoint on a message part or a tool output's part. */
function carriesBreakpoint(item: unknown): boolean {
  if (!isRecord(item)) return false;
  return [item.content, item.output].some((parts) => Array.isArray(parts) &&
    parts.some((part) => isRecord(part) && 'prompt_cache_breakpoint' in part));
}

function httpsOrigin(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
