import type { GatewayAttachmentClient, GatewayAttachmentRead } from './gateway/client.ts';
import { createGatewayDeploymentClient } from './gateway/runtime.ts';
import { resolveSlackCredentials, readStoredSlackTeamInfo } from './credentials.ts';
import type { PlatformEnv } from '../config/state-backend.ts';

const OFFICE_TYPES = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);
class AttachmentReadError extends Error {
  constructor(public readonly code: string, _status?: number) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AttachmentReadError('invalid_file_metadata');
  return value as Record<string, unknown>;
}

/** Prefer the registered gateway. Direct installations use their encrypted bot grant. */
export function createSlackAttachmentClient(env?: PlatformEnv): GatewayAttachmentClient {
  return { async readAttachment(fileId, maxBytes, signal) {
    const gateway = createGatewayDeploymentClient(env);
    if (await gateway.loadBinding()) return gateway.readAttachment(fileId, maxBytes, signal);
    const [{ botToken }, { teamId }] = await Promise.all([
      resolveSlackCredentials(env), readStoredSlackTeamInfo(env),
    ]);
    if (!botToken || !teamId) throw new AttachmentReadError('not_authed');
    return readDirectSlackAttachment({ fileId, maxBytes, token: botToken, workspaceId: teamId, ...(signal ? { signal } : {}) });
  } };
}

/** Retrieve only metadata-authorized Slack URLs, with bounded bytes and no redirects. */
export async function readDirectSlackAttachment(input: {
  fileId: string; maxBytes: number; token: string; workspaceId: string;
  signal?: AbortSignal; fetch?: typeof fetch;
}): Promise<GatewayAttachmentRead> {
  if (!/^F[A-Z0-9_]+$/.test(input.fileId)) throw new AttachmentReadError('invalid_file_id');
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 8 * 1024 * 1024) {
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
  const metadataBytes = await boundedBytes(metadata, 256 * 1024);
  const info = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes)));
  if (info.ok !== true) throw new AttachmentReadError(typeof info.error === 'string' && /^[a-z0-9_]{1,80}$/.test(info.error) ? info.error : 'attachment_unavailable');
  const file = record(info.file);
  if (file.id !== input.fileId) throw new AttachmentReadError('attachment_file_mismatch', 502);
  if (file.is_external === true || file.mode === 'external') throw new AttachmentReadError('unsupported_file_type', 415);
  const filename = file.name;
  if (typeof filename !== 'string' || !filename || Array.from(filename).length > 256 ||
      /[\u0000-\u001f\u007f]/.test(filename)) throw new AttachmentReadError('invalid_attachment_filename', 502);
  const mime = typeof file.mimetype === 'string' ? file.mimetype.toLowerCase().split(';')[0]!.trim() : '';
  let representation: GatewayAttachmentRead['representation'];
  let contentType = mime;
  let source = file.url_private_download ?? file.url_private;
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) representation = 'image_original';
  else if (mime === 'application/pdf') representation = 'pdf_original';
  else if (mime.startsWith('text/') || ['application/json', 'application/xml', 'application/csv'].includes(mime)) representation = 'text_original';
  else if (OFFICE_TYPES.has(String(file.filetype))) {
    representation = 'slack_pdf_conversion';
    contentType = 'application/pdf';
    source = file.converted_pdf ?? file.office_pdf;
    if (!source) throw new AttachmentReadError('conversion_pending', 409);
  } else throw new AttachmentReadError('unsupported_file_type', 415);
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
  if (returnedType && returnedType !== contentType && returnedType !== 'application/octet-stream') {
    await response.body?.cancel();
    throw new AttachmentReadError('invalid_attachment_response', 502);
  }
  const bytes = await boundedBytes(response, input.maxBytes);
  if (representation !== 'slack_pdf_conversion' && typeof file.size === 'number' &&
      Number.isSafeInteger(file.size) && file.size !== bytes.byteLength) {
    throw new AttachmentReadError('attachment_incomplete', 502);
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
