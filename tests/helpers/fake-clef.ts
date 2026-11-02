import type { SlackInteractionDisposition } from '../../src/slack/interaction-intent.ts';

/**
 * Clef's wire shape, as observed inside a Worker through
 * `env.AI.run('@cf/cloudflare/clef', { state, questions })`. One builder for
 * the unit tests' fake binding, the parity backend's `/ai/run/clef` route, and
 * the Workers AI smoke stub, so every fake speaks the shape the production
 * parser reads.
 */

export type ClefProbabilities = Record<SlackInteractionDisposition, number>;

/** A named answer the fakes can be configured with; `error` makes the call fail. */
export type FakeClefAnswer = 'reply' | 'work' | 'react_only' | 'uncertain' | 'error';

/** Probability profiles: the confident ones clear the 0.6 gate, `uncertain` does not. */
export const CLEF_PROFILES: Readonly<Record<Exclude<FakeClefAnswer, 'error'>, ClefProbabilities>> = {
  reply: { reply: 0.81, work: 0.1, react_only: 0.05, ignore: 0.04 },
  work: { reply: 0.2, work: 0.7, react_only: 0.06, ignore: 0.04 },
  react_only: { reply: 0.05, work: 0.03, react_only: 0.9, ignore: 0.02 },
  uncertain: { reply: 0.45, work: 0.2, react_only: 0.3, ignore: 0.05 },
};

export function clefWire(
  probabilities: ClefProbabilities,
  options: { memory?: number; inputTokens?: number } = {},
): Record<string, unknown> {
  const [choice, top] = (Object.entries(probabilities) as Array<[SlackInteractionDisposition, number]>)
    .reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return {
    answers: {
      disposition: { type: 'choice', choice, probabilities, confidence: Number((top - 0.25).toFixed(3)) },
      memory: { type: 'noul', noul: options.memory ?? 0.02 },
      reaction: {
        type: 'choice',
        choice: 'seen',
        probabilities: { agreement: 0.1, done: 0.1, seen: 0.4, appreciation: 0.1, work_ack: 0.1, midwork_seen: 0.1, merged: 0.03, failed: 0.03, approved: 0.04 },
        confidence: 0.2,
      },
      target: { type: 'choice', choice: 'trigger', probabilities: { trigger: 0.6, thread_root: 0.3, latest_user: 0.1 }, confidence: 0.3 },
    },
    usage: { input_tokens: options.inputTokens ?? 878 },
  };
}

export function fakeClefAnswer(answer: Exclude<FakeClefAnswer, 'error'>): Record<string, unknown> {
  return clefWire(CLEF_PROFILES[answer]);
}

export interface FakeClefCall {
  model: string;
  inputs: Record<string, unknown>;
  options: unknown;
}

/**
 * A platform env whose `AI.run` answers Clef after `delayMs` with `answer`
 * (a named profile, a wire body, or a thrown error), recording each call.
 */
export function fakeClefEnv(
  answer: FakeClefAnswer | Record<string, unknown>,
  options: { delayMs?: number } = {},
): { env: { AI: { run: (...args: unknown[]) => Promise<unknown> } }; calls: FakeClefCall[] } {
  const calls: FakeClefCall[] = [];
  const run = async (...args: unknown[]): Promise<unknown> => {
    calls.push({ model: String(args[0]), inputs: args[1] as Record<string, unknown>, options: args[2] });
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (answer === 'error') throw new Error('Workers AI unavailable');
    return typeof answer === 'string' ? fakeClefAnswer(answer) : answer;
  };
  return { env: { AI: { run } }, calls };
}
