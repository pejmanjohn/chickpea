import type { PlatformEnv } from '../config/state-backend.ts';

/**
 * The deployment variable that turns host release on: `host` lets the host
 * stream an Agent's answer text into Slack once a model step holds enough
 * settled text and no tool call (src/slack/host-release-relay.ts). Unset, or
 * any other value, keeps the model's `stream_answer` declaration as the only
 * way an answer streams.
 */
export const ANSWER_RELEASE_VARIABLE = 'CHICKPEA_SLACK_ANSWER_RELEASE';

/** The hold: settled characters a step must reach before its text is released. */
export const ANSWER_RELEASE_CHARS_VARIABLE = 'CHICKPEA_SLACK_ANSWER_RELEASE_CHARS';

/** The hold when ANSWER_RELEASE_CHARS_VARIABLE is unset. */
export const DEFAULT_ANSWER_RELEASE_CHARS = 400;
export const MIN_ANSWER_RELEASE_CHARS = 100;
export const MAX_ANSWER_RELEASE_CHARS = 4_000;

export interface AnswerReleaseSetting {
  holdChars: number;
}

/**
 * The hold an ANSWER_RELEASE_CHARS_VARIABLE value sets. Unset or empty is the
 * default. Throws for anything but a whole number from MIN_ANSWER_RELEASE_CHARS
 * to MAX_ANSWER_RELEASE_CHARS. No deploy check calls it yet, so such a value
 * reaches the Worker, where `answerReleaseSetting` turns host release off.
 */
export function parseAnswerReleaseChars(value: unknown): number {
  if (value === undefined || value === '') return DEFAULT_ANSWER_RELEASE_CHARS;
  const digits = typeof value === 'number' ? String(value) : value;
  const chars = typeof digits === 'string' && /^[0-9]+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!(chars >= MIN_ANSWER_RELEASE_CHARS && chars <= MAX_ANSWER_RELEASE_CHARS)) {
    throw new Error(
      `${ANSWER_RELEASE_CHARS_VARIABLE} must be a whole number of characters from ` +
      `${MIN_ANSWER_RELEASE_CHARS} to ${MAX_ANSWER_RELEASE_CHARS}, or unset for ${DEFAULT_ANSWER_RELEASE_CHARS}.`,
    );
  }
  return chars;
}

/**
 * Host release as this deployment's env sets it; undefined when it is off. A
 * hold outside the range turns it off rather than guess a value.
 */
export function answerReleaseSetting(env: PlatformEnv | undefined): AnswerReleaseSetting | undefined {
  const value = env?.[ANSWER_RELEASE_VARIABLE];
  if (typeof value !== 'string' || value.trim().toLowerCase() !== 'host') return undefined;
  try {
    return { holdChars: parseAnswerReleaseChars(env?.[ANSWER_RELEASE_CHARS_VARIABLE]) };
  } catch {
    return undefined;
  }
}
