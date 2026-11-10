/**
 * What a failed agent run failed of, read from its error and the causes
 * beneath it: a host refusal (a daily limit, or out of usage), an OpenAI
 * subscription problem, the provider, or the Agent itself.
 */
import { dailyLimitOf, outOfUsageOf, type DailyLimitAdmission, type OutOfUsage } from '../config/platform-funding.ts';

export type AgentPromptFailureKind =
  | 'agent'
  | 'provider'
  | 'invalid-output'
  | 'openai-subscription-reconnect'
  | 'openai-subscription-quota'
  | 'openai-subscription-policy'
  | 'credits-exhausted'
  | 'daily-limit';

/**
 * A failure's kind, the daily limit that is a `daily-limit` failure, or the
 * refusal with a cause that is a `credits-exhausted` failure.
 */
export type AgentFailure = Exclude<AgentPromptFailureKind, 'daily-limit'> | DailyLimitAdmission | OutOfUsage;

/** A settled run's failure, by its error and every cause beneath it. */
export function classifyFlueRunFailure(error: unknown): AgentFailure {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let type = '';
  let message = '';
  for (let depth = 0; current && depth < 5 && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = asRecord(current);
    if (!record) break;
    type += ` ${typeof record.type === 'string' ? record.type : ''}`;
    message += ` ${typeof record.message === 'string' ? record.message : ''}`;
    current = record.cause;
  }
  return classifyFailureText(type, message);
}

export function classifyFailureText(typeValue: string, messageValue: string): AgentFailure {
  const type = typeValue.toLowerCase();
  const message = messageValue.toLowerCase();
  const searchable = `${type} ${message}`;
  const dailyLimit = dailyLimitOf({ message: messageValue });
  if (dailyLimit) return dailyLimit;
  const outOfUsage = outOfUsageOf({ message: messageValue });
  if (outOfUsage) return outOfUsage.cause ? outOfUsage : 'credits-exhausted';
  if (
    message.includes('openai subscription operation failed (auth_reconnect_required)') ||
    message.includes('openai subscription operation failed (authorization_missing)') ||
    message.includes('openai subscription operation failed (storage_invalid)')
  ) return 'openai-subscription-reconnect';
  if (message.includes('openai subscription operation failed (subscription_quota_exhausted)')) {
    return 'openai-subscription-quota';
  }
  if (
    message.includes('openai subscription operation failed (entitlement_denied)') ||
    message.includes('openai subscription operation failed (client_rejected)') ||
    message.includes('openai subscription operation failed (originator_rejected)')
  ) return 'openai-subscription-policy';
  // A coding workspace never fails the turn: its tools report failures to
  // the model as tool results. Anything sandbox-shaped here is the Agent's.
  if (
    type.includes('sandbox_session_cap_reached') ||
    type.includes('sandbox_unavailable') ||
    type.includes('sandbox_connection_dropped')
  ) return 'agent';
  if (
    type.includes('cloudflare_ai_binding_error') ||
    type.includes('invalid_provider_registration') ||
    /\b(model|provider|llm|workers ai)\b/.test(searchable)
  ) return 'provider';
  return 'agent';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}
