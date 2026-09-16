import type { SettingsStore } from '../config/settings-store.ts';
import { decodeGeneratedImage } from '../images/prepare-output.ts';
import type {
  ImageCallResult,
  ImageEditRequest,
  ImageGenerateRequest,
  OpenAiImagesClient,
} from '../images/openai-images-client.ts';
import type { ImageModelProfile } from '../model-catalog/image-profiles.ts';
import { isRecord } from '../security/content-validation.ts';
import { requireOpenAiSubscriptionAvailable } from './availability.ts';
import {
  openAiSubscriptionCredentialsAreCurrent,
  recordOpenAiSubscriptionAuthenticationFailure,
  resolveOpenAiSubscriptionCredentials,
  type ResolvedOpenAiSubscriptionCredentials,
} from './credentials.ts';
import { OpenAiSubscriptionError, asOpenAiSubscriptionError } from './errors.ts';
import {
  OPENAI_SUBSCRIPTION_ENDPOINTS,
  OpenAiSubscriptionProtocolError,
} from './protocol.ts';
import {
  bindOpenAiSubscriptionTransport,
  createBoundOpenAiSubscriptionFetch,
  createOpenAiSubscriptionTransportMarker,
  openAiSubscriptionCredentialEpoch,
  OPENAI_SUBSCRIPTION_TRANSPORT_MARKER,
  releaseOpenAiSubscriptionTransport,
} from './transport.ts';

const DISPATCH_MODEL = 'gpt-5.6-terra';
const REQUESTED_IMAGE_MODEL = 'gpt-image-2.5-flare';
const REQUESTED_IMAGE_SIZE = '1024x1024';
const MAX_PROMPT_CHARACTERS = 32_000;
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_ENCODED_IMAGE_CHARACTERS = Math.ceil(16 * 1024 * 1024 * 4 / 3) + 4;

interface SubscriptionImagesDependencies {
  resolveCredentials?: typeof resolveOpenAiSubscriptionCredentials;
  credentialsAreCurrent?: typeof openAiSubscriptionCredentialsAreCurrent;
  credentialEpoch?: typeof openAiSubscriptionCredentialEpoch;
  bindTransport?: typeof bindOpenAiSubscriptionTransport;
  releaseTransport?: typeof releaseOpenAiSubscriptionTransport;
  recordAuthenticationFailure?: typeof recordOpenAiSubscriptionAuthenticationFailure;
}

export interface OpenAiSubscriptionImagesClientOptions {
  profile: ImageModelProfile;
  settings: SettingsStore;
  /** Raw fetch test seam. Production deliberately uses the installed global boundary. */
  fetchImpl?: typeof fetch;
  dependencies?: SubscriptionImagesDependencies;
}

class SubscriptionImageDeadlineError extends Error {}

export function createOpenAiSubscriptionImagesClient(
  options: OpenAiSubscriptionImagesClientOptions,
): OpenAiImagesClient {
  requireOpenAiSubscriptionAvailable();
  if (options.profile.authMethod !== 'subscription') {
    throw new OpenAiSubscriptionError('unsupported_model');
  }
  const dependencies = options.dependencies ?? {};

  return {
    profile: options.profile,
    async generate(request) {
      const invalid = validateRequest(request, options.profile);
      if (invalid) return invalid;
      try {
        return await withDeadline(
          request.deadlineMs,
          (signal) => generateOnce(request, signal, options, dependencies),
          request.signal,
        );
      } catch (error) {
        return mapFailure(error);
      }
    },
    async edit(_request: ImageEditRequest) {
      return { ok: false, reason: 'invalid-request', detail: 'model_cannot_edit' };
    },
  };
}

async function generateOnce(
  request: ImageGenerateRequest,
  signal: AbortSignal,
  options: OpenAiSubscriptionImagesClientOptions,
  dependencies: SubscriptionImagesDependencies,
): Promise<ImageCallResult> {
  const resolveCredentials = dependencies.resolveCredentials ?? resolveOpenAiSubscriptionCredentials;
  const credentialsAreCurrent = dependencies.credentialsAreCurrent ??
    openAiSubscriptionCredentialsAreCurrent;
  const credentials = await resolveCredentials({ settings: options.settings });
  throwIfAborted(signal);
  const expectedCredentialEpoch = (dependencies.credentialEpoch ?? openAiSubscriptionCredentialEpoch)();
  if (!await credentialsAreCurrent(options.settings, credentials)) {
    throw new OpenAiSubscriptionError('auth_reconnect_required');
  }
  throwIfAborted(signal);

  const marker = createOpenAiSubscriptionTransportMarker();
  const bindTransport = dependencies.bindTransport ?? bindOpenAiSubscriptionTransport;
  const releaseTransport = dependencies.releaseTransport ?? releaseOpenAiSubscriptionTransport;
  bindTransport(transportCredentials(credentials), {
    expectedCredentialEpoch,
    marker,
    allowedModels: new Set([DISPATCH_MODEL]),
    onAuthenticationFailure: async () => {
      await (dependencies.recordAuthenticationFailure ??
        recordOpenAiSubscriptionAuthenticationFailure)(options.settings, { credentials });
    },
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseTransport(marker);
  };
  signal.addEventListener('abort', release, { once: true });

  try {
    const fetcher = options.fetchImpl
      ? createBoundOpenAiSubscriptionFetch(options.fetchImpl)
      : globalThis.fetch;
    const response = await fetcher(OPENAI_SUBSCRIPTION_ENDPOINTS.responses, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPENAI_SUBSCRIPTION_TRANSPORT_MARKER]: marker,
      },
      body: JSON.stringify(requestBody(request.prompt)),
      redirect: 'manual',
      signal,
    });
    if (!response.ok) return await mapProviderFailure(response);
    const imageCall = await readCompletedImageCall(response, signal);
    const bytes = decodeStandardBase64(imageCall.result);
    let facts: ReturnType<typeof decodeGeneratedImage>['facts'];
    try {
      facts = decodeGeneratedImage(bytes).facts;
    } catch {
      return { ok: false, reason: 'unreachable', detail: 'invalid_image' };
    }
    return {
      ok: true,
      images: [bytes],
      appliedModel: options.profile.id,
      appliedSize: `${facts.width}x${facts.height}`,
      appliedFormat: facts.format,
    };
  } finally {
    signal.removeEventListener('abort', release);
    release();
  }
}

function transportCredentials(credentials: ResolvedOpenAiSubscriptionCredentials): {
  accessToken: string;
  accountId: string;
} {
  return { accessToken: credentials.accessToken, accountId: credentials.accountId };
}

function requestBody(prompt: string): Record<string, unknown> {
  return {
    model: DISPATCH_MODEL,
    store: false,
    stream: true,
    instructions: 'Generate exactly one image for the user request with the image generation tool.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    tools: [{
      type: 'image_generation',
      model: REQUESTED_IMAGE_MODEL,
      quality: 'low',
      size: REQUESTED_IMAGE_SIZE,
      output_format: 'png',
    }],
    tool_choice: 'required',
    parallel_tool_calls: false,
  };
}

function validateRequest(
  request: ImageGenerateRequest,
  profile: ImageModelProfile,
): ImageCallResult | undefined {
  if (!request.prompt.trim()) {
    return { ok: false, reason: 'invalid-request', detail: 'empty_prompt' };
  }
  if (Array.from(request.prompt).length > MAX_PROMPT_CHARACTERS) {
    return { ok: false, reason: 'invalid-request', detail: 'prompt_too_long' };
  }
  if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
    return { ok: false, reason: 'invalid-request', detail: 'invalid_deadline' };
  }
  if (request.count !== undefined && request.count !== 1) {
    return { ok: false, reason: 'invalid-request', detail: 'invalid_count' };
  }
  if (profile.maxOutputs !== 1 || profile.maxEditInputs !== 0) {
    return { ok: false, reason: 'invalid-request', detail: 'invalid_profile' };
  }
  // The successful proof did not establish exact output-control conformance.
  // Product defaults are accepted, then translated to the one proven request.
  if (request.size !== undefined && request.size !== 'auto') {
    return { ok: false, reason: 'invalid-request', detail: 'unsupported_size' };
  }
  if (request.quality !== undefined && request.quality !== 'auto') {
    return { ok: false, reason: 'invalid-request', detail: 'unsupported_quality' };
  }
  // Format and compression are host transport hints, not model controls. The
  // adapter requests the proven PNG shape and lets output preparation meet the
  // destination cap after validating the actual returned bytes.
  if (request.format.background !== undefined && request.format.background !== 'auto') {
    return { ok: false, reason: 'invalid-request', detail: 'unsupported_output_control' };
  }
  return undefined;
}

interface CompletedImageCall {
  result: string;
}

interface ObservedImageCall {
  status?: string;
  result?: string;
}

async function readCompletedImageCall(
  response: Response,
  signal: AbortSignal,
): Promise<CompletedImageCall> {
  if (!response.body) throw new OpenAiSubscriptionProtocolError('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytesRead = 0;
  const cancelOnAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      bytesRead += next.value.byteLength;
      if (bytesRead > MAX_STREAM_BYTES) {
        throw new OpenAiSubscriptionProtocolError('invalid_response');
      }
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof OpenAiSubscriptionProtocolError ||
        error instanceof SubscriptionImageDeadlineError) throw error;
    if (signal.aborted) throw new SubscriptionImageDeadlineError('aborted');
    throw new OpenAiSubscriptionProtocolError('invalid_response', { cause: error });
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  let terminal: 'completed' | undefined;
  let terminalImageId: string | undefined;
  const calls = new Map<string, ObservedImageCall>();
  for (const block of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')) {
    const data = block.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new OpenAiSubscriptionProtocolError('invalid_response');
    }
    if (!isRecord(event)) continue;
    if (event.type === 'response.completed') {
      terminal = 'completed';
      if (!isRecord(event.response) || !Array.isArray(event.response.output)) {
        throw new OpenAiSubscriptionProtocolError('invalid_response');
      }
      terminalImageId = recordTerminalImageCall(event.response.output, calls);
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      throw new OpenAiSubscriptionProtocolError('invalid_response');
    }
    if (event.type === 'response.incomplete') {
      throw new OpenAiSubscriptionProtocolError('invalid_response');
    }
    if (event.type === 'response.output_item.added') {
      recordImageCall(event.item, calls, 'added');
    }
    if (event.type === 'response.output_item.done') {
      recordImageCall(event.item, calls, 'done');
    }
  }
  if (terminal !== 'completed' || !terminalImageId || calls.size !== 1) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  const imageCall = calls.get(terminalImageId);
  if (imageCall?.status !== 'completed' || !imageCall.result) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  return { result: imageCall.result };
}

/** Non-image output is allowed; every image event must agree on one bounded call. */
function recordTerminalImageCall(
  items: unknown[],
  calls: Map<string, ObservedImageCall>,
): string {
  const imageItems = items.filter((value) => isRecord(value) && value.type === 'image_generation_call');
  if (imageItems.length !== 1) throw new OpenAiSubscriptionProtocolError('invalid_response');
  return recordImageCall(imageItems[0], calls, 'terminal');
}

function recordImageCall(
  value: unknown,
  calls: Map<string, ObservedImageCall>,
  phase: 'added' | 'done' | 'terminal',
): string {
  if (!isRecord(value)) throw new OpenAiSubscriptionProtocolError('invalid_response');
  if (value.type !== 'image_generation_call') return '';
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value.id)) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  const prior = calls.get(value.id) ?? {};
  const suppliedResult = value.result;
  const resultPending = phase === 'added' && (suppliedResult === undefined || suppliedResult === null);
  if (!resultPending &&
      (typeof suppliedResult !== 'string' || suppliedResult.length === 0 ||
        suppliedResult.length > MAX_ENCODED_IMAGE_CHARACTERS)) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  if (phase !== 'added' && typeof suppliedResult !== 'string') {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  const result = typeof suppliedResult === 'string' ? suppliedResult : prior.result;
  if (phase !== 'added' && value.status !== 'completed') {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  if (value.status !== undefined && typeof value.status !== 'string') {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  const status = typeof value.status === 'string' ? value.status : prior.status;
  if (status === 'failed' || status === 'incomplete') {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  if (prior.result && result && prior.result !== result) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  calls.set(value.id, {
    ...(status === undefined ? {} : { status }),
    ...(result === undefined ? {} : { result }),
  });
  return value.id;
}

function decodeStandardBase64(value: string): Uint8Array {
  if (value.length > MAX_ENCODED_IMAGE_CHARACTERS || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new OpenAiSubscriptionProtocolError('invalid_response');
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (error) {
    throw new OpenAiSubscriptionProtocolError('invalid_response', { cause: error });
  }
}

async function mapProviderFailure(response: Response): Promise<ImageCallResult> {
  let code = `http_${response.status}`;
  try {
    const payload: unknown = await response.json();
    const candidate = isRecord(payload) && isRecord(payload.error) &&
      typeof payload.error.code === 'string' ? payload.error.code : undefined;
    if (candidate && /^[a-z0-9][a-z0-9_.-]{0,47}$/.test(candidate)) code = candidate;
  } catch {
    // The boundary normally projects a safe JSON code. Status remains safe.
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'misconfigured', detail: code };
  }
  if (response.status === 429) return { ok: false, reason: 'unreachable', detail: code };
  if (response.status >= 400 && response.status < 500) {
    return { ok: false, reason: 'rejected', detail: code };
  }
  return { ok: false, reason: 'unreachable', detail: code };
}

function mapFailure(error: unknown): ImageCallResult {
  if (error instanceof SubscriptionImageDeadlineError) {
    return { ok: false, reason: 'timeout', detail: error.message };
  }
  const subscription = asOpenAiSubscriptionError(error);
  if (subscription.code === 'auth_reconnect_required' || subscription.code === 'unsupported_runtime') {
    return { ok: false, reason: 'misconfigured', detail: subscription.code };
  }
  if (subscription.code === 'entitlement_denied' || subscription.code === 'client_rejected' ||
      subscription.code === 'originator_rejected') {
    return { ok: false, reason: 'rejected', detail: subscription.code };
  }
  if (subscription.code === 'request_timeout') {
    return { ok: false, reason: 'timeout', detail: subscription.code };
  }
  return { ok: false, reason: 'unreachable', detail: subscription.code };
}

async function withDeadline<T>(
  deadlineMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort?.(new SubscriptionImageDeadlineError(
    timedOut ? 'deadline_exceeded' : 'aborted',
  ));
  controller.signal.addEventListener('abort', abort, { once: true });
  const forwardAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new SubscriptionImageDeadlineError('deadline_exceeded'));
  }, deadlineMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
    controller.signal.removeEventListener('abort', abort);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SubscriptionImageDeadlineError('aborted');
}
