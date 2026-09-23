import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import type { ConnectionScopedFetch } from '../config/egress.ts';
import { assertConnectionWriteAllowed } from '../memory/tool-policy.ts';
import { artifactFilename } from '../sandbox/artifact-tool.ts';
import { MAX_SLACK_UPLOAD_BYTES } from '../slack/file-transport.ts';
import {
  UPLOAD_FILE_HANDLE,
  type UploadFileResolution,
} from './file-handles.ts';
import {
  buildMultipartBody,
  buildRawBody,
  FORM_FIELD_NAME,
  prepareRequestBody,
} from './file-upload-body.ts';
import {
  connectionFetchFailureReason,
  connectionRefusal,
  readConnectionResponse,
} from './response.ts';

export const ATTACH_FILE_TO_CONNECTION_TOOL_NAME = 'attach_file_to_connection';

/** Long enough for a large recording on a slow upstream; the Slack path has no tighter bound. */
export const CONNECTION_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Mirrors `RECORDING_TIMEOUT_MS` in browser/tools.ts; importing it would close
 * an import cycle through the activity status map.
 */
const RECORDING_REOPEN_MS = 90_000;
/**
 * The whole call's bound: re-opening a recording (up to the browser tool's
 * 90 s wait), the request itself, and a margin. On expiry Flue settles the call
 * with a ToolTimeoutError and the conversation continues.
 */
export const CONNECTION_UPLOAD_TOOL_TIMEOUT_MS = CONNECTION_UPLOAD_TIMEOUT_MS + RECORDING_REOPEN_MS + 60_000;
/** The largest file sent: the same ceiling as a Slack upload. */
export const MAX_CONNECTION_UPLOAD_BYTES = MAX_SLACK_UPLOAD_BYTES;
/** How much of the service's response the model reads back. */
export const MAX_UPLOAD_RESPONSE_CHARS = 8_000;
const MAX_FORM_FIELDS = 20;
const WRITE_METHODS = ['POST', 'PUT', 'PATCH'] as const;

/** Write methods only: reading a file back is what `curl` is for. */
export function allowsConnectionFileUpload(methods: readonly string[]): boolean {
  return methods.some((method) => (WRITE_METHODS as readonly string[]).includes(method.toUpperCase()));
}

/**
 * The tool mounts only for a plan with a writable API connection and an actor
 * whose connection credentials can be resolved.
 */
export function planAllowsConnectionFileUpload(plan: {
  actorMembershipId?: string | undefined;
  apiConnections: ReadonlyArray<{ allowedMethods: readonly string[] }>;
}): boolean {
  return Boolean(plan.actorMembershipId) &&
    plan.apiConnections.some((connection) => allowsConnectionFileUpload(connection.allowedMethods));
}

export interface ConnectionUploadFetch {
  fetch: ConnectionScopedFetch;
  /** The credential values in play, removed from anything the model reads. */
  secrets: readonly string[];
}

export interface AttachFileToConnectionOptions {
  /** This turn's connection-scoped fetch; undefined when no connection resolved. */
  resolveFetch(): Promise<ConnectionUploadFetch | undefined>;
  resolveFile(handle: string): Promise<UploadFileResolution>;
  /** `stream` on Workers; `file` on Node, whose fetch cannot take a stream here. */
  streamMode: 'stream' | 'file';
}

const DESCRIPTION = [
  "Send a file you produced or can see in this conversation to one of this Agent's API connections as real bytes, for example to attach a screenshot, screen recording, or generated image to an Asana task.",
  'Use this instead of curl for any file: the shell cannot send binary files intact.',
  '`file` is a handle: a `savedImage` from generate_image, a `fileHandle` from browser_screenshot or browser_recording, or an `img:N` conversation image. Handles work in this conversation only and expire after 24 hours.',
  "`url` is the service's HTTPS upload endpoint. It must be a host, path, and method the connection allows; Chickpea adds the connection's credential, so never add an authorization header.",
  'By default the file is sent as multipart/form-data under `fieldName` (default `file`), with `fields` as extra form fields (for Asana: fields {"parent": "<task gid>"} to https://app.asana.com/api/1.0/attachments). Set encoding to raw to send the file itself as the request body, for APIs that take raw media.',
  'Returns the HTTP status and the service response, which usually holds a link to the uploaded file. A result with ok: false did not upload the file: say so rather than claiming it is attached.',
].join(' ');

const INPUT = v.object({
  file: v.pipe(v.string(), v.regex(UPLOAD_FILE_HANDLE, 'file must be a savedImage, fileHandle, or img:N handle')),
  url: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  method: v.optional(v.picklist(WRITE_METHODS)),
  encoding: v.optional(v.picklist(['multipart', 'raw'])),
  fieldName: v.optional(v.pipe(v.string(), v.regex(FORM_FIELD_NAME))),
  fields: v.optional(v.pipe(
    v.record(v.pipe(v.string(), v.regex(FORM_FIELD_NAME)), v.pipe(v.string(), v.maxLength(4_096))),
    v.check((fields) => Object.keys(fields).length <= MAX_FORM_FIELDS, `at most ${MAX_FORM_FIELDS} fields`),
  )),
  filename: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
});

type RefusalReason =
  | 'no_connection'
  | 'url_not_allowed'
  | 'method_not_allowed'
  | 'file_unavailable'
  | 'too_large'
  | 'failed';

function refused(reason: RefusalReason, message: string, extra: Record<string, JsonValue> = {}) {
  return connectionRefusal(reason, message, extra);
}

/** The extension a sanitized filename keeps: the source file's, or `bin`. */
function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return match ? match[1]!.toLowerCase() : 'bin';
}

export function createAttachFileToConnectionTool(options: AttachFileToConnectionOptions) {
  return defineTool({
    name: ATTACH_FILE_TO_CONNECTION_TOOL_NAME,
    description: DESCRIPTION,
    input: INPUT,
    timeoutMs: CONNECTION_UPLOAD_TOOL_TIMEOUT_MS,
    async run({ data }) {
      assertConnectionWriteAllowed('upload');
      let url: URL;
      try {
        url = new URL(data.url);
      } catch {
        return refused('url_not_allowed', 'url must be an absolute https URL.');
      }
      if (url.protocol !== 'https:' || url.username || url.password) {
        return refused('url_not_allowed', 'url must be an https URL without credentials.');
      }
      const connection = await options.resolveFetch();
      if (!connection) {
        return refused('no_connection', 'No API connection that allows uploads is available to this Agent right now.');
      }
      const resolved = await options.resolveFile(data.file);
      if (!resolved.ok) {
        return refused('file_unavailable', 'That file handle is not available in this conversation.', { detail: resolved.detail });
      }
      const source = resolved.file;
      if (source.content.byteLength > MAX_CONNECTION_UPLOAD_BYTES) {
        return refused('too_large', 'The file is larger than Chickpea sends to a connection.', {
          byteLength: source.content.byteLength, maxBytes: MAX_CONNECTION_UPLOAD_BYTES,
        });
      }
      const extension = extensionOf(source.filename);
      const filename = artifactFilename(data.filename ?? source.filename, `file.${extension}`, extension);
      const file = { filename, contentType: source.contentType, content: source.content };
      const built = data.encoding === 'raw'
        ? buildRawBody(file)
        : buildMultipartBody({
            fields: Object.entries(data.fields ?? {}),
            fileField: data.fieldName ?? 'file',
            file,
          });
      const prepared = await prepareRequestBody(built.body, built.byteLength, options.streamMode);
      const method = data.method ?? 'POST';
      let result: Awaited<ReturnType<ConnectionScopedFetch>>;
      try {
        result = await connection.fetch(url.href, {
          method,
          headers: {
            'content-type': built.contentType,
            ...(prepared.contentLength === undefined ? {} : { 'content-length': String(prepared.contentLength) }),
          },
          body: prepared.body,
          // A streamed body cannot be replayed, and an upload has no business
          // moving: a redirect is reported, never followed.
          followRedirects: false,
        });
      } catch (error) {
        return failure(error, method);
      } finally {
        await prepared.cleanup().catch(() => undefined);
      }
      const ok = result.status >= 200 && result.status < 300;
      const response = readConnectionResponse(result.body, result.headers['content-type'], connection.secrets, {
        maxChars: MAX_UPLOAD_RESPONSE_CHARS,
      });
      return {
        output: {
          ok,
          sent: true,
          status: result.status,
          filename,
          byteLength: source.content.byteLength,
          ...(result.status >= 300 && result.status < 400
            ? { note: 'The service redirected the upload; Chickpea does not follow redirects for uploads, so the file was not stored.' }
            : {}),
          ...response,
        } as JsonValue,
      };
    },
  });
}

/** Static categories only: an upstream error message can echo the URL or headers. */
function failure(error: unknown, method: string) {
  const reason = connectionFetchFailureReason(error);
  if (reason === 'method_not_allowed') {
    return refused('method_not_allowed', `The connection does not allow ${method} requests to that URL.`);
  }
  if (reason === 'url_not_allowed') {
    return refused('url_not_allowed', "That URL is not an endpoint this Agent's connections allow.");
  }
  if (error instanceof Error && error.message === 'upload_source_length_mismatch') {
    return refused('failed', 'The file changed size while it was being sent, so the upload was stopped.');
  }
  return refused('failed', 'The upload did not complete (network error or timeout). It may be retried once.');
}
