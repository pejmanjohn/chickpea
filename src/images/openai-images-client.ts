import type { ImageModelProfile } from '../model-catalog/image-profiles.ts';
import { isRecord } from '../security/content-validation.ts';

export type ImageOutputFormat = 'png' | 'jpeg' | 'webp';

/** Chosen by the caller from the file transport's cap, never by the model. */
export interface ImageFormatPolicy {
  format: ImageOutputFormat;
  /** 0-100, honored by the provider for jpeg and webp only. */
  compression?: number;
  background?: 'transparent' | 'opaque' | 'auto';
}

export interface ImageInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ImageGenerateRequest {
  prompt: string;
  format: ImageFormatPolicy;
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface ImageEditRequest extends ImageGenerateRequest {
  inputs: ImageInput[];
}

/**
 * The usage fields the images endpoint documents. The provider's object is
 * projected onto this shape rather than forwarded, so an unexpected or
 * oversized payload never reaches the model through a tool result.
 */
export interface ImageCallUsageDetails {
  image_tokens?: number;
  text_tokens?: number;
}

export interface ImageCallUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: ImageCallUsageDetails;
  output_tokens_details?: ImageCallUsageDetails;
}

export type ImageCallFailureReason =
  | 'rejected'
  | 'misconfigured'
  | 'timeout'
  | 'unreachable'
  | 'invalid-request';

export type ImageCallResult =
  | {
      ok: true;
      bytes: Uint8Array;
      appliedModel: string;
      appliedSize: string;
      appliedFormat: ImageOutputFormat;
      usage?: ImageCallUsage;
    }
  | { ok: false; reason: ImageCallFailureReason; detail: string };

export interface OpenAiImagesClient {
  readonly profile: ImageModelProfile;
  generate(request: ImageGenerateRequest): Promise<ImageCallResult>;
  edit(request: ImageEditRequest): Promise<ImageCallResult>;
}

export interface OpenAiImagesClientOptions {
  profile: ImageModelProfile;
  apiKey: string;
  /** Defaults to the OpenAI API base, mirroring `openAiApiBase()`. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Raised at construction only; call-time problems are returned, never thrown. */
export class OpenAiImagesConfigError extends Error {}

const SUPPORTED_INPUT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PROMPT_CHARACTER_CAP = 32_000;
const MAX_RESPONSE_CHARACTERS = 48 * 1024 * 1024;
const DETAIL_CHARACTER_CAP = 200;
// Shortest run of prompt text that must never reappear in a returned detail.
const PROMPT_ECHO_WINDOW = 24;
const CONTROL_CHARACTERS = /[\p{Cc}]/gu;

class ImageDeadlineError extends Error {}

/**
 * Mirrors `openAiApiBase()` in `src/config/provider-models.ts`, which is not
 * exported. Both read `OPENAI_API_URL` and fall back to the public base.
 */
export function openAiImagesApiBase(): string {
  return (process.env.OPENAI_API_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

export function createOpenAiImagesClient(options: OpenAiImagesClientOptions): OpenAiImagesClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new OpenAiImagesConfigError('missing_api_key');
  }
  const base = assertImagesBaseUrl(options.baseUrl ?? openAiImagesApiBase());
  const fetcher = options.fetchImpl ?? fetch;
  const profile = options.profile;

  async function call(
    path: string,
    build: () => { body: BodyInit; headers: Record<string, string> },
    request: ImageGenerateRequest,
  ): Promise<ImageCallResult> {
    const url = `${base.href.replace(/\/+$/, '')}${path}`;
    const prepared = build();
    try {
      return await withImageDeadline(
        request.deadlineMs,
        async (signal) => {
          const response = await fetcher(url, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, ...prepared.headers },
            body: prepared.body,
            redirect: 'error',
            signal,
          });
          const offHost = rejectOffHostResponse(response, base.host);
          if (offHost) {
            await response.body?.cancel().catch(() => {});
            return offHost;
          }
          return await readImageResponse(response, profile, request.format, request.prompt);
        },
        request.signal,
      );
    } catch (err) {
      if (err instanceof ImageDeadlineError) {
        return { ok: false, reason: 'timeout', detail: err.message };
      }
      // Transport failures carry URLs and socket detail, never request content,
      // but the message is dropped anyway so nothing can leak through it.
      return { ok: false, reason: 'unreachable', detail: 'network_error' };
    }
  }

  return {
    profile,
    async generate(request) {
      const invalid = validateRequest(request, [], profile);
      if (invalid) {
        return invalid;
      }
      return call(
        '/images/generations',
        () => ({
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: profile.model,
            prompt: request.prompt,
            n: 1,
            ...formatFields(request.format),
          }),
        }),
        request,
      );
    },
    async edit(request) {
      const invalid = validateRequest(request, request.inputs, profile);
      if (invalid) {
        return invalid;
      }
      return call('/images/edits', () => ({ headers: {}, body: editForm(request, profile) }), request);
    },
  };
}

function editForm(request: ImageEditRequest, profile: ImageModelProfile): FormData {
  const form = new FormData();
  form.append('model', profile.model);
  form.append('prompt', request.prompt);
  form.append('n', '1');
  for (const [field, value] of Object.entries(formatFields(request.format))) {
    form.append(field, String(value));
  }
  // Preserving an uploaded logo is the point of the edit path.
  form.append('input_fidelity', 'high');
  for (const [index, input] of request.inputs.entries()) {
    const blob = new Blob([input.bytes as unknown as BlobPart], { type: input.mimeType });
    // Part names are synthesized: a Slack filename never reaches the provider.
    form.append('image[]', blob, `image-${index + 1}.${extensionFor(input.mimeType)}`);
  }
  return form;
}

function formatFields(policy: ImageFormatPolicy): Record<string, string | number> {
  const fields: Record<string, string | number> = { output_format: policy.format };
  if (policy.format !== 'png' && typeof policy.compression === 'number') {
    fields.output_compression = Math.max(0, Math.min(100, Math.round(policy.compression)));
  }
  if (policy.background) {
    fields.background = policy.background;
  }
  return fields;
}

function validateRequest(
  request: ImageGenerateRequest,
  inputs: ImageInput[],
  profile: ImageModelProfile,
): ImageCallResult | undefined {
  if (!request.prompt.trim()) {
    return { ok: false, reason: 'invalid-request', detail: 'empty_prompt' };
  }
  if (Array.from(request.prompt).length > PROMPT_CHARACTER_CAP) {
    return { ok: false, reason: 'invalid-request', detail: 'prompt_too_long' };
  }
  if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
    return { ok: false, reason: 'invalid-request', detail: 'invalid_deadline' };
  }
  if (inputs.length > profile.maxEditInputs) {
    return { ok: false, reason: 'invalid-request', detail: 'too_many_input_images' };
  }
  if (!profile.input.includes('image') && inputs.length > 0) {
    return { ok: false, reason: 'invalid-request', detail: 'model_cannot_edit' };
  }
  for (const input of inputs) {
    if (input.bytes.byteLength === 0) {
      return { ok: false, reason: 'invalid-request', detail: 'empty_input_image' };
    }
    if (!SUPPORTED_INPUT_MIME_TYPES.has(input.mimeType)) {
      return { ok: false, reason: 'invalid-request', detail: 'unsupported_input_type' };
    }
  }
  return undefined;
}

function rejectOffHostResponse(response: Response, expectedHost: string): ImageCallResult | undefined {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    return { ok: false, reason: 'unreachable', detail: 'redirect_rejected' };
  }
  const finalUrl = response.url;
  if (!finalUrl) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return { ok: false, reason: 'unreachable', detail: 'redirect_rejected' };
  }
  if (parsed.protocol !== 'https:' || parsed.host !== expectedHost) {
    return { ok: false, reason: 'unreachable', detail: 'redirect_rejected' };
  }
  return undefined;
}

async function readImageResponse(
  response: Response,
  profile: ImageModelProfile,
  policy: ImageFormatPolicy,
  prompt: string,
): Promise<ImageCallResult> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_CHARACTERS)) {
    await response.body?.cancel().catch(() => {});
    return { ok: false, reason: 'unreachable', detail: 'response_too_large' };
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARACTERS) {
    return { ok: false, reason: 'unreachable', detail: 'response_too_large' };
  }
  const payload = parseJsonRecord(text);
  if (!response.ok) {
    return mapErrorResponse(response.status, payload, prompt);
  }
  if (!payload) {
    return { ok: false, reason: 'unreachable', detail: 'invalid_response' };
  }
  const first = Array.isArray(payload.data) && isRecord(payload.data[0]) ? payload.data[0] : undefined;
  const encoded = typeof first?.b64_json === 'string' ? first.b64_json : undefined;
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return { ok: false, reason: 'unreachable', detail: 'invalid_response' };
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch {
    return { ok: false, reason: 'unreachable', detail: 'invalid_response' };
  }
  const usage = projectUsage(payload.usage);
  return {
    ok: true,
    bytes,
    appliedModel: profile.id,
    appliedSize: readString(payload.size) ?? readString(first?.size) ?? 'auto',
    appliedFormat: readFormat(payload.output_format) ?? readFormat(first?.output_format) ?? policy.format,
    ...(usage ? { usage } : {}),
  };
}

function mapErrorResponse(
  status: number,
  payload: Record<string, unknown> | undefined,
  prompt: string,
): ImageCallResult {
  const error = isRecord(payload?.error) ? payload.error : undefined;
  const code = readString(error?.code) ?? readString(error?.type) ?? '';
  const message = safeDetail(readString(error?.message), prompt);
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'misconfigured', detail: code || 'credential_rejected' };
  }
  if (status >= 400 && status < 500 && code === 'moderation_blocked') {
    return { ok: false, reason: 'rejected', detail: message || 'moderation_blocked' };
  }
  if (status === 429) {
    return { ok: false, reason: 'unreachable', detail: 'rate_limited' };
  }
  if (status >= 400 && status < 500) {
    return { ok: false, reason: 'invalid-request', detail: code || `http_${status}` };
  }
  return { ok: false, reason: 'unreachable', detail: `http_${status}` };
}

/**
 * Provider text is echoed only after it is bounded, stripped of control
 * characters, and checked for any run of the prompt: a moderation category is
 * useful to the Agent, the Member's prompt coming back through an error is not.
 */
function safeDetail(value: string | undefined, prompt: string): string {
  if (!value) {
    return '';
  }
  const cleaned = value.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, DETAIL_CHARACTER_CAP);
  if (!cleaned) {
    return '';
  }
  const haystack = cleaned.toLowerCase();
  const needle = prompt.toLowerCase();
  for (let index = 0; index + PROMPT_ECHO_WINDOW <= needle.length; index += 1) {
    if (haystack.includes(needle.slice(index, index + PROMPT_ECHO_WINDOW))) {
      return '';
    }
  }
  if (needle.length > 0 && needle.length < PROMPT_ECHO_WINDOW && haystack.includes(needle)) {
    return '';
  }
  return cleaned;
}

async function withImageDeadline<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = () => rejectAbort?.(new ImageDeadlineError('aborted'));
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });

  const forwardAbort = () => controller.abort();
  if (callerSignal?.aborted) {
    forwardAbort();
  } else {
    callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);

  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } catch (err) {
    if (timedOut) {
      throw new ImageDeadlineError('deadline_exceeded');
    }
    if (controller.signal.aborted || err instanceof ImageDeadlineError) {
      throw new ImageDeadlineError('aborted');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', rejectOnAbort);
  }
}

function assertImagesBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OpenAiImagesConfigError('invalid_base_url');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new OpenAiImagesConfigError('invalid_base_url');
  }
  return url;
}

function extensionFor(mimeType: string): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}


/** Keep the documented numeric fields; drop everything else the provider sends. */
function projectUsage(value: unknown): ImageCallUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: ImageCallUsage = {};
  for (const field of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    const count = value[field];
    if (typeof count === 'number' && Number.isFinite(count)) {
      usage[field] = count;
    }
  }
  for (const field of ['input_tokens_details', 'output_tokens_details'] as const) {
    const details = projectUsageDetails(value[field]);
    if (details) {
      usage[field] = details;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function projectUsageDetails(value: unknown): ImageCallUsageDetails | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const details: ImageCallUsageDetails = {};
  for (const field of ['image_tokens', 'text_tokens'] as const) {
    const count = value[field];
    if (typeof count === 'number' && Number.isFinite(count)) {
      details[field] = count;
    }
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function readFormat(value: unknown): ImageOutputFormat | undefined {
  return value === 'png' || value === 'jpeg' || value === 'webp' ? value : undefined;
}
