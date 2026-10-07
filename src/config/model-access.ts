/**
 * Run-scoped model access.
 *
 * The provider registry holds only credential-free providers, so no isolate
 * carries a model key between runs. A trusted host binds the run's frozen,
 * non-secret grant to an async-context cell: the model-access interceptor at
 * each top-level Flue `agent` operation (every attempt, including a resumed
 * one), or `withModelAccess` around a stateless call. The configured resolver
 * turns the grant into the installation's key once per attempt, and
 * Chickpea's provider proxy injects that key on every request. With no cell,
 * or a cell for another provider, a request is refused before it leaves the
 * process, whatever keys the deployment holds. On a deployment serving many
 * installations the host's admission check is asked when an attempt starts
 * and before every request the proxy sends (each step, retry, compaction and
 * stateless call), so a suspended or ended installation starts no attempt and
 * sends no further request (see installation-admission.ts). A grant Chickpea
 * pays for is also admitted against the installation's credits before each
 * request and charged once when it finishes (see platform-funding.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
  type OpenAICompletionsCompat,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import type { FlueExecutionContext, FlueExecutionInterceptor } from '@flue/runtime';

import { requireInstallationAdmitted } from './installation-admission.ts';
import { deploymentServesManyInstallations, installationScopeOf } from './installation-scope.ts';
import {
  chargePlatformRequest,
  platformPriceMultiplier,
  requirePlatformFundingAdmitted,
} from './platform-funding.ts';
import type { PlatformEnv } from './state-backend.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  isRevisionedAlias,
} from '../model-catalog/provider-alias.ts';
import { isRecord } from '../security/content-validation.ts';
import {
  modelRequestRecord,
  NO_PROVIDER_REPORT,
  providerReportReader,
  usageInstallationId,
  type ModelRequestAttribution,
  type ModelRequestEnd,
  type ModelRequestFundingSource,
  type ModelRequestRecord,
  type ProviderReportReader,
} from '../usage/model-requests.ts';
import { canonicalPriceProviderId, priceCatalogFor } from '../usage/pricing/catalog.ts';
import type { ImageCallResult } from '../images/openai-images-client.ts';
import { currentImagePrice, sentImageRequestRecord } from '../images/request-record.ts';

/**
 * Providers whose key comes from the run's installation. `local-stub` is the
 * offline verifiers' standalone lane; a deployment serving many installations
 * never resolves it.
 */
export const MODEL_ACCESS_PROVIDER_IDS = ['anthropic', 'openai', 'openrouter', 'local-stub'] as const;
export type ModelAccessProviderId = (typeof MODEL_ACCESS_PROVIDER_IDS)[number];

/** Frozen and non-secret: what a run may use, never the key itself. */
export interface ModelAccessGrant {
  readonly installationId: string;
  readonly providerId: ModelAccessProviderId;
  readonly credentialRefId: string;
  readonly credentialVersion: number;
  /** The submission or stateless call this grant was bound for. */
  readonly runId: string;
  readonly fundingSource: ModelRequestFundingSource;
}

/** Ephemeral call configuration. Never persisted, logged, or exposed to tools. */
export interface ResolvedModelAccess {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ModelAccessResolver {
  /**
   * The installation's access for a grant, read through `env`, the trusted
   * env of the grant's installation. Rejects a grant whose credential was
   * rotated or deleted rather than returning another version's key.
   */
  resolve(grant: ModelAccessGrant, env: PlatformEnv | undefined): Promise<ResolvedModelAccess>;
}

export type ModelAccessErrorCode =
  | 'scope_missing'
  | 'provider_mismatch'
  | 'installation_mismatch'
  | 'provider_not_offered'
  | 'funding_not_offered'
  | 'deployment_key_present';

export class ModelAccessError extends Error {
  readonly code: ModelAccessErrorCode;

  constructor(code: ModelAccessErrorCode, message: string) {
    super(message);
    this.name = 'ModelAccessError';
    this.code = code;
  }
}

interface BoundAccess {
  readonly grant: ModelAccessGrant;
  readonly access: ResolvedModelAccess;
}

/**
 * One attempt's access by provider (empty when it has none), the instance it
 * was bound for, and whether its deployment serves many installations, which
 * the proxy reads instead of any process-wide setting. A hosted cell names
 * its installation, whose admission each request the proxy sends asks again.
 */
interface ModelAccessCell {
  readonly instanceId: string | undefined;
  readonly hosted: boolean;
  readonly installationId: string | undefined;
  readonly bound: ReadonlyMap<ModelAccessProviderId, BoundAccess>;
  readonly env: PlatformEnv | undefined;
  readonly attribution: ModelRequestAttribution;
}

export type ModelRequestRecorder = (record: ModelRequestRecord, env: PlatformEnv | undefined) => Promise<unknown>;

const RECORD_BUDGET_MS = 2_000;

const cells = new AsyncLocalStorage<ModelAccessCell>();
let resolver: ModelAccessResolver | undefined;
let recorder: ModelRequestRecorder | undefined;

/** The composition seam: the deployment's resolver, installed before any model call. */
export function configureModelAccessResolver(next: ModelAccessResolver): void {
  resolver = next;
}

export function modelAccessResolverConfigured(): boolean {
  return resolver !== undefined;
}

export function configureModelRequestRecorder(next: ModelRequestRecorder): void {
  recorder = next;
}

export function modelRequestRecorderConfigured(): boolean {
  return recorder !== undefined;
}

function requireResolver(): ModelAccessResolver {
  if (!resolver) throw new Error('No model access resolver is configured.');
  return resolver;
}

/** The installation-supplied provider a registered provider id routes for, if any. */
export function modelAccessProviderId(providerId: string): ModelAccessProviderId | undefined {
  switch (providerId) {
    case 'anthropic':
    case ANTHROPIC_COMPAT_PROVIDER_ID:
      return 'anthropic';
    case 'openai':
    case OPENAI_PLATFORM_COMPAT_PROVIDER_ID:
      return 'openai';
    case 'openrouter':
      return 'openrouter';
    case 'local-stub':
      return 'local-stub';
  }
  if (isRevisionedAlias('anthropic', providerId)) return 'anthropic';
  if (isRevisionedAlias('openaiPlatform', providerId)) return 'openai';
  return undefined;
}

export function isModelAccessProviderId(value: unknown): value is ModelAccessProviderId {
  return (MODEL_ACCESS_PROVIDER_IDS as readonly unknown[]).includes(value);
}

/** The provider part of a `provider/model` specifier. */
export function providerPrefix(model: string): string {
  const separator = model.indexOf('/');
  return separator > 0 ? model.slice(0, separator) : model;
}

/** What the trusted host knows about one attempt before its first model call. */
export type AttemptModelAccess =
  /** The grant persisted with the attempt's run. */
  | { readonly env: PlatformEnv | undefined; readonly grant: ModelAccessGrant; readonly agentId?: string }
  /** The run's model brings its own deployment credential (standalone lanes only). */
  | { readonly env: PlatformEnv | undefined; readonly deploymentLane: true; readonly agentId?: string }
  /** An agent with no persisted run of its own (the coding worker). */
  | { readonly env: PlatformEnv | undefined; readonly agentId?: string };

export interface ModelAccessInterceptorOptions {
  /** The attempt's run, from trusted persisted state; never from model-visible input. */
  lookup(context: FlueExecutionContext): Promise<AttemptModelAccess>;
  /**
   * Standalone only: the one installation's current grants, for an agent
   * with no persisted run of its own. It is today's live key read.
   */
  installationGrants(env: PlatformEnv | undefined, runId: string): Promise<readonly ModelAccessGrant[]>;
}

/**
 * Binds each top-level agent operation to its run's grant. Nested operations
 * of the same instance (prompt and skill, and joined submissions) run inside
 * its cell, so `operationKind` is not consulted. An agent operation of
 * another instance never inherits a cell, even one started from inside it.
 */
export function createModelAccessInterceptor(
  options: ModelAccessInterceptorOptions,
): FlueExecutionInterceptor {
  return async (operation, context, next) => {
    if (operation.type === 'model') {
      const cell = cells.getStore();
      if (!cell || (cell.hosted && cell.bound.size === 0)) {
        throw new ModelAccessError('scope_missing', 'No model access is in scope for this model call.');
      }
      return next();
    }
    if (operation.type !== 'agent') return next();
    const active = cells.getStore();
    if (active && (context.instanceId === undefined || context.instanceId === active.instanceId)) return next();
    const attempt = await options.lookup(context);
    const hosted = deploymentServesManyInstallations(attempt.env);
    // A new, retried or resumed attempt, before anything is decrypted.
    const installationId = hosted ? installationScopeOf(attempt.env)?.installationId : undefined;
    if (installationId) await requireInstallationAdmitted(installationId);
    const runId = context.submissionId ?? context.instanceId ?? 'attempt';
    let grants: readonly ModelAccessGrant[] = [];
    if ('grant' in attempt) {
      grants = [attempt.grant];
    } else if (!('deploymentLane' in attempt) && !hosted) {
      grants = await options.installationGrants(attempt.env, runId);
    }
    const cell = await resolveCell(grants, attempt.env, hosted, context.instanceId, runId, attempt.agentId ?? null);
    return cells.run(cell, next);
  };
}

/** A stateless call runs inside an explicit grant, resolved once. */
export async function withModelAccess<T>(
  grant: ModelAccessGrant,
  env: PlatformEnv | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const hosted = deploymentServesManyInstallations(env);
  return cells.run(await resolveCell([grant], env, hosted, undefined, grant.runId, null), fn);
}

/**
 * A stateless call on a lane that brings its own deployment credential
 * (Workers AI, a subscription): offered only on standalone.
 */
export async function withDeploymentLane<T>(
  env: PlatformEnv | undefined,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (deploymentServesManyInstallations(env)) throw providerNotOffered('this provider');
  return cells.run(await resolveCell([], env, false, undefined, runId, null), fn);
}

export type ImageEndpointFetch = (
  path: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly body: BodyInit; readonly signal: AbortSignal },
) => Promise<Response>;

export interface ImageModelRequest {
  readonly grant: ModelAccessGrant;
  readonly env: PlatformEnv | undefined;
  readonly model: string;
  readonly defaultBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Refusals throw before `call` runs. Once `call` fetches, the request is
 * recorded and, when Chickpea pays, charged once; a `call` that never
 * fetches is neither recorded nor charged.
 */
export async function sendImageRequest(
  request: ImageModelRequest,
  call: (fetch: ImageEndpointFetch, endpoint: string) => Promise<ImageCallResult>,
): Promise<ImageCallResult> {
  const { grant, env, model } = request;
  const installationId = deploymentServesManyInstallations(env) ? installationScopeOf(env)?.installationId : undefined;
  if (installationId) await requireInstallationAdmitted(installationId);
  const platformGrant = grant.fundingSource === 'platform' ? grant : undefined;
  if (platformGrant) {
    if (!currentImagePrice(grant.providerId, model, Date.now())) throw unpricedModel();
    await requirePlatformFundingAdmitted(platformGrant, { provider: grant.providerId, model });
  }
  const access = await requireResolver().resolve(grant, env);
  const endpoint = (access.baseUrl ?? request.defaultBaseUrl).replace(/\/+$/, '');
  if (!keySafeEndpoint(endpoint)) return { ok: false, reason: 'misconfigured', detail: 'invalid_base_url' };
  const fetchImpl = request.fetchImpl ?? fetch;
  let sent = false;
  const result = await call((path, init) => {
    sent = true;
    return fetchImpl(`${endpoint}${path}`, {
      method: 'POST',
      headers: { ...init.headers, ...access.headers, authorization: `Bearer ${access.apiKey}` },
      body: init.body,
      // workerd refuses `redirect: 'error'` before the request leaves; the
      // caller refuses a redirect by its status instead.
      redirect: 'manual',
      signal: init.signal,
    });
  }, endpoint);
  if (!sent) return result;
  const sentRequest: SentRequest = {
    requestId: crypto.randomUUID(), route: grant.providerId, model, fundingSource: grant.fundingSource,
  };
  const attribution = cells.getStore()?.attribution ?? {
    installationId: usageInstallationId(env), runId: grant.runId, attemptId: crypto.randomUUID(), agentId: null,
  };
  await settleRecord(env, sentRequest, platformGrant, () => sentImageRequestRecord({
    requestId: sentRequest.requestId, attribution, provider: grant.providerId, model,
    fundingSource: grant.fundingSource, result, finishedAt: Date.now(),
  }));
  return result;
}

function keySafeEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}

async function resolveCell(
  grants: readonly ModelAccessGrant[],
  env: PlatformEnv | undefined,
  hosted: boolean,
  instanceId: string | undefined,
  runId: string,
  agentId: string | null,
): Promise<ModelAccessCell> {
  const bound = new Map<ModelAccessProviderId, BoundAccess>();
  for (const grant of grants) {
    const access = await requireResolver().resolve(grant, env);
    bound.set(grant.providerId, Object.freeze({ grant, access }));
  }
  const installationId = hosted ? installationScopeOf(env)?.installationId : undefined;
  const attribution = Object.freeze({
    installationId: usageInstallationId(env),
    runId,
    attemptId: crypto.randomUUID(),
    agentId,
  });
  return Object.freeze({ instanceId, hosted, installationId, bound, env, attribution });
}

function providerNotOffered(provider: string): ModelAccessError {
  return new ModelAccessError(
    'provider_not_offered',
    `Model provider ${provider} is not offered on a deployment serving many installations.`,
  );
}

interface ModelAccessRequest<TModel, TOptions> {
  model: TModel;
  options: TOptions;
  /** The provider's stream with the injected key removed from any error text. */
  redact(stream: AssistantMessageEventStream): AssistantMessageEventStream;
  /**
   * Sends the request once the cell's installation is admitted (cached for
   * 30 seconds) and, when Chickpea pays the provider, once the installation's
   * credits admit it. `start` receives the model to send: a platform-funded
   * OpenRouter model is capped at the price the request is charged. Refused,
   * nothing is sent and the stream ends in an error, as a provider failure
   * would; a customer-funded request of a cell with no installation sends at once.
   */
  send(start: (model: TModel) => AssistantMessageEventStream): AssistantMessageEventStream;
}

type SentRequest = Pick<ModelRequestEnd, 'requestId' | 'route' | 'model' | 'fundingSource'>;

interface ListPriceMode {
  pin(payload: Record<string, unknown>): Record<string, unknown>;
  readonly listPricedServiceTiers: readonly string[];
  readonly listPricedInferenceGeos: readonly string[];
}

const LIST_PRICE_MODES = {
  anthropic: {
    pin: ({ inference_geo: _geo, speed: _speed, ...payload }) => ({ ...payload, service_tier: 'standard_only' }),
    listPricedServiceTiers: ['standard'],
    // Older models serve without a region and report `not_available`.
    listPricedInferenceGeos: ['global', 'not_available'],
  },
  openai: {
    // The default, `auto`, takes the project's tier, which can be a priced one.
    pin: (payload) => ({ ...payload, service_tier: 'default' }),
    listPricedServiceTiers: ['default'],
    listPricedInferenceGeos: [],
  },
} satisfies Record<string, ListPriceMode>;

type ListPricedProvider = keyof typeof LIST_PRICE_MODES;

function listPricedProvider(providerId: string): ListPricedProvider | undefined {
  return Object.hasOwn(LIST_PRICE_MODES, providerId) ? providerId as ListPricedProvider : undefined;
}

/**
 * The request the proxy of registered provider `registeredId` sends: the
 * cell's key, endpoint and headers injected over whatever the caller passed,
 * or a refusal before egress. Every request needs a cell; one on a lane that
 * brings its own credential is sent as it is, and only from a standalone cell.
 */
export function modelAccessRequest<TModel extends Model<Api>, TOptions extends StreamOptions | undefined>(
  registeredId: string,
  model: TModel,
  options: TOptions,
): ModelAccessRequest<TModel, TOptions> {
  const cell = cells.getStore();
  if (!cell) throw new ModelAccessError('scope_missing', `No model access is in scope for provider ${registeredId}.`);
  const providerId = modelAccessProviderId(registeredId);
  if (!providerId && cell.hosted) throw providerNotOffered(registeredId);
  const bound = providerId ? cell.bound.get(providerId) : undefined;
  if (providerId && !bound) {
    throw new ModelAccessError(
      cell.bound.size ? 'provider_mismatch' : 'scope_missing',
      `No model access is in scope for provider ${providerId}.`,
    );
  }
  const request: SentRequest = {
    requestId: crypto.randomUUID(),
    route: registeredId,
    model: model.id,
    fundingSource: bound?.grant.fundingSource ?? 'customer',
  };
  const sent = bound?.access.baseUrl ? { ...model, baseUrl: bound.access.baseUrl } : model;
  const platformGrant = bound?.grant.fundingSource === 'platform' ? bound.grant : undefined;
  const listPriced = platformGrant && listPricedProvider(platformGrant.providerId);
  const reporting = providerId === 'openrouter' ? 'openrouter' : listPriced;
  const reader = reporting && providerReportReader(reporting, options?.fetch);
  const send = (start: (model: TModel) => AssistantMessageEventStream) =>
    sendRequest(cell, sent, request, platformGrant, reader, start);
  if (!bound) return { model, options, redact: (stream) => stream, send };
  const { access } = bound;
  return {
    model: sent,
    options: {
      ...options,
      apiKey: access.apiKey,
      ...(access.headers ? { headers: { ...options?.headers, ...access.headers } } : {}),
      ...(reader ? { fetch: reader.fetch } : {}),
      ...(listPriced ? { onPayload: listPricedPayload(options?.onPayload, LIST_PRICE_MODES[listPriced]) } : {}),
    } as TOptions,
    redact: (stream) => withoutKeyInErrors(stream, access.apiKey),
    send,
  };
}

function sendRequest<TModel extends Model<Api>>(
  cell: ModelAccessCell,
  model: TModel,
  request: SentRequest,
  platformGrant: ModelAccessGrant | undefined,
  reader: ProviderReportReader | undefined,
  start: (model: TModel) => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const { installationId } = cell;
  const settle = recorder || platformGrant ? settleRequest(cell, request, platformGrant, reader) : undefined;
  if (!installationId && !platformGrant) {
    const source = start(model);
    if (!settle) return source;
    const target = createAssistantMessageEventStream();
    void forwardStream(source, target, undefined, settle);
    return target;
  }
  const target = createAssistantMessageEventStream();
  void (async () => {
    let source: AssistantMessageEventStream;
    try {
      if (installationId) await requireInstallationAdmitted(installationId);
      source = start(platformGrant ? await platformFundedModel(platformGrant, model, request) : model);
    } catch (error) {
      const failed = errorMessageFor(model, error instanceof Error ? error.message : String(error));
      target.push({ type: 'error', reason: 'error', error: failed });
      target.end(failed);
      return;
    }
    await forwardStream(source, target, undefined, settle);
  })();
  return target;
}

/**
 * A platform-funded request's model, once it has a current list price to be
 * charged at and the installation's credits admit it. OpenRouter may serve a
 * model through several providers at different prices, so its request names
 * the most it may cost: the list price times the host's multiplier, the
 * price it is charged.
 */
async function platformFundedModel<TModel extends Model<Api>>(
  grant: ModelAccessGrant,
  model: TModel,
  request: SentRequest,
): Promise<TModel> {
  const provider = canonicalPriceProviderId(request.route);
  const price = priceCatalogFor('standard_input_output', provider, request.model, Date.now());
  if (!price || Date.now() >= price.version.staleAfter) throw unpricedModel();
  await requirePlatformFundingAdmitted(grant, { provider, model: request.model });
  if (provider !== 'openrouter') return model;
  const multiplier = await platformPriceMultiplier(grant);
  // A long prompt is charged at the long-context rates, so the cap allows them.
  const perMillionTokens = (standard: number, longContext = 0) =>
    Math.ceil(Math.max(standard, longContext) * multiplier) / price.rate.unitScale;
  const { rate } = price;
  return {
    ...model,
    compat: {
      ...model.compat,
      openRouterRouting: {
        ...(model.compat as OpenAICompletionsCompat | undefined)?.openRouterRouting,
        max_price: {
          prompt: perMillionTokens(rate.inputMicrosPerUnit, rate.longContext?.inputMicrosPerUnit),
          completion: perMillionTokens(rate.outputMicrosPerUnit, rate.longContext?.outputMicrosPerUnit),
        },
      },
    },
  };
}

function unpricedModel(): ModelAccessError {
  // No model ID in the text: Flue retries an error whose text holds a status code such as 503.
  return new ModelAccessError('funding_not_offered', 'This model has no current price in Chickpea credits (funding_not_offered).');
}

function settleRequest(
  cell: ModelAccessCell,
  request: SentRequest,
  platformGrant: ModelAccessGrant | undefined,
  reader: ProviderReportReader | undefined,
): (final: AssistantMessage) => Promise<void> {
  const listPriced = platformGrant && listPricedProvider(platformGrant.providerId);
  const mode = listPriced && LIST_PRICE_MODES[listPriced];
  return (final) => settleRecord(cell.env, request, platformGrant, async () => {
    const finishedAt = Date.now();
    const report = await reader?.report() ?? NO_PROVIDER_REPORT;
    const record = modelRequestRecord({ ...request, attribution: cell.attribution, message: final, ...report, finishedAt });
    const offListPrice = mode &&
      (offList(record.providerServiceTier, mode.listPricedServiceTiers) ||
        offList(record.providerInferenceGeo, mode.listPricedInferenceGeos));
    if (offListPrice) {
      console.warn('[chickpea] platform-funded model request served off list price', {
        route: request.route,
        model: request.model,
        requestId: request.requestId,
        serviceTier: record.providerServiceTier,
        inferenceGeo: record.providerInferenceGeo,
      });
    }
    return record;
  });
}

function offList(reported: string | null, listPriced: readonly string[]): boolean {
  return reported !== null && !listPriced.includes(reported);
}

function listPricedPayload(
  callerHook: StreamOptions['onPayload'],
  mode: ListPriceMode,
): NonNullable<StreamOptions['onPayload']> {
  return async (payload, model) => {
    const returned = await callerHook?.(payload, model);
    const composed = returned === undefined ? payload : returned;
    if (!isRecord(composed)) throw new Error('A platform-funded request payload is not an object.');
    return mode.pin(composed);
  };
}

async function settleRecord(
  env: PlatformEnv | undefined,
  request: SentRequest,
  platformGrant: ModelAccessGrant | undefined,
  build: () => ModelRequestRecord | Promise<ModelRequestRecord>,
): Promise<void> {
  const writeRecord = recorder;
  if (!writeRecord && !platformGrant) return;
  const record = Promise.resolve().then(build);
  const settled = [
    writeRecord && record.then((built) => writeRecord(built, env))
      .catch((error: unknown) => logSettleFailure('record', request, error)),
    platformGrant && record.then((built) => chargePlatformRequest(platformGrant, built))
      .catch((error: unknown) => logSettleFailure('charge', request, error)),
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RECORD_BUDGET_MS);
  });
  await Promise.race([Promise.all(settled), budget]);
  clearTimeout(timer);
}

function logSettleFailure(step: 'record' | 'charge', request: SentRequest, error: unknown): void {
  console.warn(`[chickpea] model request ${step} failed`, {
    route: request.route,
    model: request.model,
    requestId: request.requestId,
    error: errorKind(error),
  });
}

function errorKind(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string') return code;
    if (typeof name === 'string') return name;
  }
  return typeof error;
}

function errorMessageFor(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    stopReason: 'error', errorMessage, timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

/**
 * A provider may echo a rejected key in its error text, which Flue records in
 * the conversation. The proxy knows the key it sent, so it removes it there.
 */
function withoutKeyInErrors(source: AssistantMessageEventStream, apiKey: string): AssistantMessageEventStream {
  if (apiKey.length < 8) return source;
  const redacted = (message: AssistantMessage): AssistantMessage =>
    message.errorMessage?.includes(apiKey)
      ? { ...message, errorMessage: message.errorMessage.replaceAll(apiKey, '[redacted]') }
      : message;
  const target = createAssistantMessageEventStream();
  void forwardStream(source, target, redacted);
  return target;
}

/**
 * Forward a provider stream into another, passing each error and the final
 * result through `map` when one is given; without it every event passes as
 * it is. As Pi forwards a stream, the final result is read last, since it
 * may arrive without an event. With `settle`, the terminal event is held until
 * it has run on the final result: pushing that event resolves the caller's
 * `result()`, after which the caller may finish and the isolate may go.
 */
async function forwardStream(
  source: AssistantMessageEventStream,
  target: AssistantMessageEventStream,
  map?: (message: AssistantMessage) => AssistantMessage,
  settle?: (final: AssistantMessage) => Promise<void>,
): Promise<void> {
  let terminal: AssistantMessageEvent | undefined;
  for await (const event of source) {
    const forwarded = map && event.type === 'error' ? { ...event, error: map(event.error) } : event;
    if (settle && (event.type === 'done' || event.type === 'error')) terminal = forwarded;
    else target.push(forwarded);
  }
  const result = await source.result();
  if (settle) {
    await settle(result);
    if (terminal) target.push(terminal);
  }
  target.end(map ? map(result) : result);
}

export function resetModelAccessForTests(): void {
  resolver = undefined;
  recorder = undefined;
}
