import type { WebClient } from '@slack/web-api';

import { MAX_ARTIFACT_BYTES } from '../sandbox/artifact-tool.ts';
import { isRecord } from '../security/content-validation.ts';
import { MAX_GATEWAY_ARTIFACT_BYTES } from './gateway/protocol.ts';
import { isGatewaySlackWebClient } from './gateway/web-client.ts';
import { SlackTransportError } from './transport/types.ts';
import { slackPlatformErrorCode } from './errors.ts';
import { isSlackFilePermalink } from './artifact-receipts.ts';
import { SLACK_FILE_ID, SLACK_TS } from './ids.ts';

/**
 * Private staging uploads and completes a file without a destination. Final
 * delivery shares its returned permalink in an ordinary Agent message.
 * The legacy stage/complete pair remains available for persisted replay.
 */

export interface SlackFileStageInput {
  filename: string;
  bytes: Uint8Array;
  title?: string;
  altText?: string;
  snippetType?: string;
}

export interface SlackFileStageResult {
  fileId: string;
  byteLength: number;
}

export interface SlackFilePrivateStageResult extends SlackFileStageResult {
  permalink: string;
}

export interface SlackFileCompletionInput {
  files: ReadonlyArray<{ id: string; title?: string }>;
  channelId: string;
  threadTs?: string;
  /** Rendered message blocks; ignored by Slack when `initialComment` is set. */
  blocks?: readonly unknown[];
  initialComment?: string;
  persona?: { username?: string; icon_url?: string };
}

export type SlackFileShare =
  | { shared: true; channelId: string; ts: string }
  | { shared: false };

export interface SlackFileCompletionResult {
  /** The share coordinate when the completion response already proved it. */
  share?: SlackFileShare;
}

export interface SlackFileTransport {
  /**
   * The largest file this installation can upload: the direct artifact cap,
   * or the shared gateway's much smaller request cap. Set at construction
   * because nothing else distinguishes the two transports before an upload
   * fails, and the image tool must choose its output format before the call.
   */
  maxBytes: number;
  /** Completes privately once. A missing method marks a legacy transport. */
  stagePrivate?(input: SlackFileStageInput): Promise<SlackFilePrivateStageResult>;
  /** Safe to retry: an uncompleted upload is discarded by Slack. */
  stage(input: SlackFileStageInput): Promise<SlackFileStageResult>;
  /** The publishing commit point. Never retried by callers after ambiguity. */
  complete(input: SlackFileCompletionInput): Promise<SlackFileCompletionResult>;
  /** Read-only: which message, if any, shares this file at the destination. */
  resolveShare(input: { fileId: string; channelId: string; threadTs?: string }): Promise<SlackFileShare>;
}

export interface SlackPrivateFileTransport extends SlackFileTransport {
  stagePrivate(input: SlackFileStageInput): Promise<SlackFilePrivateStageResult>;
}

export const SLACK_FILE_STAGE_OPERATION = 'chickpea.files.stage' as const;
export const SLACK_FILE_GET_SHARE_OPERATION = 'chickpea.files.getShare' as const;
export const SLACK_FILE_COMPLETE_OPERATION = 'files.completeUploadExternal' as const;

const UNSUPPORTED_TRANSPORT_CODES = new Set([
  'operation_not_allowed',
  'unknown_operation',
  'unsupported_operation',
  'invalid_operation',
  'gateway_http_404',
]);

/** An older shared gateway that does not know the staged file operations. */
export function isSlackFileTransportUnsupported(error: unknown): boolean {
  if (error instanceof SlackTransportError) return UNSUPPORTED_TRANSPORT_CODES.has(error.code);
  return error instanceof Error && /unavailable through the Chickpea gateway/.test(error.message);
}

export function createSlackFileTransport(
  client: WebClient,
  options: { fetch?: typeof fetch } = {},
): SlackPrivateFileTransport {
  return isGatewaySlackWebClient(client)
    ? createGatewayFileTransport(client)
    : createDirectFileTransport(client, options.fetch ?? globalThis.fetch.bind(globalThis));
}

function createGatewayFileTransport(client: WebClient): SlackPrivateFileTransport {
  return {
    maxBytes: MAX_GATEWAY_ARTIFACT_BYTES,
    async stagePrivate(input) {
      const result = await client.files.uploadV2({
        filename: input.filename,
        file: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
        ...(input.title ? { title: input.title } : {}),
      });
      return privateStageResult(result, input.bytes.byteLength, 'files.uploadV2');
    },
    async stage(input) {
      const result = await client.apiCall(SLACK_FILE_STAGE_OPERATION, {
        filename: input.filename,
        file: input.bytes,
        ...(input.altText ? { alt_text: input.altText } : {}),
        ...(input.snippetType ? { snippet_type: input.snippetType } : {}),
      });
      return stageResult(result, input.bytes.byteLength, SLACK_FILE_STAGE_OPERATION);
    },
    async complete(input) {
      return completeFiles(client, input);
    },
    async resolveShare(input) {
      const result = await client.apiCall(SLACK_FILE_GET_SHARE_OPERATION, {
        file: input.fileId,
        channel: input.channelId,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      });
      if (!isRecord(result) || result.ok !== true || typeof result.shared !== 'boolean') {
        throw new SlackTransportError(SLACK_FILE_GET_SHARE_OPERATION, 'invalid_share_response');
      }
      if (!result.shared) return { shared: false };
      if (result.channel !== input.channelId || typeof result.ts !== 'string' || !SLACK_TS.test(result.ts)) {
        throw new SlackTransportError(SLACK_FILE_GET_SHARE_OPERATION, 'invalid_share_response');
      }
      return { shared: true, channelId: input.channelId, ts: result.ts };
    },
  };
}

function createDirectFileTransport(client: WebClient, fetcher: typeof fetch): SlackPrivateFileTransport {
  const transport: SlackPrivateFileTransport = {
    maxBytes: MAX_ARTIFACT_BYTES,
    async stagePrivate(input) {
      const staged = await transport.stage(input);
      const result = await client.files.completeUploadExternal({
        files: [{ id: staged.fileId, ...(input.title ? { title: input.title } : {}) }],
      });
      return privateStageResult(result, staged.byteLength, SLACK_FILE_COMPLETE_OPERATION, staged.fileId);
    },
    async stage(input) {
      const ticket = await client.files.getUploadURLExternal({
        filename: input.filename,
        length: input.bytes.byteLength,
        ...(input.altText ? { alt_text: input.altText } : {}),
        ...(input.snippetType ? { snippet_type: input.snippetType } : {}),
      });
      const fileId = typeof ticket.file_id === 'string' && SLACK_FILE_ID.test(ticket.file_id)
        ? ticket.file_id
        : undefined;
      const uploadUrl = uploadUrlFrom(ticket.upload_url);
      if (!fileId || !uploadUrl) {
        throw new SlackTransportError('files.getUploadURLExternal', 'invalid_upload_ticket');
      }
      let response: Response;
      try {
        response = await fetcher(uploadUrl, {
          method: 'POST',
          body: input.bytes as BodyInit,
          redirect: 'manual',
        });
      } catch {
        throw new SlackTransportError('files.upload', 'upload_unreachable', { retryable: true });
      }
      await response.body?.cancel().catch(() => undefined);
      if (response.status !== 200) {
        throw new SlackTransportError('files.upload', `upload_http_${response.status}`);
      }
      return { fileId, byteLength: input.bytes.byteLength };
    },
    async complete(input) {
      return completeFiles(client, input);
    },
    async resolveShare(input) {
      const info = await client.files.info({ file: input.fileId });
      if (!info.ok || !isRecord(info.file) || info.file.id !== input.fileId) {
        throw new SlackTransportError('files.info', 'invalid_file_metadata');
      }
      return shareFromFileRecord(info.file, input.channelId, input.threadTs);
    },
  };
  return transport;
}

function privateStageResult(
  result: unknown,
  byteLength: number,
  operation: string,
  expectedFileId?: string,
): SlackFilePrivateStageResult {
  const file = isRecord(result) && result.ok === true && Array.isArray(result.files) && result.files.length === 1
    ? result.files[0] : undefined;
  if (!isRecord(file) || typeof file.id !== 'string' || !SLACK_FILE_ID.test(file.id) ||
      (expectedFileId !== undefined && file.id !== expectedFileId) ||
      !isSlackFilePermalink(file.permalink, file.id) ||
      (file.size !== undefined && file.size !== byteLength)) {
    throw new SlackTransportError(operation, 'invalid_private_completion_receipt', {
      retryable: false, effectOutcome: 'unknown',
    });
  }
  return { fileId: file.id, permalink: file.permalink, byteLength };
}

// Slack explicitly warns that internal_error/fatal_error may have partly
// succeeded. Unknown codes (including already_complete) therefore cannot
// authorize a replacement message. This classification is identical for
// direct SDK errors and gateway errors.
const DEFINITIVE_COMPLETION_REJECTIONS = new Set([
  'account_inactive', 'not_authed', 'invalid_auth', 'token_revoked',
  'missing_scope', 'not_allowed_token_type', 'no_permission',
  'channel_not_found', 'not_in_channel', 'is_archived', 'restricted_action',
  'invalid_arguments', 'invalid_array_arg', 'invalid_blocks', 'invalid_blocks_format',
  'file_not_found', 'files_not_found', 'file_uploads_disabled',
  'file_uploads_except_images_disabled', 'method_not_supported_for_channel_type',
  'gateway_request_too_large', 'operation_not_allowed', 'unsupported_operation',
]);

export function slackFileCompletionFailureOutcome(error: unknown): 'failed' | 'unknown' {
  const code = error instanceof SlackTransportError ? error.code : slackPlatformErrorCode(error);
  return code && DEFINITIVE_COMPLETION_REJECTIONS.has(code) ? 'failed' : 'unknown';
}

async function completeFiles(client: WebClient, input: SlackFileCompletionInput): Promise<SlackFileCompletionResult> {
  try {
    const result = await client.files.completeUploadExternal(
      completionPayload(input) as unknown as Parameters<WebClient['files']['completeUploadExternal']>[0],
    );
    return shareFromCompletion(result, input);
  } catch (error) {
    const code = error instanceof SlackTransportError ? error.code : slackPlatformErrorCode(error);
    throw new SlackTransportError(SLACK_FILE_COMPLETE_OPERATION, code ?? 'slack_completion_outcome_unknown', {
      retryable: false,
      effectOutcome: slackFileCompletionFailureOutcome(error),
    });
  }
}

function completionPayload(input: SlackFileCompletionInput): Record<string, unknown> {
  return {
    files: input.files.map((file) => ({ id: file.id, ...(file.title ? { title: file.title } : {}) })),
    channel_id: input.channelId,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    ...(input.initialComment !== undefined
      ? { initial_comment: input.initialComment }
      : input.blocks ? { blocks: input.blocks } : {}),
    ...(input.persona ?? {}),
  };
}

function stageResult(result: unknown, byteLength: number, operation: string): SlackFileStageResult {
  if (!isRecord(result) || result.ok !== true ||
      typeof result.file_id !== 'string' || !SLACK_FILE_ID.test(result.file_id)) {
    throw new SlackTransportError(operation, 'invalid_stage_response');
  }
  const reported = result.byteLength;
  if (typeof reported === 'number' && reported !== byteLength) {
    throw new SlackTransportError(operation, 'stage_byte_length_mismatch');
  }
  return { fileId: result.file_id, byteLength };
}

function shareFromCompletion(
  result: unknown,
  input: SlackFileCompletionInput,
): SlackFileCompletionResult {
  if (!isRecord(result) || result.ok !== true) {
    throw new SlackTransportError(SLACK_FILE_COMPLETE_OPERATION, 'invalid_completion_response');
  }
  const files = Array.isArray(result.files) ? result.files : [];
  const expected = new Set(input.files.map((file) => file.id));
  if (files.length !== expected.size || expected.size !== input.files.length ||
      files.some((file) => !isRecord(file) || typeof file.id !== 'string' || !expected.delete(file.id)) ||
      expected.size > 0) {
    throw new SlackTransportError(SLACK_FILE_COMPLETE_OPERATION, 'invalid_completion_receipt');
  }
  try {
    const shares = files.map((file) => shareFromFileRecord(
      file as Record<string, unknown>, input.channelId, input.threadTs,
    ));
    const share = matchingFileShares(shares);
    return share.shared ? { share } : {};
  } catch {
    // A confusing completion body is not evidence either way; the caller can
    // still resolve the share with a dedicated read.
    return {};
  }
}

/** A batch is one reply only when every file resolves to that same message. */
function matchingFileShares(shares: readonly SlackFileShare[]): SlackFileShare {
  const first = shares[0];
  if (!first?.shared || shares.some((share) => !share.shared)) return { shared: false };
  if (shares.some((share) => share.shared &&
      (share.channelId !== first.channelId || share.ts !== first.ts))) {
    throw new SlackTransportError('files.info', 'inconsistent_file_shares');
  }
  return first;
}

export async function resolveFileShares(
  transport: SlackFileTransport,
  input: { fileIds: readonly string[]; channelId: string; threadTs?: string },
): Promise<SlackFileShare> {
  const shares: SlackFileShare[] = [];
  for (const fileId of input.fileIds) {
    shares.push(await transport.resolveShare({
      fileId, channelId: input.channelId,
      ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    }));
  }
  return matchingFileShares(shares);
}

/** Select the one message that shares this file at exactly this destination. */
export function shareFromFileRecord(
  file: Record<string, unknown>,
  channelId: string,
  threadTs: string | undefined,
): SlackFileShare {
  const shares = isRecord(file.shares) ? file.shares : {};
  const entries = [
    ...(isRecord(shares.public) && Array.isArray(shares.public[channelId]) ? shares.public[channelId] : []),
    ...(isRecord(shares.private) && Array.isArray(shares.private[channelId]) ? shares.private[channelId] : []),
  ] as unknown[];
  const matches = entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.ts !== 'string' || !SLACK_TS.test(entry.ts)) return [];
    const entryThread = typeof entry.thread_ts === 'string' && entry.thread_ts !== entry.ts
      ? entry.thread_ts
      : undefined;
    return (threadTs ?? undefined) === entryThread ? [entry.ts] : [];
  });
  const unique = [...new Set(matches)];
  if (unique.length > 1) {
    throw new SlackTransportError('files.info', 'ambiguous_share', { effectOutcome: 'unknown' });
  }
  return unique.length === 1 ? { shared: true, channelId, ts: unique[0]! } : { shared: false };
}

function uploadUrlFrom(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
