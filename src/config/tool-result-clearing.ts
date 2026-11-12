/**
 * Anthropic's server-side clearing of old tool results (context editing's
 * `clear_tool_uses_20250919`), behind a deployment variable that is off by
 * default. With it on, an Agent's model requests to the Anthropic API ask the
 * provider to replace the oldest tool results with a placeholder once the
 * prompt passes a trigger, keeping the most recent ones and every tool call.
 * Flue's stored conversation still holds each result in full, and every
 * request sends it: the provider clears again on each request. Between
 * clearings the cleared prompt stays the same, so later requests read the
 * cache; a clearing rewrites it from the first newly cleared result on.
 */
import { envValue } from './env-value.ts';
import type { PlatformEnv } from './state-backend.ts';
import { isRecord } from '../security/content-validation.ts';

/** `on` turns clearing on. Unset, or any other value, leaves requests as they were. */
export const TOOL_RESULT_CLEARING_VARIABLE = 'CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING';

/** Each setting's deployment variable; one unset, or not a whole number in range, takes the default. */
export const TOOL_RESULT_CLEARING_SETTING_VARIABLES = {
  triggerTokens: 'CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_TRIGGER_TOKENS',
  keepToolUses: 'CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_KEEP_TOOL_USES',
  clearAtLeastTokens: 'CHICKPEA_ANTHROPIC_TOOL_RESULT_CLEARING_CLEAR_AT_LEAST_TOKENS',
} as const;

export const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
const CLEAR_TOOL_USES = 'clear_tool_uses_20250919';

export interface ToolResultClearing {
  /** The prompt's input tokens, before clearing, above which the provider clears. */
  readonly triggerTokens: number;
  /** The most recent tool uses whose results are never cleared. */
  readonly keepToolUses: number;
  /** A clearing that would remove fewer tokens is skipped, so clearings come seldom and large. */
  readonly clearAtLeastTokens: number;
}

/**
 * No typical thread reaches 250,000 tokens, so only long ones are touched.
 * Eight results cover a turn's recent reads. 60,000 tokens a clearing makes
 * each cache rewrite buy a large cut: about five large results at a time.
 */
export const DEFAULT_TOOL_RESULT_CLEARING: ToolResultClearing = {
  triggerTokens: 250_000,
  keepToolUses: 8,
  clearAtLeastTokens: 60_000,
};

const SETTING_RANGES: Readonly<Record<keyof ToolResultClearing, readonly [number, number]>> = {
  triggerTokens: [1, 1_000_000],
  // At least one: the newest result is the one the model is about to read.
  keepToolUses: [1, 100],
  clearAtLeastTokens: [1, 1_000_000],
};

/**
 * Tools whose results are instructions the Agent keeps following, not data
 * it can fetch again: a skill's instructions and its supporting files, and
 * the Agent's memory. Their results are never cleared.
 */
export const UNCLEARED_TOOLS = ['activate_skill', 'read_skill_resource', 'inspect_memory', 'update_agent_memory'] as const;

/** The clearing `env` turns on, or undefined when it is off. */
export function toolResultClearing(env: PlatformEnv | undefined): ToolResultClearing | undefined {
  if (envValue(env, TOOL_RESULT_CLEARING_VARIABLE)?.toLowerCase() !== 'on') return undefined;
  const setting = (key: keyof ToolResultClearing): number => {
    const value = envValue(env, TOOL_RESULT_CLEARING_SETTING_VARIABLES[key]);
    const [min, max] = SETTING_RANGES[key];
    const parsed = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
    return parsed >= min && parsed <= max ? parsed : DEFAULT_TOOL_RESULT_CLEARING[key];
  };
  return { triggerTokens: setting('triggerTokens'), keepToolUses: setting('keepToolUses'), clearAtLeastTokens: setting('clearAtLeastTokens') };
}

type Payload = Record<string, unknown>;

/**
 * The Anthropic request `payload` with the clearing edit and its beta added to
 * the betas pi-ai already sends. A payload that already manages its context,
 * or whose betas are not a list, goes out as built.
 */
export function withToolResultClearing(payload: Payload, clearing: ToolResultClearing): Payload {
  const betas = payload.betas ?? [];
  if (payload.context_management !== undefined || !Array.isArray(betas) || !betas.every((beta) => typeof beta === 'string')) {
    return payload;
  }
  const sent = sentToolNames(payload);
  const exclude = UNCLEARED_TOOLS.filter((name) => sent.has(name));
  return {
    ...payload,
    betas: [...new Set([...betas, CONTEXT_MANAGEMENT_BETA])],
    context_management: {
      edits: [{
        type: CLEAR_TOOL_USES,
        trigger: { type: 'input_tokens', value: clearing.triggerTokens },
        keep: { type: 'tool_uses', value: clearing.keepToolUses },
        clear_at_least: { type: 'input_tokens', value: clearing.clearAtLeastTokens },
        // Only tools the request defines: an Agent without skills sends no skill tool.
        ...(exclude.length > 0 ? { exclude_tools: exclude } : {}),
      }],
    },
  };
}

/** The request's tool names: its tool list, and each tool pi-ai adds later by value in a `tool_addition` block. */
function sentToolNames(payload: Payload): Set<string> {
  const names = new Set<string>();
  const add = (tool: unknown) => {
    if (isRecord(tool) && typeof tool.name === 'string') names.add(tool.name);
  };
  if (Array.isArray(payload.tools)) payload.tools.forEach(add);
  for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
    if (!isRecord(message) || message.role !== 'system' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'tool_addition' && isRecord(block.tool)) add(block.tool.definition);
    }
  }
  return names;
}

/** What the provider cleared from one request's prompt, every earlier clearing included. */
export interface ClearedToolResults {
  readonly toolUses: number;
  readonly inputTokens: number;
}

/**
 * The clearing an Anthropic stream event reports: `message_delta` carries
 * `context_management.applied_edits` at the end of the response, and
 * `message_start` may carry it too. Undefined for any other event, or one
 * without it: a request sent without the edit reports none.
 */
export function clearedToolResults(event: unknown): ClearedToolResults | undefined {
  if (!isRecord(event)) return undefined;
  const reported = event.type === 'message_delta' ? event : event.type === 'message_start' ? event.message : undefined;
  const edits = isRecord(reported) && isRecord(reported.context_management)
    ? reported.context_management.applied_edits
    : undefined;
  if (!Array.isArray(edits)) return undefined;
  let toolUses = 0;
  let inputTokens = 0;
  for (const edit of edits) {
    if (!isRecord(edit) || edit.type !== CLEAR_TOOL_USES) continue;
    toolUses += count(edit.cleared_tool_uses);
    inputTokens += count(edit.cleared_input_tokens);
  }
  return { toolUses, inputTokens };
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
