import { randomUUID } from 'node:crypto';

import type { ConnectionRequestBody } from '../config/egress.ts';
import { isStreamedFile, type SlackFileContent } from '../sandbox/artifact-tool.ts';

/**
 * Request bodies for sending one file to a connection. Everything here works
 * on bytes: the file is never decoded as text, which is what corrupts binary
 * uploads made through the virtual sandbox's emulated `curl`.
 */

export interface UploadBodyFile {
  filename: string;
  contentType: string;
  content: SlackFileContent;
}

export interface UploadRequestBody {
  contentType: string;
  byteLength: number;
  /** Bytes for an in-memory file; a stream that pulls the file as it is sent otherwise. */
  body: Uint8Array | ReadableStream<Uint8Array>;
}

const encoder = new TextEncoder();

/** Form field names Chickpea writes into a part header: plain tokens only. */
export const FORM_FIELD_NAME = /^[A-Za-z0-9_.\-[\]]{1,64}$/;

/**
 * A quoted-string for a Content-Disposition parameter. Names reaching here are
 * already validated, but a filename is model-chosen: control characters are
 * dropped and quote/backslash are escaped so it cannot end the header early.
 */
function quoted(value: string): string {
  return `"${value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** The ASCII-safe filename a part header carries; non-ASCII becomes `_`. */
function asciiFilename(filename: string): string {
  return filename.replace(/[^ -~]/g, '_');
}

/**
 * `multipart/form-data` with ordinary text fields first and the file last, as
 * Asana and most upload APIs expect. The body length is exact and known up
 * front, so a streamed file can be sent with Content-Length.
 */
export function buildMultipartBody(input: {
  fields: ReadonlyArray<readonly [string, string]>;
  fileField: string;
  file: UploadBodyFile;
  boundary?: string;
}): UploadRequestBody {
  const boundary = input.boundary ?? `chickpea-${randomUUID()}`;
  for (const [name] of input.fields) {
    if (!FORM_FIELD_NAME.test(name)) throw new Error('invalid_form_field_name');
  }
  if (!FORM_FIELD_NAME.test(input.fileField)) throw new Error('invalid_form_field_name');
  const contentType = input.file.contentType.replace(/[\r\n]/g, '');
  const head = encoder.encode([
    ...input.fields.map(([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(name)}\r\n\r\n${value}\r\n`),
    `--${boundary}\r\nContent-Disposition: form-data; name=${quoted(input.fileField)}; ` +
      `filename=${quoted(asciiFilename(input.file.filename))}\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  ].join(''));
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const fileLength = input.file.content.byteLength;
  const byteLength = head.byteLength + fileLength + tail.byteLength;
  const multipartType = `multipart/form-data; boundary=${boundary}`;
  if (!isStreamedFile(input.file.content)) {
    const body = new Uint8Array(byteLength);
    body.set(head, 0);
    body.set(input.file.content, head.byteLength);
    body.set(tail, head.byteLength + fileLength);
    return { contentType: multipartType, byteLength, body };
  }
  return {
    contentType: multipartType,
    byteLength,
    body: framedStream(head, input.file.content.stream, fileLength, tail),
  };
}

/** The file itself as the request body, for APIs that take raw media (for example Drive `uploadType=media`). */
export function buildRawBody(file: UploadBodyFile): UploadRequestBody {
  const contentType = file.contentType.replace(/[\r\n]/g, '');
  if (!isStreamedFile(file.content)) {
    return { contentType, byteLength: file.content.byteLength, body: file.content };
  }
  return {
    contentType,
    byteLength: file.content.byteLength,
    body: framedStream(new Uint8Array(0), file.content.stream, file.content.byteLength, new Uint8Array(0)),
  };
}

/**
 * Pull-based framing: the source is read one chunk per downstream pull, so a
 * file larger than memory flows through without being held. A source that
 * ends short of, or runs past, its declared length fails the body instead of
 * sending a request whose Content-Length is wrong.
 */
function framedStream(
  head: Uint8Array,
  source: ReadableStream<Uint8Array>,
  expected: number,
  tail: Uint8Array,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let phase: 'head' | 'file' | 'tail' | 'done' = head.byteLength > 0 ? 'head' : 'file';
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (phase === 'head') {
        phase = 'file';
        controller.enqueue(head);
        return;
      }
      if (phase === 'file') {
        reader ??= source.getReader();
        const { done, value } = await reader.read();
        if (!done) {
          seen += value.byteLength;
          if (seen > expected) {
            await reader.cancel().catch(() => undefined);
            controller.error(new Error('upload_source_length_mismatch'));
            return;
          }
          if (value.byteLength > 0) controller.enqueue(value);
          return;
        }
        if (seen !== expected) {
          controller.error(new Error('upload_source_length_mismatch'));
          return;
        }
        phase = tail.byteLength > 0 ? 'tail' : 'done';
      }
      if (phase === 'tail') {
        phase = 'done';
        controller.enqueue(tail);
        return;
      }
      controller.close();
    },
    async cancel(reason) {
      await (reader ?? source).cancel(reason).catch(() => undefined);
    },
  });
}

export interface PreparedRequestBody {
  body: ConnectionRequestBody;
  /** Set only when the platform cannot size the body itself. */
  contentLength?: number;
  cleanup(): Promise<void>;
}

/**
 * Turn a prepared body into something the platform fetch can send. Bytes go
 * as they are. A stream goes as a stream on Workers, with its exact length,
 * like the Slack upload path. Node's fetch refuses a stream body without a
 * `duplex` option that the connection's secure fetch does not forward, so on
 * Node the stream is spooled to a private temporary file and sent as a
 * file-backed Blob: still never held in memory.
 */
export async function prepareRequestBody(
  body: Uint8Array | ReadableStream<Uint8Array>,
  byteLength: number,
  mode: 'stream' | 'file',
): Promise<PreparedRequestBody> {
  const noop = async () => {};
  if (body instanceof Uint8Array) return { body, cleanup: noop };
  if (mode === 'stream') return { body, contentLength: byteLength, cleanup: noop };
  const [{ mkdtemp, rm }, { createWriteStream, openAsBlob }, { tmpdir }, { join }, { Readable }, { pipeline }] =
    await Promise.all([
      import('node:fs/promises'),
      import('node:fs'),
      import('node:os'),
      import('node:path'),
      import('node:stream'),
      import('node:stream/promises'),
    ]);
  const dir = await mkdtemp(join(tmpdir(), 'chickpea-upload-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const path = join(dir, 'body');
    await pipeline(
      Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(path, { mode: 0o600 }),
    );
    const blob = await openAsBlob(path);
    if (blob.size !== byteLength) throw new Error('upload_source_length_mismatch');
    return { body: blob, cleanup };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}
