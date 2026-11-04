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
import { requireInstallationScope } from './installation-scope.ts';
import type { ModelAccessGrant } from './model-access.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { SharedPrefixId } from '../agents/shared-prefix.ts';
import type { ModelRequestFundingSource, ModelRequestRecord } from '../usage/model-requests.ts';
import type { UsageMicros } from '../usage/usage-display.ts';

/**
 * Platform-funded usage is paused until `resumesAt` by a daily cap, even
 * though credits may remain.
 */
export interface DailyLimitAdmission {
  readonly kind: 'daily_limit';
  /** `workspace`: this installation's own daily cap. `fleet`: the host paused this usage for every installation. */
  readonly scope: DailyLimitScope;
  /** When platform-funded usage may resume, epoch milliseconds. */
  readonly resumesAt: number;
}

export const DAILY_LIMIT_SCOPES = ['workspace', 'fleet'] as const;
export type DailyLimitScope = typeof DAILY_LIMIT_SCOPES[number];

export function isDailyLimitScope(value: unknown): value is DailyLimitScope {
  return DAILY_LIMIT_SCOPES.includes(value as DailyLimitScope);
}

/** Why platform-funded work is refused. */
export type PlatformFundingRefusal = 'credits_exhausted' | DailyLimitAdmission;

export type PlatformFundingAdmission = 'admitted' | PlatformFundingRefusal;

/** `provider` is the price catalog's id for the request's route, as the request's record names it. */
export interface PlatformFundedModel {
  readonly provider: string;
  readonly model: string;
}

/** One run as the ledger keys it: the run ID its model request records carry. */
export interface RunRef {
  readonly installationId: string;
  readonly runId: string;
}

export type FeeTier = 'chat' | 'task';

export interface FeePost extends RunRef {
  readonly tier: FeeTier;
  readonly agentId: string | null;
}

export type FeeOutcome =
  | { readonly kind: 'posted' }
  | { readonly kind: 'duplicate' }
  /** No fee on this installation under the rate card in effect. */
  | { readonly kind: 'not_applicable' }
  /** Task tier only: the spendable balance is not above zero, so the row was not written. */
  | { readonly kind: 'refused' };

export type CreditBackReason = 'provider' | 'timeout' | 'sandbox' | 'evicted' | 'chickpea';

export type CreditBackOutcome =
  | { readonly kind: 'credited'; readonly usageMicros: UsageMicros }
  | { readonly kind: 'duplicate'; readonly usageMicros: UsageMicros }
  /** The run posted no rows. */
  | { readonly kind: 'nothing' };

export interface PlatformFundingPort {
  /** Whether the installation's model requests are paid from its credits. */
  funding(installationId: string): Promise<ModelRequestFundingSource>;
  /**
   * Before a platform-funded request, unless one of the installation's was
   * admitted in the last 30 seconds: `credits_exhausted` unless the balance
   * is above zero, or a daily limit until its usage resumes.
   */
  admit(grant: ModelAccessGrant, model: PlatformFundedModel): Promise<PlatformFundingAdmission>;
  /**
   * Once per finished platform-funded request, and once more if that fails;
   * `record.requestId` is the idempotency key. `listPriceUsdMicros` is null
   * when Core could not price the usage, and `priceUnknownReason` says why.
   * `sharedPrefix` is the shared prompt prefix the request carried with an
   * hour's cache, or null.
   */
  charge(record: ModelRequestRecord, sharedPrefix: SharedPrefixId | null): Promise<void>;
  /**
   * A run's chat row as each attempt starts and its task row at its first
   * qualifying action, on platform-funded and own-key installations alike.
   * Idempotent on `(installationId, runId, tier)`: every attempt posts again.
   */
  postFee(post: FeePost): Promise<FeeOutcome>;
  /**
   * Before a reply run's first qualifying tool call, once per attempt.
   * Read-only: writes no row. `refused` exactly when a task-tier `postFee`
   * for the run would answer `refused`; a daily limit refuses with its own reason.
   */
  admitTask(run: RunRef): Promise<TaskAdmission>;
  /** Restores what a run that failed on Chickpea's side was charged. Idempotent per run. */
  creditBack(run: RunRef, reason: CreditBackReason): Promise<CreditBackOutcome>;
}

export type TaskAdmission = 'admitted' | 'refused' | DailyLimitAdmission;

export const CREDITS_EXHAUSTED_CODE = 'credits_exhausted';
export const DAILY_LIMIT_CODE = 'daily_limit';

/** The installation's credits are spent: the request is refused before it is sent. */
export class CreditsExhaustedError extends Error {
  readonly name = 'CreditsExhaustedError';
  readonly code = CREDITS_EXHAUSTED_CODE;
  constructor() {
    super(`This installation is out of Chickpea credits (${CREDITS_EXHAUSTED_CODE}).`);
  }
}

/**
 * A daily limit paused the installation's platform-funded usage: the request
 * is refused before it is sent. The message carries the code, the scope and
 * the resume time in epoch seconds, since a Flue failure keeps only its text
 * (see dailyLimitOf).
 */
export class DailyLimitError extends Error {
  readonly name = 'DailyLimitError';
  readonly code = DAILY_LIMIT_CODE;
  readonly limit: DailyLimitAdmission;
  constructor(limit: Pick<DailyLimitAdmission, 'scope' | 'resumesAt'>) {
    super('Platform-funded usage is paused by a daily limit ' +
      `(${DAILY_LIMIT_CODE}:${limit.scope}:${Math.floor(limit.resumesAt / 1000)}).`);
    this.limit = { kind: DAILY_LIMIT_CODE, scope: limit.scope, resumesAt: limit.resumesAt };
  }
}

export function platformFundingRefusalError(refusal: PlatformFundingRefusal): CreditsExhaustedError | DailyLimitError {
  return refusal === CREDITS_EXHAUSTED_CODE ? new CreditsExhaustedError() : new DailyLimitError(refusal);
}

/** The host could not say whether a platform-funded request may be sent or what it costs. */
export class PlatformFundingUnavailableError extends Error {
  readonly name = 'PlatformFundingUnavailableError';
  readonly code = 'credits_unavailable';
  constructor(cause?: unknown) {
    super('Chickpea credits could not be checked (credits_unavailable).', cause === undefined ? undefined : { cause });
  }
}

export const PLATFORM_ADMISSION_TTL_MS = 30_000;
const PORT_CALL_BUDGET_MS = 2_000;
const MAX_CACHED_INSTALLATIONS = 1_024;
const LOG_INTERVAL_MS = 60_000;

let port: PlatformFundingPort | undefined;
let clock: () => number = Date.now;
const admittedAt = new Map<string, number>();
/**
 * Advanced by every refusal and lost charge, so an admission read already in
 * flight is not cached over it; another installation's read is just asked again.
 */
let refusals = 0;
const loggedAt = new Map<string, number>();

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

/**
 * The funding an installation's runs freeze. A port that cannot answer leaves
 * the installation on its own key, so an outage never blocks an installation
 * that brings one; one that has none gets the usual missing-key refusal.
 */
export async function installationFunding(env: PlatformEnv | undefined): Promise<ModelRequestFundingSource> {
  const current = port;
  const installationId = current ? requireInstallationScope(env)?.installationId : undefined;
  if (!current || !installationId) return 'customer';
  try {
    return await current.funding(installationId) === 'platform' ? 'platform' : 'customer';
  } catch {
    logAtMostEachMinute('funding_unavailable');
    return 'customer';
  }
}

export async function requirePlatformFundingAdmitted(
  grant: ModelAccessGrant,
  model: PlatformFundedModel,
): Promise<void> {
  const { installationId } = grant;
  const at = admittedAt.get(installationId);
  if (at !== undefined && clock() - at < PLATFORM_ADMISSION_TTL_MS) return;
  const current = port;
  const refusalsBefore = refusals;
  let admission: PlatformFundingAdmission;
  try {
    if (!current) throw new Error('No platform funding port is configured.');
    admission = await current.admit(grant, model);
  } catch (error) {
    throw new PlatformFundingUnavailableError(error);
  }
  if (admission !== 'admitted') {
    forgetAdmission(installationId);
    throw admission === CREDITS_EXHAUSTED_CODE || isDailyLimitAdmission(admission)
      ? platformFundingRefusalError(admission)
      : new PlatformFundingUnavailableError();
  }
  // A port replaced, or a refusal answered, while this read was in flight wins over it.
  if (port !== current || refusals !== refusalsBefore) return;
  admittedAt.delete(installationId);
  admittedAt.set(installationId, clock());
  if (admittedAt.size > MAX_CACHED_INSTALLATIONS) {
    const oldest = admittedAt.keys().next();
    if (!oldest.done) admittedAt.delete(oldest.value);
  }
}

/**
 * Charges one finished request, trying once more when the first charge fails;
 * the port takes `record.requestId` as its idempotency key, so a retry never
 * charges twice. A charge that still fails is lost (an undercharge), and the
 * installation's next request asks the port again instead of a cached answer.
 */
export async function chargePlatformRequest(
  grant: ModelAccessGrant,
  record: ModelRequestRecord,
  sharedPrefix: SharedPrefixId | null,
): Promise<void> {
  const charge = async () => {
    if (!port) throw new Error('No platform funding port is configured.');
    await port.charge(record, sharedPrefix);
  };
  try {
    await charge().catch(charge);
  } catch (error) {
    forgetAdmission(grant.installationId);
    throw error;
  }
}

/** The host did not answer a fee post in time, or failed; the row may be lost. */
export const FEE_UNANSWERED = { kind: 'unanswered' } as const;

export async function postRunFee(post: FeePost): Promise<FeeOutcome | typeof FEE_UNANSWERED> {
  return (await askWithinBudget((current) => current.postFee(post), { event: 'fee_post_failed', tier: post.tier }))
    ?? FEE_UNANSWERED;
}

/**
 * A host that does not answer in time, fails, or is not configured admits: a
 * slow ledger never blocks a task. So does a malformed daily limit; the
 * run's next model request asks `admit`, which refuses one.
 */
export async function admitRunTask({ installationId, runId }: RunRef): Promise<TaskAdmission> {
  const answer = await askWithinBudget((current) => current.admitTask({ installationId, runId }),
    { event: 'task_admission_failed' });
  if (answer === 'refused' || isDailyLimitAdmission(answer)) return answer;
  if (answer !== undefined && answer !== 'admitted') {
    console.warn(JSON.stringify({ component: 'platform_funding', event: 'task_admission_failed', error: 'malformed' }));
  }
  return 'admitted';
}

export function creditBackRun(run: RunRef, reason: CreditBackReason): Promise<CreditBackOutcome | undefined> {
  return askWithinBudget((current) => current.creditBack(run, reason), { event: 'credit_back_failed', reason });
}

const UNANSWERED_IN_TIME = Symbol('unanswered in time');

async function askWithinBudget<T>(
  ask: (current: PlatformFundingPort) => Promise<T>,
  failure: { readonly event: string } & Readonly<Record<string, string>>,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof UNANSWERED_IN_TIME>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED_IN_TIME), PORT_CALL_BUDGET_MS);
  });
  let error: string;
  try {
    if (!port) throw new Error('No platform funding port is configured.');
    const answer = await Promise.race([ask(port), budget]);
    if (answer !== UNANSWERED_IN_TIME) return answer;
    error = 'timeout';
  } catch (caught) {
    error = caught instanceof Error ? caught.name : typeof caught;
  } finally {
    clearTimeout(timer);
  }
  console.warn(JSON.stringify({ component: 'platform_funding', ...failure, error }));
  return undefined;
}

function forgetAdmission(installationId: string): void {
  admittedAt.delete(installationId);
  refusals += 1;
}

/** Content-free: names no installation. */
function logAtMostEachMinute(event: string): void {
  const at = clock();
  if (at - (loggedAt.get(event) ?? Number.NEGATIVE_INFINITY) < LOG_INTERVAL_MS) return;
  loggedAt.set(event, at);
  console.warn(JSON.stringify({ component: 'platform_funding', event }));
}

/**
 * Whether an error is Chickpea's credits refusal, however it travelled: a Flue
 * failure carries only its text, so the parenthesized code in a message counts.
 * Without a port nothing refuses for credits, so a provider's own error that
 * uses the word is never taken for one.
 */
export function isCreditsExhausted(error: unknown): boolean {
  return port !== undefined && errorChainIncludes(error, (link) => link instanceof CreditsExhaustedError ||
    (typeof link.message === 'string' && link.message.includes(`(${CREDITS_EXHAUSTED_CODE})`)));
}

/**
 * The daily limit an error reports, however it travelled: the error itself,
 * or the `(daily_limit:SCOPE:SECONDS)` a Flue failure's text carries.
 * Undefined for anything else, and, as with isCreditsExhausted, always
 * without a port.
 */
export function dailyLimitOf(error: unknown): DailyLimitAdmission | undefined {
  if (port === undefined) return undefined;
  let limit: DailyLimitAdmission | undefined;
  errorChainIncludes(error, (link) => {
    limit = link instanceof DailyLimitError
      ? link.limit
      : typeof link.message === 'string' ? dailyLimitInText(link.message) : undefined;
    return limit !== undefined;
  });
  return limit;
}

const DAILY_LIMIT_TEXT = /\(daily_limit:([a-z]+):(\d{1,13})\)/;

function dailyLimitInText(message: string): DailyLimitAdmission | undefined {
  const match = DAILY_LIMIT_TEXT.exec(message);
  const limit = match && { kind: DAILY_LIMIT_CODE, scope: match[1], resumesAt: Number(match[2]) * 1000 };
  return isDailyLimitAdmission(limit) ? limit : undefined;
}

/** The port is the host's boundary: a daily limit Core cannot say the scope and time of is no answer. */
function isDailyLimitAdmission(value: unknown): value is DailyLimitAdmission {
  if (typeof value !== 'object' || value === null) return false;
  const { kind, scope, resumesAt } = value as Partial<Record<keyof DailyLimitAdmission, unknown>>;
  return kind === DAILY_LIMIT_CODE && isDailyLimitScope(scope) && validResumesAt(resumesAt);
}

/** Whole epoch milliseconds a Date can hold. */
function validResumesAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= MAX_DATE_MS;
}

const MAX_DATE_MS = 8.64e15;

export function resetPlatformFundingForTests(options: { now?: () => number } = {}): void {
  configurePlatformFunding(undefined);
  clock = options.now ?? Date.now;
  loggedAt.clear();
}
