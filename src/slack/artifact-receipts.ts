import * as v from 'valibot';
import { useDataWriter, usePersistentState, useResponseStart } from '@flue/runtime';

/**
 * Host-authored receipts for files an Agent staged during one response.
 *
 * New receipts describe privately completed uploads and their Slack permalinks.
 * Legacy receipts remain readable for persisted work. Neither carries bytes
 * or upload URLs. The frozen destination controls where final delivery may
 * share the file in the Agent's message.
 */

export const SLACK_ARTIFACT_RECEIPTS_DATA_NAME = 'slackArtifactReceipts';
export const MAX_SLACK_ARTIFACT_RECEIPTS = 10;
const MAX_FILENAME_CHARS = 256;
const MAX_TITLE_CHARS = 256;

const SLACK_FILE_ID = /^F[A-Z0-9]{6,40}$/;
const SLACK_ID = /^[A-Z0-9]{1,40}$/;
const SLACK_TS = /^\d{1,20}\.\d{1,10}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const MAX_PERMALINK_CHARS = 2_048;

/** Slack workspace permalinks must name this exact file without bearer data. */
export function isSlackFilePermalink(value: unknown, fileId: string): value is string {
  if (typeof value !== 'string' || value.length > MAX_PERMALINK_CHARS ||
      !SLACK_FILE_ID.test(fileId) || /[\u0000-\u0020\u007f<>&|\\?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    const path = url.pathname.split('/');
    return url.href.length <= MAX_PERMALINK_CHARS && url.protocol === 'https:' &&
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+slack(?:-gov)?\.com$/.test(url.hostname) &&
      !url.username && !url.password && !url.port && path[1] === 'files' &&
      typeof path[2] === 'string' && SLACK_ID.test(path[2]) && path[3] === fileId;
  } catch {
    return false;
  }
}

const receiptFields = {
  fileId: v.pipe(v.string(), v.regex(SLACK_FILE_ID)),
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FILENAME_CHARS)),
  title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_TITLE_CHARS))),
  kind: v.picklist(['file', 'chart']),
  byteLength: v.pipe(v.number(), v.integer(), v.minValue(1)),
  stagedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  destination: v.strictObject({
    workspaceId: v.pipe(v.string(), v.regex(SLACK_ID)),
    agentId: v.pipe(v.string(), v.regex(AGENT_ID)),
    channelId: v.pipe(v.string(), v.regex(SLACK_ID)),
    threadTs: v.optional(v.pipe(v.string(), v.regex(SLACK_TS))),
  }),
};

export const SlackArtifactReceiptSchema = v.pipe(v.variant('schemaVersion', [
  v.strictObject({ schemaVersion: v.literal(1), ...receiptFields }),
  v.strictObject({
    schemaVersion: v.literal(2),
    ...receiptFields,
    permalink: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_PERMALINK_CHARS)),
    completedAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
]), v.check((receipt) => receipt.schemaVersion === 1 || isSlackFilePermalink(receipt.permalink, receipt.fileId)));

export type SlackArtifactReceipt = v.InferOutput<typeof SlackArtifactReceiptSchema>;
export type CompletedSlackArtifactReceipt = Extract<SlackArtifactReceipt, { schemaVersion: 2 }>;

export function isCompletedSlackArtifactReceipt(receipt: SlackArtifactReceipt): receipt is CompletedSlackArtifactReceipt {
  return receipt.schemaVersion === 2;
}

/** The one data part value: the full list staged so far, rewritten on every stage. */
export const SlackArtifactReceiptsSchema = v.strictObject({
  schemaVersion: v.literal(1),
  receipts: v.pipe(v.array(SlackArtifactReceiptSchema), v.maxLength(MAX_SLACK_ARTIFACT_RECEIPTS)),
});

export type SlackArtifactReceipts = v.InferOutput<typeof SlackArtifactReceiptsSchema>;

/** Root-Agent hook: one bounded durable receipt list per true response. */
export function useSlackArtifactReceipts() {
  const writeReceipts = useDataWriter(SLACK_ARTIFACT_RECEIPTS_DATA_NAME, { schema: SlackArtifactReceiptsSchema });
  const [, update] = usePersistentState<SlackArtifactReceipts>(
    SLACK_ARTIFACT_RECEIPTS_DATA_NAME, { schemaVersion: 1, receipts: [] },
  );
  useResponseStart(() => { update({ schemaVersion: 1, receipts: [] }); });
  return { accumulator: createArtifactReceiptAccumulator(update), writeReceipts };
}

export interface SlackArtifactDeliveryTarget {
  workspaceId?: string | undefined;
  agentId: string;
  channelId: string;
  threadTs?: string | undefined;
}

/**
 * Parse the receipts data part from a settled reply or a stored checkpoint.
 * Flue replaces a named data part in place, so the reply carries the latest
 * full list; a stored checkpoint carries the parsed list directly. Malformed
 * host data fails closed like the other host-authored parts.
 */
export function parseSlackArtifactReceipts(value: unknown): SlackArtifactReceipt[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Slack artifact receipts must be a list.');
  const latest = value.at(-1);
  if (latest === undefined) return [];
  const list = Array.isArray(latest) ? { schemaVersion: 1, receipts: latest } : latest;
  const parsed = v.safeParse(SlackArtifactReceiptsSchema, list);
  if (!parsed.success) throw new Error('Slack artifact receipts are invalid.');
  const seen = new Set<string>();
  return parsed.output.receipts.filter((receipt) => {
    if (seen.has(receipt.fileId)) return false;
    seen.add(receipt.fileId);
    return true;
  });
}

/** Only receipts frozen for exactly this destination may be published there. */
export function selectDeliverableArtifacts(
  receipts: readonly SlackArtifactReceipt[] | undefined,
  target: SlackArtifactDeliveryTarget,
): SlackArtifactReceipt[] {
  if (!receipts?.length) return [];
  return receipts.filter((receipt) =>
    receipt.destination.agentId === target.agentId &&
    receipt.destination.channelId === target.channelId &&
    (receipt.destination.threadTs ?? '') === (target.threadTs ?? '') &&
    receipt.destination.workspaceId === target.workspaceId);
}

/**
 * Compose against Flue's current durable state buffer, rather than a render
 * snapshot or process cache. Functional updates preserve concurrent tool
 * writes and files staged before an isolate restart.
 */
export function createArtifactReceiptAccumulator(
  update: (updater: (previous: SlackArtifactReceipts) => SlackArtifactReceipts) => void,
): {
  add(receipt: SlackArtifactReceipt): SlackArtifactReceipt[];
} {
  return {
    add(receipt) {
      let receipts: SlackArtifactReceipt[] = [];
      update((previous) => {
        const state = v.parse(SlackArtifactReceiptsSchema, previous);
        receipts = [...state.receipts.filter((known) => known.fileId !== receipt.fileId), receipt];
        return v.parse(SlackArtifactReceiptsSchema, { schemaVersion: 1, receipts });
      });
      return receipts;
    },
  };
}
