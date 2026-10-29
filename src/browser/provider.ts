/**
 * Provider-independent seam for hosted browser sessions.
 *
 * A BrowserProvider creates and releases remote browser sessions and exposes
 * their live view and recordings. The page itself is driven over raw Chrome
 * DevTools Protocol (see cdp.ts / page.ts), so providers only own lifecycle.
 */
import {
  HOSTED_BROWSER_BUSY_MESSAGE,
  HOSTED_BROWSER_CONTEXT_IN_USE_MESSAGE,
  HOSTED_BROWSER_HOURS_CAP_MESSAGE,
  HOSTED_BROWSER_RUNNING_LIMIT_MESSAGE,
  HOSTED_BROWSER_UNAVAILABLE_MESSAGE,
} from './messages.ts';

export interface BrowserSessionHandle {
  id: string;
  connectUrl: string;
  contextId?: string;
}

export interface BrowserRecordingDownload {
  pageId: string;
  status: string;
  downloadUrl?: string;
}

export interface BrowserLiveView {
  fullscreenUrl: string;
  url: string;
  pages: Array<{ id: string; url: string; title: string; fullscreenUrl: string }>;
}

/** The website login a new context is made for. */
export interface BrowserContextOwner {
  loginId: string;
  label: string;
}

export interface CreateBrowserSessionOptions {
  contextId?: string;
  persistContext?: boolean;
  recording?: boolean;
  /** False keeps the provider's own session logs off; unset leaves its default (on). */
  logSession?: boolean;
  allowedDomains?: string[];
  viewport?: { width: number; height: number };
  keepAlive?: boolean;
  timeoutSeconds?: number;
  /** Tags the session at the provider, for finding it again by owner. */
  userMetadata?: Record<string, string>;
}

export interface BrowserProvider {
  readonly id: 'browserbase';
  createSession(options: CreateBrowserSessionOptions): Promise<BrowserSessionHandle>;
  endSession(sessionId: string): Promise<void>;
  sessionStatus(sessionId: string): Promise<string>;
  liveView(sessionId: string): Promise<BrowserLiveView>;
  /** Asks the provider to prepare recording downloads. 200/201/202 are success. */
  requestRecordingDownloads(sessionId: string): Promise<void>;
  listRecordingDownloads(sessionId: string): Promise<BrowserRecordingDownload[]>;
  createContext(login: BrowserContextOwner): Promise<{ id: string }>;
  /**
   * Confirms a recorded context may load into a new session. Throws
   * BrowserContextGoneError when the provider no longer has it.
   */
  checkContext(contextId: string): Promise<void>;
  /** Deletes a context and the signed-in state it holds; one already gone counts as deleted. */
  deleteContext(contextId: string): Promise<void>;
}

/** The shape of a context or session id this code stores or queues. */
export const BROWSER_PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export class BrowserProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** From a 429's `retry-after`: how long the provider asks to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'BrowserProviderError';
  }
}

/**
 * The provider no longer has a context a login recorded: deleted outside
 * Chickpea, or an old id brought back by a restore.
 */
export class BrowserContextGoneError extends Error {
  constructor() {
    super('The saved browser context is gone.');
    this.name = 'BrowserContextGoneError';
  }
}

/** Why a deployment serving many installations refused a browser call. */
export type HostedBrowserRefusalReason =
  | 'off'
  | 'unavailable'
  | 'ownership'
  | 'running_limit'
  | 'hours_cap'
  | 'rate_limit'
  | 'context_in_use';

const HOSTED_BROWSER_REFUSALS: Record<HostedBrowserRefusalReason, string> = {
  off: HOSTED_BROWSER_UNAVAILABLE_MESSAGE,
  unavailable: HOSTED_BROWSER_UNAVAILABLE_MESSAGE,
  ownership: HOSTED_BROWSER_UNAVAILABLE_MESSAGE,
  running_limit: HOSTED_BROWSER_RUNNING_LIMIT_MESSAGE,
  hours_cap: HOSTED_BROWSER_HOURS_CAP_MESSAGE,
  rate_limit: HOSTED_BROWSER_BUSY_MESSAGE,
  context_in_use: HOSTED_BROWSER_CONTEXT_IN_USE_MESSAGE,
};

/**
 * A refusal by a deployment serving many installations, before any call to
 * the provider. Its message is the fixed text for the model. Not a provider
 * error, so nothing reads it as one of the provider's answers.
 */
export class HostedBrowserRefusal extends Error {
  constructor(readonly reason: HostedBrowserRefusalReason) {
    super(HOSTED_BROWSER_REFUSALS[reason]);
    this.name = 'HostedBrowserRefusal';
  }
}

/**
 * The provider failed a call made for a deployment serving many
 * installations, or answered with a record that does not show its owner.
 * Its message is fixed (busy on a 429, unavailable otherwise), and the
 * provider's own response is dropped. The status still drives the retries
 * that read it.
 */
export class HostedBrowserFailure extends BrowserProviderError {
  constructor(status?: number, retryAfterMs?: number) {
    super(status === 429 ? HOSTED_BROWSER_BUSY_MESSAGE : HOSTED_BROWSER_UNAVAILABLE_MESSAGE, status, retryAfterMs);
    this.name = 'HostedBrowserFailure';
  }
}

export interface AwaitRecordingDownloadOptions {
  timeoutMs: number;
  pollMs: number;
  /**
   * Use a download the provider already finished instead of requesting
   * another: requests share a small per-project limit, and sending a
   * recording again needs no new one.
   */
  reuseReady?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RUNNING_STATUSES = new Set(['RUNNING', 'PENDING']);
const FAILED_DOWNLOAD_STATUSES = new Set(['FAILED', 'ERROR', 'ERRORED']);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readyDownload(downloads: BrowserRecordingDownload[]): (BrowserRecordingDownload & { downloadUrl: string }) | undefined {
  const ready = downloads.find((entry) => typeof entry.downloadUrl === 'string' && entry.downloadUrl.length > 0);
  return ready?.downloadUrl ? { ...ready, downloadUrl: ready.downloadUrl } : undefined;
}

/**
 * Waits for a session to finish, requests its recording downloads, and polls
 * until at least one download carries a URL. Returns the first ready download.
 * A request the provider rate-limits waits as long as it asks, and at least
 * one poll interval, within the same deadline.
 */
export async function awaitRecordingDownload(
  provider: BrowserProvider,
  sessionId: string,
  options: AwaitRecordingDownloadOptions,
): Promise<BrowserRecordingDownload & { downloadUrl: string }> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const timedOut = (phase: string) =>
    new BrowserProviderError(`Timed out after ${options.timeoutMs}ms waiting for the browser recording (${phase})`);

  // 1. Wait for the session to leave RUNNING.
  for (;;) {
    const status = await provider.sessionStatus(sessionId);
    if (!RUNNING_STATUSES.has(status)) {
      if (status !== 'COMPLETED') {
        throw new BrowserProviderError(`Browser session ended with status ${status}; no recording is available`);
      }
      break;
    }
    if (now() >= deadline) throw timedOut('session still running');
    await sleep(options.pollMs);
  }

  if (options.reuseReady) {
    const ready = readyDownload(await provider.listRecordingDownloads(sessionId));
    if (ready) return ready;
  }

  // 2. Request downloads; 409 means the provider still considers it running.
  for (;;) {
    try {
      await provider.requestRecordingDownloads(sessionId);
      break;
    } catch (error) {
      if (!(error instanceof BrowserProviderError)) throw error;
      if (error.status === 429) {
        // Never sooner than a poll: every installation on a project shares its limit.
        const wait = Math.max(error.retryAfterMs ?? 0, options.pollMs);
        if (now() + wait > deadline) throw error;
        await sleep(wait);
        continue;
      }
      if (error.status !== 409) throw error;
      if (now() >= deadline) throw timedOut('recording not yet available');
      await sleep(options.pollMs);
    }
  }

  // 3. Poll until a download URL appears.
  for (;;) {
    const downloads = await provider.listRecordingDownloads(sessionId);
    const ready = readyDownload(downloads);
    if (ready) return ready;
    if (downloads.length > 0 && downloads.every((entry) => FAILED_DOWNLOAD_STATUSES.has(entry.status.toUpperCase()))) {
      throw new BrowserProviderError(`Browser recording download failed (${downloads.map((d) => d.status).join(', ')})`);
    }
    if (now() >= deadline) throw timedOut('download not ready');
    await sleep(options.pollMs);
  }
}
