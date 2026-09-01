import {
  buildOpenAiSubscriptionHeaders,
  isSafeOpenAiSubscriptionModelId,
  OPENAI_SUBSCRIPTION_ENDPOINTS,
  OPENAI_SUBSCRIPTION_MODELS,
  OpenAiSubscriptionProtocolError,
} from './protocol.ts';
import type { OpenAiSubscriptionFailureCode } from './types.ts';

export const OPENAI_SUBSCRIPTION_TRANSPORT_MARKER = 'x-chickpea-subscription-transport';

const DEFAULT_HEADER_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const EMPTY_MODEL_SET: ReadonlySet<string> = new Set();
const SUBSCRIPTION_MODEL_SET: ReadonlySet<string> = new Set(OPENAI_SUBSCRIPTION_MODELS);
const ALLOWED_BODY_KEYS = new Set([
  'include',
  'input',
  'instructions',
  'model',
  'parallel_tool_calls',
  'prompt_cache_key',
  'reasoning',
  'service_tier',
  'store',
  'stream',
  'temperature',
  'text',
  'tool_choice',
  'tools',
]);

interface OpenAiSubscriptionTransportCredentials {
  accessToken: string;
  accountId: string;
}

interface OpenAiSubscriptionFetchBoundaryOptions {
  credentials?: () => OpenAiSubscriptionTransportCredentials;
  allowedModels?: () => ReadonlySet<string>;
  binding?: (marker: string) => ActiveTransportBinding | undefined;
  fetch?: typeof globalThis.fetch;
  randomUUID?: () => string;
  timeoutMs?: number;
  onAuthenticationFailure?: () => void | Promise<void>;
}

interface ActiveTransportBinding {
  credentials: OpenAiSubscriptionTransportCredentials;
  allowedModels: ReadonlySet<string>;
  onAuthenticationFailure?: () => void | Promise<void>;
}

const activeBindings = new Map<string, ActiveTransportBinding>();
let bindingRevision = 0;
let credentialEpoch = 0;
const WRAPPED_FETCH = Symbol.for('chickpea.openai-subscription.fetch-boundary');

export function bindOpenAiSubscriptionTransport(
  credentials: OpenAiSubscriptionTransportCredentials,
  options: {
    expectedCredentialEpoch?: number;
    marker: string;
    allowedModels?: ReadonlySet<string>;
    onAuthenticationFailure?: () => void | Promise<void>;
  },
): void {
  if (
    options.expectedCredentialEpoch !== undefined &&
    options.expectedCredentialEpoch !== credentialEpoch
  ) {
    throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
  }
  const marker = options.marker;
  if (!isSafeTransportMarker(marker)) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  activeBindings.set(marker, {
    credentials: { ...credentials },
    allowedModels: new Set(options.allowedModels ?? SUBSCRIPTION_MODEL_SET),
    ...(options.onAuthenticationFailure
      ? { onAuthenticationFailure: options.onAuthenticationFailure }
      : {}),
  });
  installOpenAiSubscriptionFetchBoundary();
  bindingRevision += 1;
}

export function clearOpenAiSubscriptionTransport(expectedRevision?: number): boolean {
  if (expectedRevision !== undefined && expectedRevision !== bindingRevision) return false;
  activeBindings.clear();
  bindingRevision += 1;
  credentialEpoch += 1;
  return true;
}

export function openAiSubscriptionTransportRevision(): number {
  return bindingRevision;
}

export function openAiSubscriptionCredentialEpoch(): number {
  return credentialEpoch;
}

export function createOpenAiSubscriptionTransportMarker(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  const marker = `v2:${randomUUID()}`;
  if (!isSafeTransportMarker(marker) || marker === 'v2:00000000-0000-0000-0000-000000000000') {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  return marker;
}

function installOpenAiSubscriptionFetchBoundary(): void {
  const current = globalThis.fetch as typeof globalThis.fetch & { [WRAPPED_FETCH]?: boolean };
  if (current[WRAPPED_FETCH]) return;
  const boundary = createOpenAiSubscriptionFetchBoundary({
    binding: (marker) => {
      const binding = activeBindings.get(marker);
      if (!binding) {
        throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
      }
      return binding;
    },
    fetch: current,
  }) as typeof globalThis.fetch & { [WRAPPED_FETCH]?: boolean };
  Object.defineProperty(boundary, WRAPPED_FETCH, { value: true });
  globalThis.fetch = boundary;
}

export function createOpenAiSubscriptionFetchBoundary(
  options: OpenAiSubscriptionFetchBoundaryOptions,
): typeof globalThis.fetch {
  const upstream = options.fetch ?? globalThis.fetch;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl = requestUrlFor(input);
    const callerHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (requestUrl !== OPENAI_SUBSCRIPTION_ENDPOINTS.responses) {
      // The marker is private to the subscription provider. If its upstream
      // endpoint drifts, fail closed instead of forwarding model-visible data
      // to whatever URL the dependency selected.
      if (callerHeaders.has(OPENAI_SUBSCRIPTION_TRANSPORT_MARKER)) {
        throw new OpenAiSubscriptionProtocolError('protocol_drift');
      }
      return upstream(input, init);
    }

    const request = new Request(input, init);
    const marker = request.headers.get(OPENAI_SUBSCRIPTION_TRANSPORT_MARKER);
    if (!marker || !isSafeTransportMarker(marker)) {
      throw new OpenAiSubscriptionProtocolError('protocol_drift');
    }
    if (request.method !== 'POST' || new URL(request.url).search !== '') {
      throw new OpenAiSubscriptionProtocolError('protocol_drift');
    }
    const binding = options.binding?.(marker);
    const credentials = binding?.credentials ?? options.credentials?.();
    if (!credentials) {
      throw new OpenAiSubscriptionProtocolError('auth_reconnect_required');
    }
    const allowedModels = binding?.allowedModels ?? options.allowedModels?.() ?? EMPTY_MODEL_SET;
    const onAuthenticationFailure = binding?.onAuthenticationFailure ?? options.onAuthenticationFailure;
    const body = await readRequestBody(request);
    validateRequestBody(body, allowedModels);

    const sessionId = (options.randomUUID ?? (() => crypto.randomUUID()))();
    const headers = buildOpenAiSubscriptionHeaders({
      ...credentials,
      sessionId,
      headers: {
        accept: 'text/event-stream',
        'content-type': 'application/json',
        'openai-beta': 'responses=experimental',
        'x-client-request-id': sessionId,
      },
    });

    const timeout = timeoutSignal(options.timeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS, request.signal);
    let response: Response;
    try {
      response = await upstream(OPENAI_SUBSCRIPTION_ENDPOINTS.responses, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: timeout.signal,
      });
    } catch (error) {
      timeout.clear();
      if (timeout.timedOut()) {
        throw new OpenAiSubscriptionProtocolError('request_timeout', { cause: error });
      }
      if (error instanceof OpenAiSubscriptionProtocolError) throw error;
      throw new OpenAiSubscriptionProtocolError('provider_unavailable', { cause: error });
    }
    timeout.clearHeaderTimer();

    if (response.status >= 300 && response.status < 400) {
      await discardResponseBody(response);
      timeout.clear();
      throw new OpenAiSubscriptionProtocolError('protocol_drift', { status: response.status });
    }
    if (!response.ok) {
      const providerText = await readBoundedText(response, 64 * 1024);
      timeout.clear();
      const code = classifyProviderFailure(response.status, providerText);
      if (response.status === 401) await onAuthenticationFailure?.();
      return safeFailureResponse(response, code);
    }
    const contentType = response.headers.get('content-type');
    // The exact ChatGPT Codex endpoint was observed returning a valid SSE body
    // with no Content-Type header. Normalize that omission for the downstream
    // SSE parser, but reject any explicitly contradictory success type.
    if (
      !response.body ||
      (contentType !== null && !contentType.toLowerCase().includes('text/event-stream'))
    ) {
      await discardResponseBody(response);
      timeout.clear();
      throw new OpenAiSubscriptionProtocolError('invalid_response', { status: response.status });
    }
    return new Response(limitResponseBody(response.body, MAX_RESPONSE_BYTES, timeout.clear), {
      status: response.status,
      headers: safeSuccessHeaders(response.headers),
    });
  };
}

function isSafeTransportMarker(value: string): boolean {
  return value === 'v1' ||
    /^v2:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

function requestUrlFor(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function readRequestBody(request: Request): Promise<string> {
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return request.text();
  if (encoding !== 'zstd') throw new OpenAiSubscriptionProtocolError('protocol_drift');

  const compressed = new Uint8Array(await request.arrayBuffer());
  if (compressed.byteLength > MAX_REQUEST_BYTES) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  const zlib = typeof process === 'undefined'
    ? undefined
    : process.getBuiltinModule?.('node:zlib');
  if (!zlib || typeof zlib.zstdDecompressSync !== 'function') {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  try {
    const decoded = zlib.zstdDecompressSync(compressed, {
      maxOutputLength: MAX_REQUEST_BYTES + 1,
    });
    if (decoded.byteLength > MAX_REQUEST_BYTES) {
      throw new OpenAiSubscriptionProtocolError('protocol_drift');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch (error) {
    if (error instanceof OpenAiSubscriptionProtocolError) throw error;
    throw new OpenAiSubscriptionProtocolError('protocol_drift', { cause: error });
  }
}

function validateRequestBody(raw: string, allowedModels: ReadonlySet<string>): void {
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  if (!isRecord(body) || Object.keys(body).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
    throw new OpenAiSubscriptionProtocolError('protocol_drift');
  }
  const modelAllowed = typeof body.model === 'string' &&
    isSafeOpenAiSubscriptionModelId(body.model) &&
    allowedModels.has(body.model);
  if (
    !modelAllowed ||
    body.store !== false ||
    body.stream !== true
  ) {
    throw new OpenAiSubscriptionProtocolError(
      typeof body.model === 'string' && !modelAllowed
        ? 'unsupported_model'
        : 'protocol_drift',
    );
  }
}

function classifyProviderFailure(status: number, text: string): OpenAiSubscriptionFailureCode {
  if (status === 401) return 'auth_reconnect_required';
  if (status === 403) {
    if (/originator/i.test(text)) return 'originator_rejected';
    if (/client(?:_id)?/i.test(text)) return 'client_rejected';
    return 'entitlement_denied';
  }
  if (status === 408) return 'request_timeout';
  if (status === 429) return 'subscription_quota_exhausted';
  if (status >= 500) return 'provider_unavailable';
  return 'invalid_response';
}

function safeFailureResponse(response: Response, code: OpenAiSubscriptionFailureCode): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of ['retry-after', 'retry-after-ms']) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value.slice(0, 128));
  }
  return new Response(
    JSON.stringify({ error: { code, message: `OpenAI subscription operation failed (${code}).` } }),
    { status: response.status, headers },
  );
}

function safeSuccessHeaders(source: Headers): Headers {
  const headers = new Headers({ 'content-type': 'text/event-stream' });
  const requestId = source.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId.slice(0, 256));
  return headers;
}

function timeoutSignal(timeoutMs: number, callerSignal: AbortSignal): {
  signal: AbortSignal;
  clearHeaderTimer: () => void;
  clear: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal.aborted) abortFromCaller();
  else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('OpenAI subscription request timed out'));
  }, Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    clearHeaderTimer: () => clearTimeout(timer),
    clear: () => {
      clearTimeout(timer);
      callerSignal.removeEventListener('abort', abortFromCaller);
    },
    timedOut: () => timedOut,
  };
}

function limitResponseBody(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onFinished: () => void = () => {},
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onFinished();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        finish();
        controller.error(error);
        return;
      }
      if (next.done) {
        finish();
        controller.close();
        return;
      }
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        finish();
        controller.error(new OpenAiSubscriptionProtocolError('invalid_response'));
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) return text;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      return text;
    }
    text += decoder.decode(next.value, { stream: true });
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already being discarded; cancellation failure is immaterial.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
