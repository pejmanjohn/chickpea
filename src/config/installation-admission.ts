/**
 * Whether an installation of a deployment serving many may start work now.
 *
 * The host's registry decides: an active installation is admitted, and a
 * suspended, revoked, uninstalled or deleted one is refused. The host's own
 * boundaries (Slack ingress, Admin, sign-in, its cron) refuse first. Core
 * asks again where tenant work starts or continues, at every top-level agent
 * operation and every model step, so a turn queued before a suspension, a
 * resumed attempt, or the next step of a running one stops within about 30
 * seconds. Nothing is mirrored into the tenant store: a restored store must
 * never bring back a stale answer.
 *
 * Standalone never asks. A deployment serving many installations that has no
 * check configured refuses, as the model resolver does, and says so loudly:
 * the host installs one once, at module scope, and proves it is there.
 */
import { errorChainIncludes } from './error-chain.ts';
import {
  deploymentServesManyInstallations,
  InstallationContextError,
  installationScopeOf,
} from './installation-scope.ts';

export type InstallationAdmission = 'admitted' | 'refused';

/** The host's answer for one installation, from its registry. */
export type InstallationAdmissionCheck = (installationId: string) => Promise<InstallationAdmission>;

/** The installation is not admitted to start work: suspended, ended, or unknown. */
export class InstallationNotAdmittedError extends Error {
  readonly name = 'InstallationNotAdmittedError';
  readonly code = 'installation_not_admitted';
  constructor() {
    super('This installation is not admitted to start work (installation_not_admitted).');
  }
}

/** How long one answer serves an installation in this isolate. */
export const INSTALLATION_ADMISSION_TTL_MS = 30_000;
/** How long a last known answer stands while the check cannot be read. */
export const INSTALLATION_ADMISSION_LAST_KNOWN_MS = 10 * 60_000;
const MAX_CACHED_INSTALLATIONS = 1_024;
const LOG_INTERVAL_MS = 60_000;

/** A deployment serving many installations has no admission check installed. */
export class InstallationAdmissionNotConfiguredError extends Error {
  readonly name = 'InstallationAdmissionNotConfiguredError';
  constructor() {
    super('This deployment serves many installations and has no admission check configured.');
  }
}

interface CachedAdmission {
  readonly answer: InstallationAdmission;
  /** When this answer was cached: it serves until the TTL passes. */
  readonly at: number;
  /** When the registry last answered; a fallback answer during an outage keeps the earlier time. */
  readonly answeredAt: number | undefined;
}

let check: InstallationAdmissionCheck | undefined;
let clock: () => number = Date.now;
const answers = new Map<string, CachedAdmission>();
const pending = new Map<string, Promise<InstallationAdmission>>();
const loggedAt = new Map<string, number>();

/** The composition seam: the host's registry check, installed once at module scope. */
export function configureInstallationAdmission(next: InstallationAdmissionCheck | undefined): void {
  check = next;
  answers.clear();
  pending.clear();
}

/** Whether a host installed its check, for a readiness probe or a boot check inside any isolate. */
export function installationAdmissionConfigured(): boolean {
  return check !== undefined;
}

/**
 * Refuses, on a deployment serving many installations, to run anything while
 * no check is installed, so the misconfiguration fails loudly (Core's cron
 * throws every tick) rather than quietly refusing every installation's work.
 */
export function requireInstallationAdmissionConfigured(env: Record<string, unknown> | undefined): void {
  if (!check && deploymentServesManyInstallations(env)) {
    logAtMostEachMinute('admission_check_missing', 'error');
    throw new InstallationAdmissionNotConfiguredError();
  }
}

/**
 * The installation's admission, cached per isolate for 30 seconds. When the
 * check cannot be read, the last known answer stands while it is under ten
 * minutes old; with none, the work is admitted and logged, because the host's
 * boundaries remain the primary gate. Either fallback is cached like an
 * answer, so an outage costs one failed read per installation per 30 seconds.
 */
export async function installationAdmission(installationId: string): Promise<InstallationAdmission> {
  if (!check) {
    logAtMostEachMinute('admission_check_missing', 'error');
    return 'refused';
  }
  const cached = answers.get(installationId);
  if (cached && clock() - cached.at < INSTALLATION_ADMISSION_TTL_MS) return cached.answer;
  const inFlight = pending.get(installationId);
  if (inFlight) return inFlight;
  const read = readAdmission(check, installationId, cached);
  pending.set(installationId, read);
  try {
    return await read;
  } finally {
    if (pending.get(installationId) === read) pending.delete(installationId);
  }
}

/** Throws InstallationNotAdmittedError unless the installation is admitted. */
export async function requireInstallationAdmitted(installationId: string): Promise<void> {
  if (await installationAdmission(installationId) !== 'admitted') throw new InstallationNotAdmittedError();
}

/**
 * Whether the installation an env serves is refused new work: never on
 * standalone, and by the check on a deployment serving many installations,
 * where an env that names no installation is a wiring error and throws.
 */
export async function installationRefusesWork(env: Record<string, unknown> | undefined): Promise<boolean> {
  if (!deploymentServesManyInstallations(env)) return false;
  const scope = installationScopeOf(env);
  if (!scope) {
    throw new InstallationContextError(
      'installation_context_missing',
      'This deployment serves many installations and the work names none.',
    );
  }
  return await installationAdmission(scope.installationId) !== 'admitted';
}

/**
 * Whether an error is a refusal by the admission check, however it travelled:
 * thrown directly, or carried in the text of a Flue submission's failure.
 */
export function isInstallationRefusal(error: unknown): boolean {
  return errorChainIncludes(error, (link) => link instanceof InstallationNotAdmittedError ||
    [link.message, link.type].some((text) => typeof text === 'string' && text.includes('installation_not_admitted')));
}

async function readAdmission(
  current: InstallationAdmissionCheck,
  installationId: string,
  cached: CachedAdmission | undefined,
): Promise<InstallationAdmission> {
  let answer: InstallationAdmission;
  let answeredAt: number | undefined = clock();
  try {
    answer = await current(installationId) === 'admitted' ? 'admitted' : 'refused';
  } catch {
    logAtMostEachMinute('admission_check_unavailable', 'warn');
    answeredAt = cached?.answeredAt;
    answer = cached && answeredAt !== undefined && clock() - answeredAt < INSTALLATION_ADMISSION_LAST_KNOWN_MS
      ? cached.answer
      : 'admitted';
  }
  // A check replaced while this read was in flight does not answer for it.
  if (check !== current) return answer;
  answers.delete(installationId);
  answers.set(installationId, { answer, at: clock(), answeredAt });
  if (answers.size > MAX_CACHED_INSTALLATIONS) {
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
  return answer;
}

/** Content-free: names no installation. */
function logAtMostEachMinute(event: string, level: 'error' | 'warn'): void {
  const at = clock();
  if (at - (loggedAt.get(event) ?? Number.NEGATIVE_INFINITY) < LOG_INTERVAL_MS) return;
  loggedAt.set(event, at);
  console[level](JSON.stringify({ component: 'installation_admission', event }));
}

export function resetInstallationAdmissionForTests(options: { now?: () => number } = {}): void {
  configureInstallationAdmission(undefined);
  clock = options.now ?? Date.now;
  loggedAt.clear();
}
