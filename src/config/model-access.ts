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
 * sends no further request (see installation-admission.ts). Image generation
 * is the exception: its client calls the provider outside the proxy, from a
 * tool call inside an attempt whose start was admitted.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type StreamOptions,
} from '@earendil-works/pi-ai';
import type { FlueExecutionContext, FlueExecutionInterceptor } from '@flue/runtime';

import { requireInstallationAdmitted } from './installation-admission.ts';
import { deploymentServesManyInstallations, installationScopeOf } from './installation-scope.ts';
import type { PlatformEnv } from './state-backend.ts';
import {
  ANTHROPIC_COMPAT_PROVIDER_ID,
  OPENAI_PLATFORM_COMPAT_PROVIDER_ID,
  isRevisionedAlias,
} from '../model-catalog/provider-alias.ts';

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
  /** Platform-funded access arrives with included usage; no binding implies it. */
  readonly fundingSource: 'customer';
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
}

const cells = new AsyncLocalStorage<ModelAccessCell>();
let resolver: ModelAccessResolver | undefined;

/** The composition seam: the deployment's resolver, installed before any model call. */
export function configureModelAccessResolver(next: ModelAccessResolver): void {
  resolver = next;
}

export function modelAccessResolverConfigured(): boolean {
  return resolver !== undefined;
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
  | { readonly env: PlatformEnv | undefined; readonly grant: ModelAccessGrant }
  /** The run's model brings its own deployment credential (standalone lanes only). */
  | { readonly env: PlatformEnv | undefined; readonly deploymentLane: true }
  /** An agent with no persisted run of its own (the coding worker). */
  | { readonly env: PlatformEnv | undefined };

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
    let grants: readonly ModelAccessGrant[] = [];
    if ('grant' in attempt) {
      grants = [attempt.grant];
    } else if (!('deploymentLane' in attempt) && !hosted) {
      grants = await options.installationGrants(attempt.env, context.submissionId ?? context.instanceId ?? 'attempt');
    }
    return cells.run(await resolveCell(grants, attempt.env, hosted, context.instanceId), next);
  };
}

/** A stateless call runs inside an explicit grant, resolved once. */
export async function withModelAccess<T>(
  grant: ModelAccessGrant,
  env: PlatformEnv | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return cells.run(await resolveCell([grant], env, deploymentServesManyInstallations(env), undefined), fn);
}

/**
 * A stateless call on a lane that brings its own deployment credential
 * (Workers AI, a subscription): offered only on standalone.
 */
export async function withDeploymentLane<T>(env: PlatformEnv | undefined, fn: () => Promise<T>): Promise<T> {
  if (deploymentServesManyInstallations(env)) throw providerNotOffered('this provider');
  return cells.run(await resolveCell([], env, false, undefined), fn);
}

/** The access for one grant, for a model client outside the provider proxy (image generation). */
export function resolveModelAccessGrant(
  grant: ModelAccessGrant,
  env: PlatformEnv | undefined,
): Promise<ResolvedModelAccess> {
  return requireResolver().resolve(grant, env);
}

async function resolveCell(
  grants: readonly ModelAccessGrant[],
  env: PlatformEnv | undefined,
  hosted: boolean,
  instanceId: string | undefined,
): Promise<ModelAccessCell> {
  const bound = new Map<ModelAccessProviderId, BoundAccess>();
  for (const grant of grants) {
    const access = await requireResolver().resolve(grant, env);
    bound.set(grant.providerId, Object.freeze({ grant, access }));
  }
  const installationId = hosted ? installationScopeOf(env)?.installationId : undefined;
  return Object.freeze({ instanceId, hosted, installationId, bound });
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
   * 30 seconds). Refused, nothing is sent and the stream ends in an error, as
   * a provider failure would; a cell with no installation sends at once.
   */
  admit(send: () => AssistantMessageEventStream): AssistantMessageEventStream;
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
  const admit = (send: () => AssistantMessageEventStream) =>
    cell.installationId ? admittedStream(cell.installationId, model, send) : send();
  if (!providerId) {
    if (cell.hosted) throw providerNotOffered(registeredId);
    return { model, options, redact: (stream) => stream, admit };
  }
  const bound = cell.bound.get(providerId);
  if (!bound) {
    throw new ModelAccessError(
      cell.bound.size ? 'provider_mismatch' : 'scope_missing',
      `No model access is in scope for provider ${providerId}.`,
    );
  }
  const { access } = bound;
  return {
    model: access.baseUrl ? { ...model, baseUrl: access.baseUrl } : model,
    options: {
      ...options,
      apiKey: access.apiKey,
      ...(access.headers ? { headers: { ...options?.headers, ...access.headers } } : {}),
    } as TOptions,
    redact: (stream) => withoutKeyInErrors(stream, access.apiKey),
    admit,
  };
}

/** The request's stream once the installation is admitted; refused, an error with nothing sent. */
function admittedStream(
  installationId: string,
  model: Model<Api>,
  send: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const target = createAssistantMessageEventStream();
  void (async () => {
    let source: AssistantMessageEventStream;
    try {
      await requireInstallationAdmitted(installationId);
      source = send();
    } catch (error) {
      const failed = errorMessageFor(model, error instanceof Error ? error.message : String(error));
      target.push({ type: 'error', reason: 'error', error: failed });
      target.end(failed);
      return;
    }
    await forwardStream(source, target);
  })();
  return target;
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
 * result through `map`. As Pi forwards a stream, the final result is read
 * last, since it may arrive without an event.
 */
async function forwardStream(
  source: AssistantMessageEventStream,
  target: AssistantMessageEventStream,
  map: (message: AssistantMessage) => AssistantMessage = (message) => message,
): Promise<void> {
  for await (const event of source) {
    target.push(event.type === 'error' ? { ...event, error: map(event.error) } : event);
  }
  target.end(map(await source.result()));
}

export function resetModelAccessForTests(): void {
  resolver = undefined;
}
