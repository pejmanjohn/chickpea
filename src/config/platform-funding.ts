/**
 * Platform funding: model requests Chickpea pays its providers for, drawn
 * from an installation's prepaid credits instead of the installation's key.
 *
 * The host decides per installation through one port it installs at module
 * scope. Core asks it which funding an installation's runs freeze, admits
 * each platform-funded request against the balance before the proxy sends
 * it, and charges each finished request once from its request record.
 * Standalone, and any deployment with no port installed, is customer-funded.
 *
 * Fail closed. Unlike installation admission, a check that cannot be read
 * refuses the request. A positive answer serves an installation for at most
 * 30 seconds; a refusal is never reused, so added credits apply at once.
 */
import { errorChainIncludes } from './error-chain.ts';
import { deploymentServesManyInstallations, requireInstallationScope } from './installation-scope.ts';
import type { ModelAccessGrant } from './model-access.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { ModelRequestFundingSource, ModelRequestRecord } from '../usage/model-requests.ts';

export type PlatformFundingAdmission = 'admitted' | 'credits_exhausted';

/** A platform-funded request's model, as its request record and the price catalog name it. */
export interface PlatformFundedModel {
  readonly provider: string;
  readonly model: string;
}

export interface PlatformFundingPort {
  /** Whether the installation's model requests are paid from its credits. */
  funding(installationId: string): Promise<ModelRequestFundingSource>;
  /** Before each platform-funded request: `credits_exhausted` unless the balance is above zero. */
  admit(grant: ModelAccessGrant, model: PlatformFundedModel): Promise<PlatformFundingAdmission>;
  /** Once per finished platform-funded request; `record.requestId` is the idempotency key. */
  charge(record: ModelRequestRecord): Promise<void>;
  /** What a platform-funded request is charged per unit of list price, from the host's rate card. */
  priceMultiplier(grant: ModelAccessGrant): Promise<number>;
}

export const CREDITS_EXHAUSTED_CODE = 'credits_exhausted';

/** The installation's credits are spent: the request is refused before it is sent. */
export class CreditsExhaustedError extends Error {
  readonly name = 'CreditsExhaustedError';
  readonly code = CREDITS_EXHAUSTED_CODE;
  constructor() {
    super(`This installation is out of Chickpea credits (${CREDITS_EXHAUSTED_CODE}).`);
  }
}

/** The host could not say whether a platform-funded request may be sent or what it costs. */
export class PlatformFundingUnavailableError extends Error {
  readonly name = 'PlatformFundingUnavailableError';
  readonly code = 'credits_unavailable';
  constructor(cause?: unknown) {
    super('Chickpea credits could not be checked (credits_unavailable).', cause === undefined ? undefined : { cause });
  }
}

/** How long one positive answer serves an installation in this isolate. */
export const PLATFORM_ADMISSION_TTL_MS = 30_000;
const MAX_CACHED_INSTALLATIONS = 1_024;

let port: PlatformFundingPort | undefined;
let clock: () => number = Date.now;
const admittedAt = new Map<string, number>();

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configurePlatformFunding(next: PlatformFundingPort | undefined): void {
  port = next;
  admittedAt.clear();
}

export function platformFundingConfigured(): boolean {
  return port !== undefined;
}

/** The credential a platform-funded run freezes for a provider: never a key the installation saved. */
export function platformCredentialRefId(providerId: string): string {
  return `platform:${providerId}`;
}

export function credentialFundingSource(
  credential: { readonly credentialRefId: string; readonly providerId: string },
): ModelRequestFundingSource {
  return credential.credentialRefId === platformCredentialRefId(credential.providerId) ? 'platform' : 'customer';
}

/** The funding an installation's runs freeze: customer unless the host's port says platform. */
export async function installationFunding(env: PlatformEnv | undefined): Promise<ModelRequestFundingSource> {
  const current = port;
  if (!current || !deploymentServesManyInstallations(env)) return 'customer';
  const installationId = requireInstallationScope(env)?.installationId;
  if (!installationId) return 'customer';
  return await current.funding(installationId) === 'platform' ? 'platform' : 'customer';
}

/** Throws unless the host admits a platform-funded request now. */
export async function requirePlatformFundingAdmitted(
  grant: ModelAccessGrant,
  model: PlatformFundedModel,
): Promise<void> {
  const { installationId } = grant;
  const at = admittedAt.get(installationId);
  if (at !== undefined && clock() - at < PLATFORM_ADMISSION_TTL_MS) return;
  const current = port;
  let admission: PlatformFundingAdmission;
  try {
    if (!current) throw new Error('No platform funding port is configured.');
    admission = await current.admit(grant, model);
  } catch (error) {
    throw new PlatformFundingUnavailableError(error);
  }
  if (admission !== 'admitted') {
    admittedAt.delete(installationId);
    throw admission === CREDITS_EXHAUSTED_CODE ? new CreditsExhaustedError() : new PlatformFundingUnavailableError();
  }
  // A port replaced while this read was in flight does not answer for it.
  if (port !== current) return;
  admittedAt.delete(installationId);
  admittedAt.set(installationId, clock());
  if (admittedAt.size > MAX_CACHED_INSTALLATIONS) {
    const oldest = admittedAt.keys().next();
    if (!oldest.done) admittedAt.delete(oldest.value);
  }
}

/** The host's multiplier over list price, refused unless it is a positive number. */
export async function platformPriceMultiplier(grant: ModelAccessGrant): Promise<number> {
  let multiplier: number;
  try {
    if (!port) throw new Error('No platform funding port is configured.');
    multiplier = await port.priceMultiplier(grant);
  } catch (error) {
    throw new PlatformFundingUnavailableError(error);
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) throw new PlatformFundingUnavailableError();
  return multiplier;
}

export async function chargePlatformRequest(record: ModelRequestRecord): Promise<void> {
  if (!port) throw new Error('No platform funding port is configured.');
  await port.charge(record);
}

/** Whether an error is a credits refusal, however it travelled (a Flue failure carries only its text). */
export function isCreditsExhausted(error: unknown): boolean {
  return errorChainIncludes(error, (link) => link instanceof CreditsExhaustedError ||
    [link.message, link.type].some((text) => typeof text === 'string' && text.includes(CREDITS_EXHAUSTED_CODE)));
}

export function resetPlatformFundingForTests(options: { now?: () => number } = {}): void {
  configurePlatformFunding(undefined);
  clock = options.now ?? Date.now;
}
