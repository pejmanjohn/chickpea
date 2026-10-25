/**
 * One run's review copy, `chickpea.run-review.v1`: what the prompt carried
 * this turn, the steps the Agent took, and how it ended. The builder scrubs
 * every string before the record exists; a port never sees one unscrubbed.
 */

export const RUN_REVIEW_RECORD_FORMAT = 'chickpea.run-review.v1';

/** A Slack user's stand-in: an HMAC of their ID under the installation's own review key. */
export type RunReviewPseudonym = `u_${string}`;

export interface RunReviewFileNote {
  name: string;
  size?: number;
}

export type RunReviewSurface = 'channel' | 'dm' | 'group_dm' | 'routine';

export type RunReviewOutcome = 'succeeded' | 'no_op' | 'failed' | 'stopped';

export type RunReviewStep =
  | { kind: 'text' | 'reasoning'; text: string }
  | { kind: 'tool'; name: string; input: string; output?: string; error?: string; durationMs?: number };

export interface RunReviewContextMessage {
  /** A person's pseudonym, or an app's or Agent's label. */
  author: RunReviewPseudonym | string;
  role: 'human' | 'agent' | 'app';
  text: string;
  files: RunReviewFileNote[];
}

export interface RunReviewRecordV1 {
  format: typeof RUN_REVIEW_RECORD_FORMAT;
  /** The canonical run ID, else the turn ID on the legacy path without one. */
  runId: string;
  /** ISO 8601. */
  recordedAt: string;
  surface: RunReviewSurface;
  agentId: string;
  /** The model the provider reported answering with. */
  model?: string;
  trigger: { author: RunReviewPseudonym | 'routine'; text: string; files: RunReviewFileNote[] };
  context: RunReviewContextMessage[];
  steps: RunReviewStep[];
  /** The Agent's delivered text. */
  answer?: string;
  outcome: RunReviewOutcome;
  error?: { class: string; message: string };
  /** ISO 8601. */
  timings: { receivedAt?: string; admittedAt?: string; settledAt: string };
  /** Something was cut to fit the caps. */
  truncated: boolean;
  /** Which trace produced `steps`: the observed stream, or the settled history read afterwards. */
  source: 'stream' | 'history';
}
