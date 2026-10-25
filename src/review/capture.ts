import type { ConversationStreamChunk } from '@flue/runtime';

import { installationScopeOf } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { decodeBase64Url, encodeBase64Url } from '../security/base64url.ts';
import type { SlackTurnContext } from '../slack/thread-context.ts';
import { RunReviewCollector } from './collector.ts';
import { runReview, type RunReviewPort } from './port.ts';
import {
  buildRunReviewRecord,
  runReviewPseudonymizer,
  type RunReviewInput,
  type RunReviewOutcome,
  type RunReviewSurface,
} from './record.ts';

/** 32 random bytes, written once by compare-and-set; independent of the telemetry opt-out. */
export const RUN_REVIEW_PSEUDONYM_SETTING = 'review.pseudonym.v1';

const CAPTURING_BOUND_MS = 1_000;
const FINISH_BOUND_MS = 5_000;
const KEY_BYTES = 32;
const TIMED_OUT = Symbol('timed out');

type ConversationSnapshot = Extract<ConversationStreamChunk, { type: 'conversation-reset' }>['snapshot'];

export interface RunReviewStart {
  surface: RunReviewSurface;
  /** Shared beyond the workspace, as through Slack Connect: never captured. */
  sharedChannel?: boolean;
  /** Where the installation's review key is kept; reached only once a copy is built. */
  settings: () => SettingsStore;
}

/** The message the Agent answered and the rows its prompt carried with it. */
export type RunReviewConversation = Pick<RunReviewInput, 'trigger' | 'context'>;

export interface RunReviewEnding extends RunReviewConversation {
  runId: string;
  agentId: string;
  model?: string;
  answer?: string;
  outcome: RunReviewOutcome;
  error?: { class: string; message: string };
  /** Epoch milliseconds. */
  receivedAt?: number;
  /** Epoch milliseconds. */
  admittedAt?: number;
  /** The settled submission's history, read only when its stream was never observed. */
  history?: { submissionId: string; read(): Promise<ConversationSnapshot | undefined> };
}

export interface RunReviewSession {
  /** Every chunk a reply observation reads, beside its submission. Never throws. */
  ingest(chunk: ConversationStreamChunk, submissionId: string): void;
  /** Builds, scrubs and stores the copy, once. Bounded; never throws. */
  finish(ending: RunReviewEnding): Promise<void>;
}

/**
 * A run's review session, or undefined: no port, no installation, a shared
 * channel, or the host not capturing. A slow or failing answer is not
 * capturing.
 */
export async function startRunReview(
  env: PlatformEnv | undefined,
  start: RunReviewStart,
): Promise<RunReviewSession | undefined> {
  const port = runReview();
  if (!port || start.sharedChannel) return undefined;
  const installationId = installationScopeOf(env)?.installationId;
  if (!installationId) return undefined;
  let capturing: boolean | typeof TIMED_OUT;
  try {
    capturing = await within(port.capturing(installationId), CAPTURING_BOUND_MS);
  } catch {
    capturing = TIMED_OUT;
  }
  if (capturing === TIMED_OUT) warn('capturing_unavailable');
  return capturing === true ? new Session(port, installationId, start) : undefined;
}

/** A Slack turn's trigger and context rows; people are named by Slack user ID until the builder pseudonymizes them. */
export function slackRunReviewConversation(
  turn: { userId: string; text: string },
  context: SlackTurnContext | undefined,
): RunReviewConversation {
  const messages = context?.messages ?? [];
  const trigger = messages.find((message) => message.isTrigger);
  const notes = (files: readonly { name: string; sizeBytes?: number }[] | undefined) =>
    (files ?? []).map((file) => ({ name: file.name, ...(file.sizeBytes === undefined ? {} : { size: file.sizeBytes }) }));
  return {
    trigger: { author: turn.userId, text: trigger?.text ?? turn.text, files: notes(trigger?.files) },
    context: messages.filter((message) => !message.isTrigger).map((message) => {
      const role = message.role ?? 'human';
      return {
        author: role === 'human' ? message.userId : message.authorName ?? message.userId,
        role,
        text: message.text,
        files: notes(message.files),
      };
    }),
  };
}

export function runReviewError(error: unknown): { class: string; message: string } {
  return error instanceof Error
    ? { class: error.name, message: error.message }
    : { class: typeof error, message: String(error) };
}

class Session implements RunReviewSession {
  #collector: RunReviewCollector | undefined;
  #broken = false;
  #finished = false;

  constructor(
    private readonly port: RunReviewPort,
    private readonly installationId: string,
    private readonly start: RunReviewStart,
  ) {}

  ingest(chunk: ConversationStreamChunk, submissionId: string): void {
    if (this.#broken) return;
    try {
      this.#collector ??= new RunReviewCollector(submissionId);
      if (this.#collector.submissionId === submissionId) this.#collector.ingest(chunk);
    } catch {
      this.#broken = true;
      warn('collect_failed');
    }
  }

  async finish(ending: RunReviewEnding): Promise<void> {
    if (this.#finished || this.#broken) return;
    this.#finished = true;
    let abandoned = false;
    try {
      if (await within(this.#store(ending, () => abandoned), FINISH_BOUND_MS) === TIMED_OUT) {
        abandoned = true;
        warn('record_timed_out');
      }
    } catch {
      warn('record_failed');
    }
  }

  async #store(ending: RunReviewEnding, abandoned: () => boolean): Promise<void> {
    let collector = this.#collector;
    let source: RunReviewInput['source'] = 'stream';
    if (!collector && ending.history) {
      const snapshot = await ending.history.read();
      if (snapshot) {
        collector = RunReviewCollector.fromHistory(snapshot, ending.history.submissionId);
        source = 'history';
      }
    }
    const key = await loadOrCreateRunReviewKey(this.start.settings());
    const now = new Date().toISOString();
    const record = buildRunReviewRecord({
      runId: ending.runId,
      recordedAt: now,
      surface: this.start.surface,
      agentId: ending.agentId,
      ...(ending.model === undefined ? {} : { model: ending.model }),
      trigger: ending.trigger,
      context: ending.context,
      steps: collector?.steps() ?? [],
      ...(ending.answer === undefined ? {} : { answer: ending.answer }),
      outcome: ending.outcome,
      ...(ending.error ? { error: ending.error } : {}),
      timings: {
        ...(ending.receivedAt === undefined ? {} : { receivedAt: new Date(ending.receivedAt).toISOString() }),
        ...(ending.admittedAt === undefined ? {} : { admittedAt: new Date(ending.admittedAt).toISOString() }),
        settledAt: now,
      },
      truncated: collector?.truncated ?? false,
      source,
    }, runReviewPseudonymizer(key));
    if (abandoned()) return;
    await this.port.record(this.installationId, record);
  }
}

async function loadOrCreateRunReviewKey(settings: SettingsStore): Promise<Uint8Array> {
  const current = await settings.getSetting(RUN_REVIEW_PSEUDONYM_SETTING);
  if (current !== undefined) return parseStoredKey(current);
  const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const written = await settings.applySettingsPatch({
    expected: { key: RUN_REVIEW_PSEUDONYM_SETTING, value: null },
    set: [{ key: RUN_REVIEW_PSEUDONYM_SETTING, value: JSON.stringify({ version: 1, key: encodeBase64Url(key) }) }],
  });
  if (written) return key;
  const winner = await settings.getSetting(RUN_REVIEW_PSEUDONYM_SETTING);
  if (winner === undefined) throw new Error('The run review key is unavailable.');
  return parseStoredKey(winner);
}

function parseStoredKey(raw: string): Uint8Array {
  const stored = JSON.parse(raw) as { version?: unknown; key?: unknown } | null;
  if (stored?.version !== 1 || typeof stored.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(stored.key)) {
    throw new Error('The run review key is malformed.');
  }
  const key = decodeBase64Url(stored.key);
  if (key.byteLength !== KEY_BYTES) throw new Error('The run review key is malformed.');
  return key;
}

async function within<T>(work: Promise<T>, milliseconds: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function warn(event: string): void {
  console.warn(JSON.stringify({ component: 'run_review', event }));
}
