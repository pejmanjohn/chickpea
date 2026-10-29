/**
 * The browser provider of one installation on a deployment serving many.
 *
 * Every installation in the deployment shares the host's Browserbase
 * project, so the tenant boundary is this wrapper. Every Browserbase call
 * made for an installation goes through it, keyed by the host's access
 * (config/hosted-browser.ts); nothing here reads an installation's
 * `browser.browserbase.*` settings or a `BROWSERBASE_*` variable.
 *
 * - A context is named `chickpea.<installationId>.<loginId>.<8 hex>`, never
 *   the login's label. Before a session loads a context, and before a
 *   context is deleted, its record must name the project and the
 *   installation's prefix.
 * - A session carries `{ chickpea: '1', installation }` as its user metadata
 *   and keeps the provider's session logs off. A session this instance did
 *   not create is used only once its record names the project and the
 *   installation: a stored hand-off session, a recording handle, erasure.
 * - Only a record that names another project or installation is another's.
 *   One missing the field cannot be judged: that is a failure to try again,
 *   so no queue or erasure forgets an id it could not check.
 * - The policy is read again on every create, so the host's off switch
 *   holds mid-turn. Every session holds a lease against the policy's
 *   limits from just before its create until it ends (session-lease.ts).
 * - Refusals and the provider's failures reach the model only as fixed
 *   texts; the provider's own response goes nowhere, and the log names
 *   the operation and status alone.
 */
import { hostedBrowserAccess, hostedBrowserPolicy, type HostedBrowserAccess } from '../config/hosted-browser.ts';
import { requireInstallationScope } from '../config/installation-scope.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  BrowserbaseIncompleteSessionError,
  createBrowserbaseProvider,
  type BrowserbaseClient,
  type BrowserbaseContextRecord,
  type BrowserbaseSessionRecord,
} from './browserbase.ts';
import {
  admitBrowserSession,
  attachBrowserSession,
  closeBrowserSessionLease,
  releaseBrowserReservation,
} from './session-lease.ts';
import {
  BrowserContextGoneError,
  BrowserProviderError,
  HostedBrowserFailure,
  HostedBrowserRefusal,
  type BrowserContextOwner,
  type BrowserDownload,
  type BrowserLiveView,
  type BrowserProvider,
  type BrowserRecordingDownload,
  type BrowserSessionHandle,
  type CreateBrowserSessionOptions,
} from './provider.ts';

export interface HostedBrowserProviderOptions {
  access: HostedBrowserAccess;
  installationId: string;
  store: Pick<SettingsStore, 'getSettings' | 'applySettingsPatch'>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The session list's metadata key naming the installation. */
const INSTALLATION_METADATA_KEY = 'installation';
/** A session asked for with no timeout gets this one, so its lease and the provider agree on when it ends. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Answers to a session create that prove Browserbase made no session. Any
 * other failure (no answer, a timeout, a 5xx, 408, 429) may follow a
 * session it made and bills to its timeout.
 */
const CREATE_REFUSED = new Set([400, 401, 403, 404, 409, 422]);

const RUNNING_STATUSES = new Set(['RUNNING', 'PENDING']);

/** Whose a provider record is: this installation's, provably another's, or not known from what it holds. */
type Ownership = 'own' | 'foreign' | 'unverified';

export class HostedBrowserProvider implements BrowserProvider {
  readonly id = 'browserbase' as const;
  readonly #client: BrowserbaseClient;
  readonly #projectId: string;
  readonly #installationId: string;
  /** The dot ends the id, so one installation's id never prefixes another's names. */
  readonly #contextPrefix: string;
  /** Sessions this instance created or found the installation's; a refused id is asked again. */
  readonly #ownSessions = new Set<string>();
  readonly #ownContexts = new Set<string>();
  /** Files this instance listed from a session it found the installation's: the only ones it deletes. */
  readonly #ownDownloads = new Set<string>();
  readonly #store: HostedBrowserProviderOptions['store'];
  readonly #now: () => number;

  constructor(options: HostedBrowserProviderOptions) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#projectId = options.access.projectId;
    this.#installationId = options.installationId;
    this.#contextPrefix = `chickpea.${options.installationId}.`;
    this.#client = createBrowserbaseProvider({
      apiKey: options.access.apiKey,
      projectId: options.access.projectId,
      contextName: ({ loginId }) => `${this.#contextPrefix}${loginId}.${randomHex(4)}`,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  async createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionHandle> {
    const policy = hostedBrowserPolicy();
    if (!policy.enabled) throw new HostedBrowserRefusal('off');
    if (options.contextId) await this.checkContext(options.contextId);
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const reservationId = crypto.randomUUID();
    // A store that fails, or stays contended, admits nothing: the model sees the fixed text, never the store's.
    const admission = await admitBrowserSession({
      store: this.#store,
      policy,
      reservationId,
      ...(options.contextId ? { contextId: options.contextId } : {}),
      timeoutSeconds,
      now: this.#now(),
    }).catch((): never => {
      log('lease_admission_failed', {});
      throw new HostedBrowserRefusal('unavailable');
    });
    if (admission !== 'admitted') throw new HostedBrowserRefusal(admission);
    let handle: BrowserSessionHandle;
    try {
      handle = await this.#client.createSession({
        ...options,
        timeoutSeconds,
        logSession: false,
        userMetadata: { chickpea: '1', [INSTALLATION_METADATA_KEY]: this.#installationId },
      });
    } catch (error) {
      await this.#settleFailedCreate(reservationId, error);
      throw failure('create_session', error);
    }
    await this.#attach(reservationId, handle.id);
    return handle;
  }

  /**
   * The lease of a create that failed. It is released only when Browserbase
   * refused the create. Otherwise it stands to its timeout, as an unattached
   * lease does, so a session Browserbase may have made stays inside the
   * running limit and the meter; one the answer names is ended.
   */
  async #settleFailedCreate(reservationId: string, error: unknown): Promise<void> {
    if (error instanceof BrowserProviderError && error.status !== undefined && CREATE_REFUSED.has(error.status)) {
      await releaseBrowserReservation({ store: this.#store, reservationId, now: this.#now() })
        .catch(() => log('lease_release_failed', {}));
      return;
    }
    if (!(error instanceof BrowserbaseIncompleteSessionError) || !error.sessionId) return;
    await this.#attach(reservationId, error.sessionId);
    await this.endSession(error.sessionId).catch(() => undefined);
  }

  /** Unattached, the lease stands to its timeout and is charged up to it. */
  async #attach(reservationId: string, sessionId: string): Promise<void> {
    this.#ownSessions.add(sessionId);
    await attachBrowserSession({ store: this.#store, reservationId, sessionId, now: this.#now() })
      .catch(() => log('lease_attach_failed', {}));
  }

  /**
   * Ends the session, then releases its lease and meters the run. A session
   * that already ended may refuse its release, so a failed end reads the
   * session: one that ended is metered to when it did. Otherwise the lease
   * stands to its timeout.
   */
  async endSession(sessionId: string): Promise<void> {
    await this.#requireSession(sessionId);
    try {
      await this.#client.endSession(sessionId);
    } catch (error) {
      const record = await this.#client.getSession(sessionId).catch(() => undefined);
      if (!record || RUNNING_STATUSES.has(record.status)) throw failure('end_session', error);
      await this.#closeLease(sessionId, record.endedAt);
      return;
    }
    await this.#closeLease(sessionId);
  }

  async #closeLease(sessionId: string, endedAt?: number): Promise<void> {
    await closeBrowserSessionLease({ store: this.#store, sessionId, now: this.#now(), ...(endedAt === undefined ? {} : { endedAt }) })
      .catch(() => log('lease_close_failed', {}));
  }

  async sessionStatus(sessionId: string): Promise<string> {
    // Checking a session another instance made reads its record, status included.
    const record = await this.#requireSession(sessionId);
    return record?.status ?? await this.#call('session_status', () => this.#client.sessionStatus(sessionId));
  }

  async liveView(sessionId: string): Promise<BrowserLiveView> {
    await this.#requireSession(sessionId);
    return this.#call('live_view', () => this.#client.liveView(sessionId));
  }

  async requestRecordingDownloads(sessionId: string): Promise<void> {
    await this.#requireSession(sessionId);
    await this.#call('request_recording', () => this.#client.requestRecordingDownloads(sessionId));
  }

  async listRecordingDownloads(sessionId: string): Promise<BrowserRecordingDownload[]> {
    await this.#requireSession(sessionId);
    return this.#call('list_recording', () => this.#client.listRecordingDownloads(sessionId));
  }

  async listDownloads(sessionId: string): Promise<BrowserDownload[]> {
    await this.#requireSession(sessionId);
    const downloads = await this.#call('list_downloads', () => this.#client.listDownloads(sessionId));
    for (const { id } of downloads) this.#ownDownloads.add(id);
    return downloads;
  }

  async deleteDownload(downloadId: string): Promise<void> {
    if (!this.#ownDownloads.has(downloadId)) throw refused('foreign', 'download');
    await this.#call('delete_download', () => this.#client.deleteDownload(downloadId));
    this.#ownDownloads.delete(downloadId);
  }

  async createContext(login: BrowserContextOwner): Promise<{ id: string }> {
    if (!hostedBrowserPolicy().enabled) throw new HostedBrowserRefusal('off');
    const context = await this.#call('create_context', () => this.#client.createContext(login));
    this.#ownContexts.add(context.id);
    return context;
  }

  async checkContext(contextId: string): Promise<void> {
    if (this.#ownContexts.has(contextId)) return;
    let record;
    try {
      record = await this.#client.getContext(contextId);
    } catch (error) {
      if (error instanceof BrowserProviderError && error.status === 404) throw new BrowserContextGoneError();
      throw failure('get_context', error);
    }
    const ownership = this.#contextOwnership(record);
    if (ownership !== 'own') throw refused(ownership, 'context');
    this.#ownContexts.add(contextId);
  }

  async deleteContext(contextId: string): Promise<void> {
    await this.removeContext(contextId);
  }

  /** Deletes the installation's own context: whether it was there. Refuses any other. */
  async removeContext(contextId: string): Promise<'deleted' | 'gone'> {
    try {
      await this.checkContext(contextId);
    } catch (error) {
      if (error instanceof BrowserContextGoneError) return 'gone';
      throw error;
    }
    await this.#call('delete_context', () => this.#client.deleteContext(contextId));
    this.#ownContexts.delete(contextId);
    return 'deleted';
  }

  /**
   * The installation's sessions the provider lists by their metadata,
   * optionally in one status, each checked here too: a listed session whose
   * record names another project or installation is left out. So is one
   * whose record does not show whose it is, and the list is then
   * `unverified`, as it is when the answer itself is not a list: what it
   * holds is not every session there is.
   */
  async installationSessions(status?: 'RUNNING' | 'PENDING'): Promise<{
    sessions: BrowserbaseSessionRecord[];
    unverified: boolean;
  }> {
    const listed = await this.#call('list_sessions', () => this.#client.listSessions({
      metadata: { key: INSTALLATION_METADATA_KEY, value: this.#installationId },
      ...(status ? { status } : {}),
    }));
    const sessions: BrowserbaseSessionRecord[] = [];
    let unverified = listed.malformed;
    for (const record of listed.sessions) {
      const ownership = this.#sessionOwnership(record);
      if (ownership === 'unverified') unverified = true;
      if (ownership !== 'own') continue;
      this.#ownSessions.add(record.id);
      sessions.push(record);
    }
    return { sessions, unverified };
  }

  /** The session's record when this call read it to check ownership; undefined when already known. */
  async #requireSession(sessionId: string): Promise<BrowserbaseSessionRecord | undefined> {
    if (this.#ownSessions.has(sessionId)) return undefined;
    const record = await this.#call('get_session', () => this.#client.getSession(sessionId));
    const ownership = this.#sessionOwnership(record);
    if (ownership !== 'own') throw refused(ownership, 'session');
    this.#ownSessions.add(sessionId);
    return record;
  }

  #contextOwnership(record: BrowserbaseContextRecord): Ownership {
    if ((record.projectId && record.projectId !== this.#projectId) ||
        (record.name && !record.name.startsWith(this.#contextPrefix))) return 'foreign';
    return record.projectId && record.name ? 'own' : 'unverified';
  }

  #sessionOwnership(record: BrowserbaseSessionRecord): Ownership {
    const installation = record.userMetadata?.[INSTALLATION_METADATA_KEY];
    if ((record.projectId && record.projectId !== this.#projectId) ||
        (installation !== undefined && installation !== this.#installationId)) return 'foreign';
    return record.projectId && installation !== undefined ? 'own' : 'unverified';
  }

  async #call<T>(operation: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw failure(operation, error);
    }
  }
}

/**
 * The provider for the installation `env` serves, from the host's access.
 * Throws the unavailable refusal when the host installed no port or its
 * access is incomplete, so a caller never falls back to another key.
 */
export function hostedBrowserProvider(
  store: HostedBrowserProviderOptions['store'],
  env: Record<string, unknown> | undefined,
): HostedBrowserProvider {
  const installationId = requireInstallationScope(env)?.installationId;
  const access = hostedBrowserAccess();
  if (!installationId || !access) throw new HostedBrowserRefusal('unavailable');
  return new HostedBrowserProvider({ access, installationId, store });
}

/** The provider's error as the fixed failure, logged by operation and status only. */
function failure(operation: string, error: unknown): Error {
  if (error instanceof HostedBrowserRefusal || error instanceof HostedBrowserFailure) return error;
  const status = error instanceof BrowserProviderError ? error.status : undefined;
  log('provider_failed', { operation, ...(status === undefined ? {} : { status }) });
  return new HostedBrowserFailure(status, error instanceof BrowserProviderError ? error.retryAfterMs : undefined);
}

/**
 * Another installation's id is refused for good. One whose record could not
 * be judged fails like the provider did, so every caller tries it again.
 */
function refused(ownership: Exclude<Ownership, 'own'>, kind: 'context' | 'session' | 'download'): Error {
  if (ownership === 'unverified') {
    log('ownership_unverified', { kind });
    return new HostedBrowserFailure();
  }
  log('ownership_refused', { kind });
  return new HostedBrowserRefusal('ownership');
}

/** Content-free: names no installation, session, context, or anything the provider returned. */
function log(event: string, fields: Record<string, string | number>): void {
  console.warn(JSON.stringify({ component: 'hosted_browser', event, ...fields }));
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
