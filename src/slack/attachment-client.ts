import type { GatewayAttachmentClient, GatewayAttachmentRead } from './gateway/client.ts';
import { DEFAULT_ATTACHMENT_ACCEPT, type GatewayAttachmentRepresentation } from './gateway/protocol.ts';
import { createGatewayDeploymentClient, type GatewayClientStores } from './gateway/runtime.ts';
import { MAX_SLACK_ATTACHMENT_BYTES } from './attachment-normalization.ts';
import { resolveSlackCredentials, readStoredSlackTeamInfo } from './credentials.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { readBoundedBytes } from '../http/bounded-body.ts';

const OFFICE_TYPES = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);
/** Download types Slack serves for many files whatever files.info declared. */
const GENERIC_DOWNLOAD_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/force-download']);
class AttachmentReadError extends Error {
  constructor(public readonly code: string, _status?: number) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AttachmentReadError('invalid_file_metadata');
  return value as Record<string, unknown>;
}

/**
 * Prefer the registered gateway. Direct installations use their encrypted bot
 * grant. A caller that already holds the stores passes them, so the state
 * Durable Object reads its own stores instead of calling itself.
 */
export function createSlackAttachmentClient(env?: PlatformEnv, stores?: GatewayClientStores): GatewayAttachmentClient {
  return { async readAttachment(fileId, maxBytes, signal, accept) {
    const gateway = createGatewayDeploymentClient(env, stores ? { stores } : {});
    if (await gateway.loadBinding()) return gateway.readAttachment(fileId, maxBytes, signal, accept);
    const credentials = stores ? { state: stores.identity, keyring: stores.keyring } : undefined;
    const [{ botToken }, { teamId }] = await Promise.all([
      resolveSlackCredentials(env, stores?.settings, credentials),
      readStoredSlackTeamInfo(env, stores?.settings, credentials),
    ]);
    if (!botToken || !teamId) throw new AttachmentReadError('not_authed');
    return readDirectSlackAttachment({
      fileId, maxBytes, token: botToken, workspaceId: teamId,
      ...(signal ? { signal } : {}), ...(accept ? { accept } : {}),
    });
  } };
}

/** Retrieve only metadata-authorized Slack URLs, with bounded bytes and no redirects. */
export async function readDirectSlackAttachment(input: {
  fileId: string; maxBytes: number; token: string; workspaceId: string;
  signal?: AbortSignal; fetch?: typeof fetch;
  /** Without it, a read returns one of DEFAULT_ATTACHMENT_ACCEPT. */
  accept?: readonly GatewayAttachmentRepresentation[];
}): Promise<GatewayAttachmentRead> {
  if (!/^F[A-Z0-9_]+$/.test(input.fileId)) throw new AttachmentReadError('invalid_file_id');
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_SLACK_ATTACHMENT_BYTES) {
    throw new AttachmentReadError('invalid_max_bytes');
  }
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const fetcher = input.fetch ?? fetch;
  const token = input.token;
  const metadata = await fetcher('https://slack.com/api/files.info', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ file: input.fileId }), redirect: 'manual', signal,
  });
  if (!metadata.ok) {
    await metadata.body?.cancel();
    throw new AttachmentReadError(metadata.status >= 300 && metadata.status < 400
      ? 'attachment_redirect_rejected'
      : metadata.status === 429 ? 'ratelimited' : 'attachment_unavailable');
  }
  const metadataType = metadata.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (metadataType && metadataType !== 'application/json') {
    await metadata.body?.cancel();
    throw new AttachmentReadError('invalid_file_metadata');
  }
  // files.info inlines a text file's content as plain text, HTML, and
  // syntax-highlighted HTML: about 42 response bytes per file byte (a
  // 39,902-byte markdown file returned 1,665,332). Node's fetch also asks for
  // compression and decodes the body while Content-Length counts encoded bytes.
  const metadataBytes = await readBoundedBytes(metadata, {
    maxBytes: MAX_SLACK_ATTACHMENT_BYTES,
    checkContentLength: false,
    onOversize: () => new AttachmentReadError('attachment_byte_limit_exceeded', 413),
  });
  const info = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)));
  if (info.ok !== true) throw new AttachmentReadError(typeof info.error === 'string' && /^[a-z0-9_]{1,80}$/.test(info.error) ? info.error : 'attachment_unavailable');
  const file = record(info.file);
  if (file.id !== input.fileId) throw new AttachmentReadError('attachment_file_mismatch', 502);
  if (file.is_external === true || file.mode === 'external') throw new AttachmentReadError('unsupported_file_type', 415);
  const filename = file.name;
  if (typeof filename !== 'string' || !filename || Array.from(filename).length > 256 ||
      /[\u0000-\u001f\u007f]/.test(filename)) throw new AttachmentReadError('invalid_attachment_filename', 502);
  const mime = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase().split(';')[0]!.trim() : '';
  const accept = input.accept ?? DEFAULT_ATTACHMENT_ACCEPT;
  let representation: GatewayAttachmentRead['representation'];
  let contentType = mime;
  let source = file.url_private_download ?? file.url_private;
  // Slack's labels for archives vary, so the name and the zip signature decide.
  if (accept.includes('zip_original') && /\.(?:zip|skill)$/i.test(filename)) {
    representation = 'zip_original';
    contentType = 'application/zip';
  } else if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) representation = 'image_original';
  else if (mime === 'application/pdf') representation = 'pdf_original';
  else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/csv'].includes(mime)) representation = 'text_original';
  else if (OFFICE_TYPES.has(String(file.filetype))) {
    representation = 'slack_pdf_conversion';
    contentType = 'application/pdf';
    source = file.converted_pdf ?? file.office_pdf;
  } else throw new AttachmentReadError('unsupported_file_type', 415);
  if (!accept.includes(representation)) throw new AttachmentReadError('unsupported_file_type', 415);
  if (representation === 'slack_pdf_conversion' && !source) throw new AttachmentReadError('conversion_pending', 409);
  if (representation !== 'slack_pdf_conversion' && typeof file.size === 'number' && file.size > input.maxBytes) {
    throw new AttachmentReadError('attachment_byte_limit_exceeded', 413);
  }
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType)) {
    throw new AttachmentReadError('invalid_attachment_content_type', 502);
  }
  const url = attachmentUrl(source, input.fileId);
  const response = await fetcher(url, { headers: { authorization: `Bearer ${token}` },
    redirect: 'manual', signal });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new AttachmentReadError(response.status >= 300 && response.status < 400
      ? 'attachment_redirect_rejected' : 'attachment_download_failed', 502);
  }
  const returnedType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (returnedType && returnedType !== contentType && !GENERIC_DOWNLOAD_TYPES.has(returnedType) &&
      !(representation === 'zip_original' && returnedType === 'application/x-zip-compressed')) {
    await response.body?.cancel();
    // Record only validated MIME values, never credentials, URLs or file content.
    console.warn('[chickpea] attachment_content_type_mismatch', { expected: contentType, actual: /^[a-z0-9!#$&^_.+/-]{1,128}$/.test(returnedType) ? returnedType : 'invalid' });
    throw new AttachmentReadError(representation === 'zip_original' ? 'invalid_slack_file_type' : 'invalid_attachment_response', 502);
  }
  const bytes = await boundedBytes(response, input.maxBytes);
  if (representation !== 'slack_pdf_conversion' && typeof file.size === 'number' &&
      Number.isSafeInteger(file.size) && file.size !== bytes.byteLength) {
    throw new AttachmentReadError('attachment_incomplete', 502);
  }
  // A local file header, or the end record of an empty archive; the gateway checks the same.
  if (representation === 'zip_original' && !(bytes[0] === 0x50 && bytes[1] === 0x4b &&
      ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06)))) {
    throw new AttachmentReadError('invalid_slack_file_magic', 502);
  }
  return { fileId: input.fileId, filename, representation, contentType, bytes };
}

// files.info authenticated the bot and exact file ID. Enterprise Slack URLs use
// the parent team prefix, so validate that prefix structurally, not as the workspace ID.
function attachmentUrl(value: unknown, fileId: string): URL {
  let url: URL;
  try { url = new URL(typeof value === 'string' ? value : ''); }
  catch { throw new AttachmentReadError('invalid_attachment_url', 502); }
  if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port ||
      url.username || url.password || url.hash ||
      !new RegExp(`^/files-(?:pri|tmb)/T[A-Z0-9]+-${fileId}(?:/|-)`).test(url.pathname)) {
    throw new AttachmentReadError('invalid_attachment_url', 502);
  }
  return url;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    await response.body?.cancel();
    throw new AttachmentReadError('attachment_byte_limit_exceeded', 413);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) throw new AttachmentReadError('attachment_byte_limit_exceeded', 413);
        chunks.push(next.value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
  }
  if (length !== null && Number(length) !== size) throw new AttachmentReadError('attachment_incomplete', 502);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
