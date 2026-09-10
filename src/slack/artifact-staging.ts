import type { SlackArtifactStageInput, SlackArtifactStageOutcome } from '../sandbox/artifact-tool.ts';
import * as v from 'valibot';
import {
  createArtifactReceiptAccumulator,
  isCompletedSlackArtifactReceipt,
  SlackArtifactReceiptSchema,
  type CompletedSlackArtifactReceipt,
  type SlackArtifactReceipt,
  type SlackArtifactReceipts,
} from './artifact-receipts.ts';
import type { SlackFileTransport } from './file-transport.ts';
import { MAX_GATEWAY_ARTIFACT_BYTES } from './gateway/protocol.ts';
import { SlackTransportError } from './transport/types.ts';
import { isMissingFilesScopeError } from './web-client-presenter.ts';

const FILENAME_LIMIT = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Stage one model-chosen file for the frozen destination and record the
 * host-owned receipt. The model receives only a bounded outcome; the file id
 * and destination live in the receipt data part that final delivery reads.
 */
export async function stageArtifactWithReceipt(input: {
  transport: SlackFileTransport;
  artifact: SlackArtifactStageInput;
  destination: SlackArtifactReceipt['destination'];
  accumulator: ReturnType<typeof createArtifactReceiptAccumulator>;
  writeReceipts: (receipts: SlackArtifactReceipts) => void;
  now?: () => number;
}): Promise<SlackArtifactStageOutcome> {
  const filename = input.artifact.filename.trim();
  if (!filename || filename.length > FILENAME_LIMIT || CONTROL_CHARACTERS.test(filename)) {
    throw new Error(`filename must be 1-${FILENAME_LIMIT} characters without control characters`);
  }
  const title = input.artifact.title?.trim();
  if (title !== undefined && (title.length > FILENAME_LIMIT || CONTROL_CHARACTERS.test(title))) {
    throw new Error(`title must be at most ${FILENAME_LIMIT} characters without control characters`);
  }
  if (!input.transport.stagePrivate) return { attached: false, reason: 'unavailable' };
  const now = input.now ?? Date.now;
  const stagedAt = now();
  let receipt: CompletedSlackArtifactReceipt;
  try {
    const staged = await input.transport.stagePrivate({
      filename,
      bytes: input.artifact.bytes,
      ...(title ? { title } : {}),
      ...(input.artifact.kind === 'chart' && title ? { altText: title } : {}),
    });
    if (staged.byteLength !== input.artifact.bytes.byteLength) return { attached: false, reason: 'unavailable' };
    const parsed = v.parse(SlackArtifactReceiptSchema, {
      schemaVersion: 2,
      fileId: staged.fileId,
      permalink: staged.permalink,
      filename,
      ...(title ? { title } : {}),
      kind: input.artifact.kind,
      byteLength: staged.byteLength,
      stagedAt,
      completedAt: now(),
      destination: { ...input.destination },
    });
    if (!isCompletedSlackArtifactReceipt(parsed)) return { attached: false, reason: 'unavailable' };
    receipt = parsed;
  } catch (error) {
    if (error instanceof SlackTransportError && error.code === 'gateway_request_too_large') {
      return { attached: false, reason: 'too-large', maxBytes: MAX_GATEWAY_ARTIFACT_BYTES };
    }
    if (isMissingFilesScopeError(error)) return { attached: false, reason: 'missing-scope' };
    return { attached: false, reason: 'unavailable' };
  }
  const receipts = input.accumulator.add(receipt);
  input.writeReceipts({ schemaVersion: 1, receipts });
  return { attached: true, byteLength: receipt.byteLength };
}
