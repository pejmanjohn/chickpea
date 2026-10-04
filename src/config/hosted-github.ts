/**
 * The platform GitHub App of a deployment serving many installations.
 *
 * Standalone connects its own GitHub App and stores it in its settings. A
 * deployment serving many installations owns one App instead, and each
 * installation binds the GitHub accounts it proved it owns. The host keeps
 * those bindings in its registry, never in a tenant store, and installs this
 * port once at module scope: the App's credentials and bot account, and per
 * installation the list of live bindings, their disconnect, and a report
 * that GitHub no longer knows one. Connecting an account is the host's own
 * flow: Admin's Connect GitHub form posts to the path the host supplies.
 *
 * Fail closed. Without the port, with an App that is not complete, or when
 * the binding list cannot be read, the installation has no GitHub
 * connection. Each binding list serves an installation for 30 seconds in
 * the isolate, so an ended or suspended binding stops minting within that.
 */
// Used only when a binding is read, so the cycle with github-app.ts never runs at load.
import { GITHUB_OWNER_PATTERN } from './github-app.ts';

export interface HostedGithubApp {
  readonly appId: string;
  readonly appSlug: string;
  readonly privateKeyPem: string;
  /** The App's bot account (`<slug>[bot]`), whose noreply address authors commits. */
  readonly botUserId: number;
}

export type HostedGithubBindingStatus = 'active' | 'suspended';

/** One GitHub account (user or organization) an installation bound, as the host's registry holds it. */
export interface HostedGithubBinding {
  readonly githubInstallationId: number;
  readonly accountLogin: string;
  readonly accountType: 'User' | 'Organization';
  readonly repositorySelection: 'all' | 'selected';
  readonly status: HostedGithubBindingStatus;
}

export interface HostedGithubPort {
  /** The platform App, read when asked (the host's own secrets); undefined when it has none. */
  app(): unknown;
  bindings: {
    /** The installation's live bindings (active or suspended). */
    list(installationId: string): Promise<unknown>;
    /** Ends one of the installation's live bindings; false when it holds no such binding. */
    disconnect(installationId: string, githubInstallationId: number): Promise<boolean>;
    /** A mint for a bound installation got 404 from GitHub: the host re-reads GitHub and follows it. */
    reportGone(installationId: string, githubInstallationId: number): Promise<void> | void;
  };
}

/** How long one binding list serves an installation in this isolate. */
export const HOSTED_GITHUB_BINDINGS_TTL_MS = 30_000;
const MAX_CACHED_INSTALLATIONS = 1_024;
const LOG_INTERVAL_MS = 60_000;
const APP_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

interface CachedBindings {
  readonly bindings: readonly HostedGithubBinding[];
  readonly at: number;
}

/**
 * Where Admin's Connect GitHub form posts: a same-origin path, such as
 * `/github/connect`. The plain form (`application/x-www-form-urlencoded`)
 * carries one field, `next`: the Admin path to return to, either
 * `/admin/settings/github` or `/admin/onboarding`. Admin sends no Core token,
 * so the host's route must enforce Origin, the session and the role itself,
 * and accept only an `/admin` path as `next`. After binding an account the
 * host redirects to `next` with `?github=connected`, which Admin shows once
 * as "GitHub connected." and removes; from onboarding it also moves the
 * journey on to Try. Any other outcome is the host's own page.
 */
export interface HostedGithubConnect {
  path: string;
}

let port: HostedGithubPort | undefined;
let connectPath: string | null = null;
let clock: () => number = Date.now;
const answers = new Map<string, CachedBindings>();
const pending = new Map<string, Promise<readonly HostedGithubBinding[]>>();
const loggedAt = new Map<string, number>();

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configureHostedGithub(next: HostedGithubPort | undefined): void {
  port = next;
  answers.clear();
  pending.clear();
}

/** Whether a host installed its port, for a readiness probe or a boot check. */
export function hostedGithubConfigured(): boolean {
  return port !== undefined;
}

/**
 * Install the host's connect path, once at module scope; undefined removes it.
 * Without it, Admin offers no Connect GitHub and onboarding has no GitHub step.
 */
export function configureHostedGithubConnect(connect: HostedGithubConnect | undefined): void {
  if (connect === undefined) {
    connectPath = null;
    return;
  }
  const path = connect.path;
  if (typeof path !== 'string' || !/^\/(?![/\\])[A-Za-z0-9/_.~-]{0,255}$/.test(path)) {
    throw new Error('The GitHub connect path must be a same-origin path.');
  }
  connectPath = path;
}

/**
 * The path Admin's Connect GitHub form posts to, or null when connecting
 * cannot start here: no path, no port, or no complete platform App. A caller
 * that has already read the App passes it, so it is not read again.
 */
export async function hostedGithubConnectPath(app?: HostedGithubApp): Promise<string | null> {
  const path = connectPath;
  if (path === null || port === undefined) return null;
  return (app ?? await hostedGithubApp()) ? path : null;
}

/** The platform App, or undefined when no port is installed or its App is incomplete. Never throws. */
export async function hostedGithubApp(): Promise<HostedGithubApp | undefined> {
  const current = port;
  if (!current) {
    logAtMostEachMinute('github_port_missing', 'error');
    return undefined;
  }
  let value: unknown;
  try {
    value = await current.app();
  } catch {
    logAtMostEachMinute('github_app_unavailable', 'warn');
    return undefined;
  }
  if (value === undefined) return undefined;
  const app = parseHostedGithubApp(value);
  if (!app) logAtMostEachMinute('github_app_invalid', 'error');
  return app;
}

/**
 * The installation's live bindings, cached per isolate for 30 seconds. A
 * list that cannot be read is none, and is read again next time.
 */
export async function hostedGithubBindings(installationId: string): Promise<readonly HostedGithubBinding[]> {
  const current = port;
  if (!current) {
    logAtMostEachMinute('github_port_missing', 'error');
    return [];
  }
  const cached = answers.get(installationId);
  if (cached && clock() - cached.at < HOSTED_GITHUB_BINDINGS_TTL_MS) return cached.bindings;
  const inFlight = pending.get(installationId);
  if (inFlight) return inFlight;
  const read = readBindings(current, installationId);
  pending.set(installationId, read);
  try {
    return await read;
  } finally {
    if (pending.get(installationId) === read) pending.delete(installationId);
  }
}

/**
 * Ends one of the installation's own live bindings through the host, and
 * returns it. Undefined, without asking the host, when the installation
 * holds no such binding.
 */
export async function disconnectHostedGithubBinding(
  installationId: string,
  githubInstallationId: number,
): Promise<HostedGithubBinding | undefined> {
  const current = port;
  if (!current) return undefined;
  const binding = (await hostedGithubBindings(installationId))
    .find((candidate) => candidate.githubInstallationId === githubInstallationId);
  if (!binding) return undefined;
  try {
    return await current.bindings.disconnect(installationId, githubInstallationId) === true ? binding : undefined;
  } finally {
    forgetHostedGithubBindings(installationId);
  }
}

/** Tells the host GitHub answered 404 for a bound installation's mint. Never throws. */
export function reportHostedGithubInstallationGone(installationId: string, githubInstallationId: number): void {
  const current = port;
  forgetHostedGithubBindings(installationId);
  if (!current) return;
  try {
    void Promise.resolve(current.bindings.reportGone(installationId, githubInstallationId)).catch(() => {
      logAtMostEachMinute('github_report_gone_failed', 'warn');
    });
  } catch {
    logAtMostEachMinute('github_report_gone_failed', 'warn');
  }
}

/** Drops an installation's cached bindings, so the next read asks the host. */
export function forgetHostedGithubBindings(installationId: string): void {
  answers.delete(installationId);
  pending.delete(installationId);
}

/** A complete platform App, or undefined. */
export function parseHostedGithubApp(value: unknown): HostedGithubApp | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { appId, appSlug, privateKeyPem, botUserId } = value as Record<string, unknown>;
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId)) return undefined;
  if (typeof appSlug !== 'string' || !APP_SLUG_PATTERN.test(appSlug)) return undefined;
  if (typeof privateKeyPem !== 'string' || !privateKeyPem.includes('PRIVATE KEY-----')) return undefined;
  if (typeof botUserId !== 'number' || !Number.isSafeInteger(botUserId) || botUserId < 1) return undefined;
  return Object.freeze({ appId, appSlug, privateKeyPem, botUserId });
}

/** A well-formed binding, or undefined. */
export function parseHostedGithubBinding(value: unknown): HostedGithubBinding | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { githubInstallationId, accountLogin, accountType, repositorySelection, status } =
    value as Record<string, unknown>;
  if (typeof githubInstallationId !== 'number' || !Number.isSafeInteger(githubInstallationId) ||
    githubInstallationId < 1) return undefined;
  if (typeof accountLogin !== 'string' || !GITHUB_OWNER_PATTERN.test(accountLogin)) return undefined;
  if (accountType !== 'User' && accountType !== 'Organization') return undefined;
  if (repositorySelection !== 'all' && repositorySelection !== 'selected') return undefined;
  if (status !== 'active' && status !== 'suspended') return undefined;
  return Object.freeze({ githubInstallationId, accountLogin, accountType, repositorySelection, status });
}

async function readBindings(
  current: HostedGithubPort,
  installationId: string,
): Promise<readonly HostedGithubBinding[]> {
  let bindings: readonly HostedGithubBinding[];
  try {
    const listed = await current.bindings.list(installationId);
    if (!Array.isArray(listed)) throw new Error('not a list');
    const parsed = listed.map(parseHostedGithubBinding);
    if (parsed.some((binding) => binding === undefined)) logAtMostEachMinute('github_binding_invalid', 'error');
    const valid = parsed.filter((binding): binding is HostedGithubBinding => binding !== undefined);
    // One GitHub installation and one account each name a single binding; a repeat is a fault, and neither copy is used.
    const repeated = (key: (binding: HostedGithubBinding) => string | number) => {
      const seen = new Map<string | number, number>();
      for (const binding of valid) seen.set(key(binding), (seen.get(key(binding)) ?? 0) + 1);
      return (binding: HostedGithubBinding) => (seen.get(key(binding)) ?? 0) > 1;
    };
    const repeatedInstallation = repeated((binding) => binding.githubInstallationId);
    const repeatedAccount = repeated((binding) => binding.accountLogin.toLowerCase());
    bindings = Object.freeze(valid.filter((binding) => !repeatedInstallation(binding) && !repeatedAccount(binding)));
    if (bindings.length !== valid.length) logAtMostEachMinute('github_binding_repeated', 'error');
  } catch {
    logAtMostEachMinute('github_bindings_unavailable', 'warn');
    return Object.freeze([]);
  }
  // A port replaced while this read was in flight does not answer for it.
  if (port !== current) return bindings;
  answers.delete(installationId);
  answers.set(installationId, { bindings, at: clock() });
  if (answers.size > MAX_CACHED_INSTALLATIONS) {
    const oldest = answers.keys().next();
    if (!oldest.done) answers.delete(oldest.value);
  }
  return bindings;
}

/** Content-free: names no installation, account or key. */
function logAtMostEachMinute(event: string, level: 'error' | 'warn'): void {
  const at = clock();
  if (at - (loggedAt.get(event) ?? Number.NEGATIVE_INFINITY) < LOG_INTERVAL_MS) return;
  loggedAt.set(event, at);
  console[level](JSON.stringify({ component: 'hosted_github', event }));
}

export function resetHostedGithubForTests(options: { now?: () => number } = {}): void {
  configureHostedGithub(undefined);
  configureHostedGithubConnect(undefined);
  clock = options.now ?? Date.now;
  loggedAt.clear();
}
