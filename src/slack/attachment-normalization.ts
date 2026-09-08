import { getResolvedPDFJS } from 'unpdf';

import type {
  GatewayAttachmentClient,
  GatewayAttachmentRead,
} from './gateway/client.ts';
import {
  GATEWAY_ATTACHMENT_REPRESENTATIONS,
  type GatewayAttachmentRepresentation,
} from './gateway/protocol.ts';

export const MAX_SLACK_ATTACHMENTS = 4;
export const MAX_SLACK_ATTACHMENT_BYTES = 8 * 1_024 * 1_024;
export const MAX_SLACK_ATTACHMENT_TOTAL_BYTES = 12 * 1_024 * 1_024;
export const MAX_SLACK_PDF_PAGES = 100;
export const MAX_SLACK_ATTACHMENT_CHARACTERS = 32_000;
export const MAX_SLACK_ATTACHMENT_TOTAL_CHARACTERS = 48_000;
const MAX_SLACK_PDF_IMAGE_PIXELS = 16_777_216;
const DEFAULT_NORMALIZATION_DEADLINE_PER_ATTACHMENT_MS = 13_000;
const APPROVED_TEXT_APPLICATION_MIME_TYPES = new Set([
  'application/graphql',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/sql',
  'application/toml',
  'application/typescript',
  'application/x-httpd-php',
  'application/x-javascript',
  'application/x-ndjson',
  'application/x-sh',
  'application/x-yaml',
  'application/xml',
  'application/yaml',
]);
const APPROVED_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export type SlackAttachmentNextAction =
  | 'retry'
  | 'reupload_file'
  | 'reconnect_slack'
  | 'update_gateway'
  | 'convert_file'
  | 'reduce_file_size'
  | 'split_file'
  | 'use_text_pdf'
  | 'use_image_model'
  | 'remove_unsupported_file';

interface NormalizedAttachmentIdentity {
  ordinal: number;
  fileId: string;
  filename: string;
  label: string;
  representation: GatewayAttachmentRepresentation;
  contentType: string;
}

interface NormalizedSlackTextAttachment extends NormalizedAttachmentIdentity {
  kind: 'text';
  text: string;
}

interface NormalizedSlackImageAttachment extends NormalizedAttachmentIdentity {
  kind: 'image';
  image: { type: 'image'; data: string; mimeType: string };
}

export interface NormalizedSlackPdfAttachment extends NormalizedAttachmentIdentity {
  kind: 'pdf';
  text: string;
  pdfCompleteness: 'baseline_complete' | 'native_required';
  bytes: Uint8Array;
}

export type NormalizedSlackAttachment =
  | NormalizedSlackTextAttachment
  | NormalizedSlackImageAttachment
  | NormalizedSlackPdfAttachment;

export interface SlackAttachmentFailure {
  ordinal: number;
  fileId: string;
  filename?: string;
  label: string;
  code: string;
  nextAction: SlackAttachmentNextAction;
}

export interface SlackAttachmentNormalizationResult {
  attachments: NormalizedSlackAttachment[];
  failures: SlackAttachmentFailure[];
  totalBytes: number;
  totalCharacters: number;
}

export interface SlackAttachmentNormalizationInput {
  fileIds: readonly string[];
  gateway: GatewayAttachmentClient;
  signal?: AbortSignal;
  deadlineAt?: number;
  now?: () => number;
}

/** Retrieve and normalize attachments in ordinal order without durable storage. */
export async function normalizeSlackAttachments(
  input: SlackAttachmentNormalizationInput,
): Promise<SlackAttachmentNormalizationResult> {
  const now = input.now ?? Date.now;
  const deadlineAt = input.deadlineAt ?? now() +
    DEFAULT_NORMALIZATION_DEADLINE_PER_ATTACHMENT_MS * Math.max(1, input.fileIds.length);
  const attachments: NormalizedSlackAttachment[] = [];
  const failures: SlackAttachmentFailure[] = [];
  let totalBytes = 0;
  let totalCharacters = 0;

  if (input.fileIds.length > MAX_SLACK_ATTACHMENTS) {
    return {
      attachments,
      failures: input.fileIds.map((fileId, index) => failure(
        index + 1,
        fileId,
        'attachment_count_limit_exceeded',
        'remove_unsupported_file',
      )),
      totalBytes,
      totalCharacters,
    };
  }

  for (let index = 0; index < input.fileIds.length; index += 1) {
    const ordinal = index + 1;
    const fileId = input.fileIds[index]!;
    if (deadlineExceeded(input.signal, deadlineAt, now)) {
      failures.push(failure(ordinal, fileId, 'attachment_deadline_exceeded', 'retry'));
      continue;
    }
    const remainingBytes = MAX_SLACK_ATTACHMENT_TOTAL_BYTES - totalBytes;
    if (remainingBytes <= 0) {
      failures.push(failure(
        ordinal,
        fileId,
        'attachment_aggregate_byte_limit_exceeded',
        'reduce_file_size',
      ));
      continue;
    }

    let read: GatewayAttachmentRead;
    const readSignal = signalForAttachmentDeadline(input.signal, deadlineAt, now);
    try {
      read = await input.gateway.readAttachment(
        fileId,
        Math.min(MAX_SLACK_ATTACHMENT_BYTES, remainingBytes),
        readSignal,
      );
      validateReadEnvelope(read, fileId, Math.min(MAX_SLACK_ATTACHMENT_BYTES, remainingBytes));
    } catch (error) {
      const deadlineFailure = deadlineExceeded(readSignal, deadlineAt, now);
      failures.push(failure(
        ordinal,
        fileId,
        deadlineFailure
          ? 'attachment_deadline_exceeded'
          : safeFailureCode(error) ?? 'attachment_retrieval_failed',
        deadlineFailure ? 'retry' : retrievalNextAction(error),
      ));
      continue;
    }

    totalBytes += read.bytes.byteLength;
    if (deadlineExceeded(readSignal, deadlineAt, now)) {
      failures.push(failure(
        ordinal,
        fileId,
        'attachment_deadline_exceeded',
        'retry',
        read.filename,
      ));
      continue;
    }
    try {
      const normalized = await normalizeReadAttachment({
        read,
        ordinal,
        ...(input.signal ? { signal: input.signal } : {}),
        deadlineAt,
        now,
      });
      const normalizedCharacters = attachmentCharacterCount(normalized);
      if (normalizedCharacters > MAX_SLACK_ATTACHMENT_CHARACTERS) {
        throw new AttachmentNormalizationError(
          'attachment_character_limit_exceeded',
          'split_file',
        );
      }
      if (totalCharacters + normalizedCharacters > MAX_SLACK_ATTACHMENT_TOTAL_CHARACTERS) {
        throw new AttachmentNormalizationError(
          'attachment_aggregate_character_limit_exceeded',
          'split_file',
        );
      }
      attachments.push(normalized);
      totalCharacters += normalizedCharacters;
    } catch (error) {
      const normalizedError = error instanceof AttachmentNormalizationError
        ? error
        : new AttachmentNormalizationError('attachment_parse_failed', 'convert_file');
      failures.push(failure(
        ordinal,
        fileId,
        normalizedError.code,
        normalizedError.nextAction,
        read.filename,
      ));
    }
  }

  return { attachments, failures, totalBytes, totalCharacters };
}

async function normalizeReadAttachment(input: {
  read: GatewayAttachmentRead;
  ordinal: number;
  signal?: AbortSignal;
  deadlineAt: number;
  now: () => number;
}): Promise<NormalizedSlackAttachment> {
  const filename = safeAttachmentFilename(input.read.filename);
  const identity = {
    ordinal: input.ordinal,
    fileId: input.read.fileId,
    filename,
    label: attachmentLabel(input.ordinal, filename),
    representation: input.read.representation,
    contentType: input.read.contentType,
  };
  if (input.read.representation === 'pdf_original' ||
      input.read.representation === 'slack_pdf_conversion') {
    validatePdf(input.read);
    const extracted = await extractPdfTextSequentially({
      bytes: input.read.bytes,
      ...(input.signal ? { signal: input.signal } : {}),
      deadlineAt: input.deadlineAt,
      now: input.now,
    });
    return {
      kind: 'pdf',
      ...identity,
      text: extracted.text,
      pdfCompleteness: extracted.everyPageHasText ? 'baseline_complete' : 'native_required',
      bytes: input.read.bytes,
    };
  }
  if (input.read.representation === 'text_original') {
    if (!approvedTextMimeType(input.read.contentType)) {
      throw new AttachmentNormalizationError(
        'attachment_mime_magic_mismatch',
        'convert_file',
      );
    }
    return {
      kind: 'text',
      ...identity,
      text: decodeStrictText(input.read.bytes),
    };
  }
  if (input.read.representation === 'image_original') {
    if (!APPROVED_IMAGE_MIME_TYPES.has(input.read.contentType) ||
        !imageMagicMatches(input.read.contentType, input.read.bytes)) {
      throw new AttachmentNormalizationError(
        'attachment_mime_magic_mismatch',
        'convert_file',
      );
    }
    return {
      kind: 'image',
      ...identity,
      image: {
        type: 'image',
        data: attachmentBytesToBase64(input.read.bytes),
        mimeType: input.read.contentType,
      },
    };
  }
  throw new AttachmentNormalizationError('unsupported_attachment_type', 'convert_file');
}

function approvedTextMimeType(contentType: string): boolean {
  return (contentType.startsWith('text/') && contentType !== 'text/rtf') ||
    APPROVED_TEXT_APPLICATION_MIME_TYPES.has(contentType);
}

async function extractPdfTextSequentially(input: {
  bytes: Uint8Array;
  signal?: AbortSignal;
  deadlineAt: number;
  now: () => number;
}): Promise<{ text: string; everyPageHasText: boolean }> {
  assertWithinDeadline(input.signal, input.deadlineAt, input.now);
  const { getDocument } = await awaitAttachmentPdfOperation(
    getResolvedPDFJS(),
    input,
  );
  const loadingTask = getDocument({
    data: input.bytes.slice(),
    maxImageSize: MAX_SLACK_PDF_IMAGE_PIXELS,
    stopAtErrors: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let document: Awaited<typeof loadingTask.promise> | undefined;
  try {
    const cancelLoading = () => {
      void loadingTask.destroy().catch(() => undefined);
    };
    document = await awaitAttachmentPdfOperation(
      loadingTask.promise,
      input,
      cancelLoading,
    );
    assertWithinDeadline(input.signal, input.deadlineAt, input.now);
    if (document.numPages < 1) {
      throw new AttachmentNormalizationError('pdf_has_no_pages', 'convert_file');
    }
    if (document.numPages > MAX_SLACK_PDF_PAGES) {
      throw new AttachmentNormalizationError('pdf_page_limit_exceeded', 'split_file');
    }
    const pages: string[] = [];
    let totalCharacters = 0;
    let everyPageHasText = true;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      assertWithinDeadline(input.signal, input.deadlineAt, input.now);
      const page = await awaitAttachmentPdfOperation(
        document.getPage(pageNumber),
        input,
        cancelLoading,
      );
      try {
        const content = await awaitAttachmentPdfOperation(
          page.getTextContent(),
          input,
          cancelLoading,
        );
        const text = content.items
          .filter((item): item is typeof item & { str: string; hasEOL?: boolean } =>
            'str' in item && typeof item.str === 'string')
          .map((item) => `${item.str}${item.hasEOL ? '\n' : ''}`)
          .join('')
          .replace(/[^\S\n]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (!text) everyPageHasText = false;
        const pageText = `--- Page ${pageNumber} of ${document.numPages} ---${text ? `\n${text}` : ''}`;
        const separatorCharacters = pages.length === 0 ? 0 : 1;
        const remainingCharacters = MAX_SLACK_ATTACHMENT_CHARACTERS -
          totalCharacters - separatorCharacters;
        const pageCharacters = characterCountUpTo(pageText, remainingCharacters);
        if (pageCharacters > remainingCharacters) {
          throw new AttachmentNormalizationError(
            'attachment_character_limit_exceeded',
            'split_file',
          );
        }
        pages.push(pageText);
        totalCharacters += separatorCharacters + pageCharacters;
      } finally {
        page.cleanup();
      }
    }
    assertWithinDeadline(input.signal, input.deadlineAt, input.now);
    return { text: pages.join('\n'), everyPageHasText };
  } catch (error) {
    if (error instanceof AttachmentNormalizationError) throw error;
    throw new AttachmentNormalizationError('pdf_parse_failed', 'convert_file');
  } finally {
    if (document) {
      await awaitAttachmentPdfOperation(
        document.cleanup(),
        input,
      ).catch(() => undefined);
    }
    await awaitAttachmentPdfOperation(
      loadingTask.destroy(),
      input,
    ).catch(() => undefined);
  }
}

/** Bound a PDF.js operation by the one turn deadline and cancel its loading task on expiry. */
export function awaitAttachmentPdfOperation<T>(
  operation: Promise<T>,
  input: { signal?: AbortSignal; deadlineAt: number; now: () => number },
  cancel: () => void = () => undefined,
): Promise<T> {
  const remaining = input.deadlineAt - input.now();
  if (input.signal?.aborted || remaining <= 0) {
    cancel();
    return Promise.reject(new AttachmentNormalizationError(
      'attachment_deadline_exceeded',
      'retry',
    ));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const failForDeadline = () => finish(() => {
      cancel();
      reject(new AttachmentNormalizationError('attachment_deadline_exceeded', 'retry'));
    });
    timer = setTimeout(failForDeadline, remaining);
    onAbort = failForDeadline;
    input.signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  }).finally(() => {
    if (timer) clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
  });
}

function decodeStrictText(bytes: Uint8Array): string {
  // A UTF-8 scalar consumes at most four bytes. Reject inputs that cannot
  // possibly fit before allocating the decoded string.
  if (bytes.byteLength > (MAX_SLACK_ATTACHMENT_CHARACTERS * 4) + 3) {
    throw new AttachmentNormalizationError(
      'attachment_character_limit_exceeded',
      'split_file',
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentNormalizationError('text_utf8_invalid', 'convert_file');
  }
  if (/\0|[\u0001-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(text)) {
    throw new AttachmentNormalizationError('text_binary_rejected', 'convert_file');
  }
  return text;
}

function imageMagicMatches(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'image/png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    case 'image/webp':
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.byteLength >= 12 && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]);
    default:
      return false;
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.byteLength >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte);
}

function attachmentBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function validateReadEnvelope(
  read: GatewayAttachmentRead,
  expectedFileId: string,
  maxBytes: number,
): void {
  if (read.fileId !== expectedFileId || !read.filename ||
      Array.from(read.filename).length > 256 || /[\p{Cc}\p{Cf}]/u.test(read.filename) ||
      !GATEWAY_ATTACHMENT_REPRESENTATIONS.includes(read.representation) ||
      typeof read.contentType !== 'string' || read.contentType.length > 128 ||
      !(read.bytes instanceof Uint8Array) || read.bytes.byteLength > maxBytes) {
    throw new AttachmentNormalizationError('invalid_attachment_response', 'retry');
  }
}

function validatePdf(read: GatewayAttachmentRead): void {
  if (read.contentType !== 'application/pdf' || !hasPdfMagic(read.bytes)) {
    throw new AttachmentNormalizationError('attachment_mime_magic_mismatch', 'convert_file');
  }
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 &&
    bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

function attachmentLabel(ordinal: number, filename: string): string {
  return `Attachment ${ordinal} - ${filename}`;
}

function safeAttachmentFilename(filename: string): string {
  return filename.replace(/={3,}/g, '[delimiter punctuation removed]');
}

function attachmentCharacterCount(attachment: NormalizedSlackAttachment): number {
  return attachment.kind === 'image'
    ? 0
    : characterCountUpTo(attachment.text, MAX_SLACK_ATTACHMENT_CHARACTERS);
}

function characterCountUpTo(value: string, maximum: number): number {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) break;
  }
  return count;
}

function assertWithinDeadline(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  now: () => number,
): void {
  if (signal?.aborted || now() >= deadlineAt) {
    throw new AttachmentNormalizationError('attachment_deadline_exceeded', 'retry');
  }
}

function deadlineExceeded(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  now: () => number,
): boolean {
  return signal?.aborted === true || now() >= deadlineAt;
}

function signalForAttachmentDeadline(
  signal: AbortSignal | undefined,
  deadlineAt: number,
  now: () => number,
): AbortSignal {
  const remaining = deadlineAt - now();
  if (remaining <= 0) return AbortSignal.abort();
  const timeout = AbortSignal.timeout(Math.max(1, remaining));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function failure(
  ordinal: number,
  fileId: string,
  code: string,
  nextAction: SlackAttachmentNextAction,
  filename?: string,
): SlackAttachmentFailure {
  return {
    ordinal,
    fileId,
    ...(filename ? { filename } : {}),
    label: attachmentLabel(ordinal, filename ?? fileId),
    code,
    nextAction,
  };
}

function safeFailureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? code : undefined;
}

function retrievalNextAction(error: unknown): SlackAttachmentNextAction {
  const code = safeFailureCode(error);
  if (code === 'gateway_attachment_unsupported') return 'update_gateway';
  if (code === 'missing_scope' || code === 'binding_reconnect_required' ||
      code === 'gateway_not_connected') return 'reconnect_slack';
  if (code?.includes('byte') || code?.includes('large')) return 'reduce_file_size';
  if (code === 'unsupported_file_type' || code === 'invalid_slack_file_type' ||
      code === 'invalid_slack_file_magic' || code === 'invalid_slack_content_length' ||
      code === 'invalid_attachment_response') return 'convert_file';
  if (code === 'file_not_found' || code === 'file_deleted' ||
      code === 'slack_file_unavailable' || code === 'access_denied' ||
      safeRetryable(error) === false) return 'reupload_file';
  return 'retry';
}

function safeRetryable(error: unknown): boolean | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const retryable = (error as { retryable?: unknown }).retryable;
  return typeof retryable === 'boolean' ? retryable : undefined;
}

class AttachmentNormalizationError extends Error {
  constructor(
    readonly code: string,
    readonly nextAction: SlackAttachmentNextAction,
  ) {
    super(code);
    this.name = 'AttachmentNormalizationError';
  }
}
