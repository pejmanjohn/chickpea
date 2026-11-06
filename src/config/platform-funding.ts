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

/**
 * Why a workspace is out of usage, as the host chooses it, so the reply can
 * say why. Each kind lists the amounts its words name: `plansFromCents` the
 * lowest monthly plan price the workspace may choose, `bonusPercent` how much
 * more usage than its price every plan includes, `limitCents` auto top-up's
 * monthly limit. An amount is whole US cents or percent; the reply leaves out
 * a sentence whose amount is missing.
 */
const OUT_OF_USAGE_CAUSES = {
  /** The free trial's usage is used up. */
  trial_used: ['plansFromCents', 'bonusPercent'],
  /** The free trial ended by date. */
  trial_ended: ['plansFromCents', 'bonusPercent'],
  /** The plan's usage is used, and auto top-up is off. */
  plan_used: [],
  /** Auto top-up reached its monthly limit. */
  top_up_limit: ['limitCents'],
  /** Auto top-up's charge was declined. */
  top_up_declined: [],
  /** Auto top-up's charge waits for the bank's confirmation (SCA). */
  top_up_unconfirmed: [],
  /** A workspace on its own key used this month's tasks. */
  own_key_tasks_used: [],
  /** A workspace on its own key has no plan, which tasks need. */
  own_key_no_plan: ['plansFromCents'],
} as const satisfies Record<string, readonly OutOfUsageAmount[]>;

type OutOfUsageAmount = 'plansFromCents' | 'bonusPercent' | 'limitCents';
export type OutOfUsageCauseKind = keyof typeof OUT_OF_USAGE_CAUSES;
export const OUT_OF_USAGE_CAUSE_KINDS = Object.keys(OUT_OF_USAGE_CAUSES) as OutOfUsageCauseKind[];
export type OutOfUsageCause = {
  [K in OutOfUsageCauseKind]: { readonly kind: K } &
    { readonly [A in (typeof OUT_OF_USAGE_CAUSES)[K][number]]?: number };
}[OutOfUsageCauseKind];

/** The workspace is out of usage. Without a cause the reply says so in general words. */
export interface OutOfUsage {
  readonly kind: typeof CREDITS_EXHAUSTED_CODE;
  readonly cause?: OutOfUsageCause;
}

/** Why platform-funded work is refused. */
export type PlatformFundingRefusal = OutOfUsage | DailyLimitAdmission;

/**
 * `pending`: a top-up charge is in flight. Core asks again each second, for
 * up to 10 seconds from its first ask, then refuses as out of usage with no
 * cause. A bare `credits_exhausted` is out of usage with no cause.
 */
export type PlatformFundingAdmission = 'admitted' | 'pending' | typeof CREDITS_EXHAUSTED_CODE | PlatformFundingRefusal;

/**
 * Where a platform-funded request falls in its attempt. `start` is the
 * attempt's first request: it admits the run. `continue` is every later
 * one, which an admitted run sends. A host refuses `start` once the balance
 * is not above zero; it lets an admitted run `continue` past zero, down to
 * its overdraw ceiling, and keeps a trial's daily caps on every request. A
 * retried or resumed attempt starts again, and `grant.runId` names the run,
 * so a host may let a run it admitted before continue.
 *
 * Core keeps a positive answer for 30 seconds per installation. A `start`
 * reuses only a `start` admission; a `continue` reuses either. An attempt
 * asks as `continue` only once the host itself admitted one of its requests,
 * so neither a busy workspace's running work nor a cached answer lets a new
 * run go on past zero. An attempt whose first request a cached answer
 * served asks the host `start` with its next one.
 */
export type AdmissionStage = 'start' | 'continue';

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
  /**
   * Task tier only: the row was not written, and the run may not become a
   * task. `cause` says why, as `admit`'s refusal does. Core stops a reply
   * run before its next request, but still delivers a routine's finished
   * output (see postFee).
   */
  | { readonly kind: 'refused'; readonly cause?: OutOfUsageCause };

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
   * Before a platform-funded request, unless Core reuses a positive answer
   * (see AdmissionStage): out of usage, with its cause, by the rules of the
   * request's stage; a daily limit until its usage resumes; or `pending`. A
   * host that ignores `stage` admits every request as a `start`.
   */
  admit(grant: ModelAccessGrant, model: PlatformFundedModel, stage: AdmissionStage): Promise<PlatformFundingAdmission>;
  /**
   * Once per finished platform-funded request, and once more if that fails;
   * `record.requestId` is the idempotency key. `listPriceUsdMicros` is null
   * when Core could not price the usage, and `priceUnknownReason` says why.
   * `sharedPrefix` is the shared prompt prefix the request carried with an
   * hour's cache, or null.
   */
  charge(record: ModelRequestRecord, sharedPrefix: SharedPrefixId | null): Promise<void>;
  /**
   * A run's chat row as each attempt starts, and its task row at a reply's
   * first qualifying action or as a routine delivers its output, on
   * platform-funded and own-key installations alike. Idempotent on
   * `(installationId, runId, tier)`: every attempt posts again. Every task
   * post follows the run's `admitTask`, so the host may write it as debt
   * below zero. A routine's output is delivered whatever its post answers.
   */
  postFee(post: FeePost): Promise<FeeOutcome>;
  /**
   * Read-only: writes no row. Once per attempt, before a reply run's first
   * qualifying tool call and before a routine run's first model request.
   * Core also asks it for an `ask_owner_…` run ID that names no run, to tell
   * an Owner who clicks Ask an Owner, and the Owners it DMs, the cause now.
   * Refused, with its cause, once the balance is not above zero; a daily
   * limit with its own reason; `pending` as for `admit`. A host that does
   * not answer within 2 seconds admits, unless it answered `pending` first.
   */
  admitTask(run: RunRef): Promise<TaskAdmission>;
  /** Restores what a run that failed on Chickpea's side was charged. Idempotent per run. */
  creditBack(run: RunRef, reason: CreditBackReason): Promise<CreditBackOutcome>;
}

/** A bare `refused` is out of usage with no cause. */
export type TaskAdmission = 'admitted' | 'pending' | 'refused' | PlatformFundingRefusal;

export const CREDITS_EXHAUSTED_CODE = 'credits_exhausted';
export const DAILY_LIMIT_CODE = 'daily_limit';

/**
 * The installation's credits are spent: the request is refused before it is
 * sent. The message carries the code and the cause, since a Flue failure
 * keeps only its text (see outOfUsageOf).
 */
export class CreditsExhaustedError extends Error {
  readonly name = 'CreditsExhaustedError';
  readonly code = CREDITS_EXHAUSTED_CODE;
  readonly refusal: OutOfUsage;
  constructor(cause?: OutOfUsageCause) {
    super(`This installation is out of Chickpea credits (${outOfUsageText(cause)}).`);
    this.refusal = cause ? { kind: CREDITS_EXHAUSTED_CODE, cause } : { kind: CREDITS_EXHAUSTED_CODE };
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
  return refusal.kind === CREDITS_EXHAUSTED_CODE ? new CreditsExhaustedError(refusal.cause) : new DailyLimitError(refusal);
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
const PENDING_WAIT_MS = 10_000;
const PENDING_POLL_MS = 1_000;
const MAX_CACHED_INSTALLATIONS = 1_024;
const LOG_INTERVAL_MS = 60_000;

let port: PlatformFundingPort | undefined;
let clock: () => number = Date.now;
let sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
/** When each installation's request of a stage was last admitted; a `start` admission also counts for `continue`. */
const admittedAt: Readonly<Record<AdmissionStage, Map<string, number>>> = { start: new Map(), continue: new Map() };
/**
 * Advanced by every refusal and lost charge, so an admission read already in
 * flight is not cached over it; another installation's read is just asked again.
 */
let refusals = 0;
const loggedAt = new Map<string, number>();

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configurePlatformFunding(next: PlatformFundingPort | undefined): void {
  port = next;
  admittedAt.start.clear();
  admittedAt.continue.clear();
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

/**
 * `host` when the host itself admitted the request, `cache` when a recent
 * admission served it. `reuse: false` always asks the host.
 */
export async function requirePlatformFundingAdmitted(
  grant: ModelAccessGrant,
  model: PlatformFundedModel,
  stage: AdmissionStage,
  { reuse = true }: { reuse?: boolean } = {},
): Promise<'host' | 'cache'> {
  const { installationId } = grant;
  const at = admittedAt[stage].get(installationId);
  if (reuse && at !== undefined && clock() - at < PLATFORM_ADMISSION_TTL_MS) return 'cache';
  const current = port;
  const refusalsBefore = refusals;
  let answer: PlatformFundingAdmission | typeof STILL_PENDING;
  try {
    if (!current) throw new Error('No platform funding port is configured.');
    answer = await pastPending(() => current.admit(grant, model, stage));
  } catch (error) {
    throw new PlatformFundingUnavailableError(error);
  }
  if (answer !== 'admitted') {
    forgetAdmission(installationId);
    if (answer === STILL_PENDING) throw new CreditsExhaustedError();
    const refusal: PlatformFundingRefusal | undefined =
      answer === CREDITS_EXHAUSTED_CODE ? { kind: CREDITS_EXHAUSTED_CODE } : refusalOf(answer);
    throw refusal ? platformFundingRefusalError(refusal) : new PlatformFundingUnavailableError();
  }
  // A port replaced, or a refusal answered, while this read was in flight wins over it.
  if (port !== current || refusals !== refusalsBefore) return 'host';
  for (const admitted of stage === 'start' ? [admittedAt.start, admittedAt.continue] : [admittedAt.continue]) {
    admitted.delete(installationId);
    admitted.set(installationId, clock());
    if (admitted.size > MAX_CACHED_INSTALLATIONS) {
      const oldest = admitted.keys().next();
      if (!oldest.done) admitted.delete(oldest.value);
    }
  }
  return 'host';
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
  const outcome = await askWithinBudget((current) => current.postFee(post),
    { event: 'fee_post_failed', tier: post.tier }, 'fee_post_settled_late');
  if (outcome?.kind !== 'refused') return outcome ?? FEE_UNANSWERED;
  const cause = outOfUsageCause(outcome.cause);
  return cause ? { kind: 'refused', cause } : { kind: 'refused' };
}

/**
 * A host that does not answer in time, fails, or is not configured admits: a
 * slow ledger never blocks a task. So does a malformed refusal; the run's
 * next model request asks `admit`, which refuses one. Once the host answers
 * `pending`, only an answer admits, and the wait ends refused.
 */
export async function admitRunTask({ installationId, runId }: RunRef): Promise<'admitted' | PlatformFundingRefusal> {
  let pending = false;
  const answer = await pastPending(async () => {
    const next = await askWithinBudget((current) => current.admitTask({ installationId, runId }),
      { event: 'task_admission_failed' }, 'task_admission_settled_late');
    pending ||= next === 'pending';
    return pending && (next === undefined || next === 'pending') ? 'pending' : next;
  });
  if (answer === STILL_PENDING) return { kind: CREDITS_EXHAUSTED_CODE };
  if (answer === 'refused') return { kind: CREDITS_EXHAUSTED_CODE };
  const refusal = refusalOf(answer);
  if (refusal) return refusal;
  if (answer !== undefined && answer !== 'admitted') {
    console.warn(JSON.stringify({ component: 'platform_funding', event: 'task_admission_failed', error: 'malformed' }));
  }
  return 'admitted';
}

/**
 * Why the installation is out of usage now, with the cause a public reply
 * leaves out: a task admission for a run ID of Core's own that names no
 * run. Undefined when it is admitted or the host does not say.
 */
export async function currentFundingRefusal(env: PlatformEnv | undefined): Promise<PlatformFundingRefusal | undefined> {
  const installationId = port ? requireInstallationScope(env)?.installationId : undefined;
  if (!installationId) return undefined;
  const answer = await admitRunTask({ installationId, runId: `ask_owner_${crypto.randomUUID()}` });
  return answer === 'admitted' ? undefined : answer;
}

export function creditBackRun(run: RunRef, reason: CreditBackReason): Promise<CreditBackOutcome | undefined> {
  return askWithinBudget((current) => current.creditBack(run, reason),
    { event: 'credit_back_failed', reason }, 'credit_back_settled_late');
}

const UNANSWERED_IN_TIME = Symbol('unanswered in time');
const STILL_PENDING = Symbol('still pending');

/**
 * Asks again each second while the host answers `pending`, a top-up charge
 * in flight, until PENDING_WAIT_MS after the first ask.
 */
async function pastPending<T>(ask: () => Promise<T>): Promise<Exclude<T, 'pending'> | typeof STILL_PENDING> {
  const deadline = clock() + PENDING_WAIT_MS;
  let answer = await ask();
  while (answer === 'pending') {
    const left = deadline - clock();
    if (left <= 0) return STILL_PENDING;
    await sleep(Math.min(PENDING_POLL_MS, left));
    answer = await ask();
  }
  return answer as Exclude<T, 'pending'>;
}

/**
 * A call the budget gives up on is not cancelled: `lateEvent` logs how it
 * settles, so a timeout whose answer lands later reads apart from a lost one.
 */
async function askWithinBudget<T>(
  ask: (current: PlatformFundingPort) => Promise<T>,
  failure: { readonly event: string } & Readonly<Record<string, string>>,
  lateEvent: string,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<typeof UNANSWERED_IN_TIME>((resolve) => {
    timer = setTimeout(() => resolve(UNANSWERED_IN_TIME), PORT_CALL_BUDGET_MS);
  });
  const startedAt = clock();
  let error: string;
  try {
    if (!port) throw new Error('No platform funding port is configured.');
    const asked = ask(port);
    const answer = await Promise.race([asked, budget]);
    if (answer !== UNANSWERED_IN_TIME) return answer;
    error = 'timeout';
    const late = { component: 'platform_funding', ...failure, event: lateEvent };
    void asked.then(
      (settled) => console.info(JSON.stringify({ ...late, outcome: answerKind(settled), elapsedMs: clock() - startedAt })),
      (caught: unknown) => console.warn(JSON.stringify({
        ...late, outcome: 'failed', error: errorName(caught), elapsedMs: clock() - startedAt,
      })),
    );
  } catch (caught) {
    error = errorName(caught);
  } finally {
    clearTimeout(timer);
  }
  console.warn(JSON.stringify({ component: 'platform_funding', ...failure, error }));
  return undefined;
}

/** An answer's kind, never its contents: a host's malformed answer logs as such. */
function answerKind(answer: unknown): string {
  const kind = typeof answer === 'string' ? answer : (answer as { kind?: unknown } | null | undefined)?.kind;
  return typeof kind === 'string' && /^[a-z_]{1,32}$/.test(kind) ? kind : 'malformed';
}

function errorName(caught: unknown): string {
  return caught instanceof Error ? caught.name : typeof caught;
}

function forgetAdmission(installationId: string): void {
  admittedAt.start.delete(installationId);
  admittedAt.continue.delete(installationId);
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
 * Chickpea's out-of-usage refusal an error reports, however it travelled:
 * the error itself, or the `(credits_exhausted…)` code a Flue failure's text
 * carries. Without a port nothing refuses for usage, so a provider's own
 * error that uses the word is never taken for one.
 */
export function outOfUsageOf(error: unknown): OutOfUsage | undefined {
  if (port === undefined) return undefined;
  let refusal: OutOfUsage | undefined;
  errorChainIncludes(error, (link) => {
    refusal = link instanceof CreditsExhaustedError
      ? link.refusal
      : typeof link.message === 'string' ? outOfUsageInText(link.message) : undefined;
    return refusal !== undefined;
  });
  return refusal;
}

export function isCreditsExhausted(error: unknown): boolean {
  return outOfUsageOf(error) !== undefined;
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

/**
 * Flue retries a failure whose text holds 429, 500, 502, 503 or 504
 * anywhere, so an amount travels with each digit written as a letter, a for
 * 0 through j for 9: `(credits_exhausted:top_up_limit:limitCents=faaa)`.
 */
function outOfUsageText(cause: OutOfUsageCause | undefined): string {
  if (!cause) return CREDITS_EXHAUSTED_CODE;
  const amounts = (OUT_OF_USAGE_CAUSES[cause.kind] as readonly OutOfUsageAmount[]).flatMap((field) => {
    const amount = (cause as Partial<Record<OutOfUsageAmount, number>>)[field];
    return amount === undefined ? [] : [`:${field}=${String(amount).replace(/\d/g, (digit) => DIGIT_LETTERS[Number(digit)]!)}`];
  });
  return `${CREDITS_EXHAUSTED_CODE}:${cause.kind}${amounts.join('')}`;
}

const DIGIT_LETTERS = 'abcdefghij';
const OUT_OF_USAGE_TEXT = /\(credits_exhausted(?::([a-z_]{1,40})((?::[a-zA-Z]{1,20}=[a-j]{1,9})*))?\)/;

function outOfUsageInText(message: string): OutOfUsage | undefined {
  const match = OUT_OF_USAGE_TEXT.exec(message);
  if (!match) return undefined;
  if (match[1] === undefined) return { kind: CREDITS_EXHAUSTED_CODE };
  const fields = Object.fromEntries((match[2] ?? '').split(':').slice(1).map((pair) => {
    const [field, letters] = pair.split('=') as [string, string];
    return [field, Number([...letters].map((letter) => DIGIT_LETTERS.indexOf(letter)).join(''))];
  }));
  const cause = outOfUsageCause({ ...fields, kind: match[1] });
  return cause ? { kind: CREDITS_EXHAUSTED_CODE, cause } : { kind: CREDITS_EXHAUSTED_CODE };
}

/** The port is the host's boundary: a refusal Core cannot read is no answer. */
function refusalOf(answer: unknown): PlatformFundingRefusal | undefined {
  if (isDailyLimitAdmission(answer)) return answer;
  if (typeof answer !== 'object' || answer === null || (answer as { kind?: unknown }).kind !== CREDITS_EXHAUSTED_CODE) {
    return undefined;
  }
  const cause = outOfUsageCause((answer as { cause?: unknown }).cause);
  return cause ? { kind: CREDITS_EXHAUSTED_CODE, cause } : { kind: CREDITS_EXHAUSTED_CODE };
}

/** A cause of a kind Core does not know is no cause, so the reply uses general words; an unreadable amount is left out. */
function outOfUsageCause(value: unknown): OutOfUsageCause | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind } = value as { kind?: unknown };
  if (typeof kind !== 'string' || !Object.hasOwn(OUT_OF_USAGE_CAUSES, kind)) return undefined;
  const cause: Record<string, unknown> = { kind };
  for (const field of OUT_OF_USAGE_CAUSES[kind as OutOfUsageCauseKind] as readonly OutOfUsageAmount[]) {
    const amount = (value as Record<string, unknown>)[field];
    if (Number.isSafeInteger(amount) && (amount as number) >= 0 && (amount as number) <= MAX_AMOUNT) cause[field] = amount;
  }
  return cause as OutOfUsageCause;
}

/** Nine digits, so an amount's text stays within OUT_OF_USAGE_TEXT. */
const MAX_AMOUNT = 999_999_999;

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

export function resetPlatformFundingForTests(
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): void {
  configurePlatformFunding(undefined);
  clock = options.now ?? Date.now;
  sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  loggedAt.clear();
}
