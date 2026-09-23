/**
 * Provider-independent seam for hosted browser sessions.
 *
 * A BrowserProvider creates and releases remote browser sessions and exposes
 * their live view and recordings. The page itself is driven over raw Chrome
 * DevTools Protocol (see cdp.ts / page.ts), so providers only own lifecycle.
 */

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

export interface CreateBrowserSessionOptions {
  contextId?: string;
  persistContext?: boolean;
  recording?: boolean;
  allowedDomains?: string[];
  viewport?: { width: number; height: number };
  keepAlive?: boolean;
  timeoutSeconds?: number;
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
  createContext(name?: string): Promise<{ id: string }>;
}

export class BrowserProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'BrowserProviderError';
  }
}

export interface AwaitRecordingDownloadOptions {
  timeoutMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RUNNING_STATUSES = new Set(['RUNNING', 'PENDING']);
const FAILED_DOWNLOAD_STATUSES = new Set(['FAILED', 'ERROR', 'ERRORED']);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a session to finish, requests its recording downloads, and polls
 * until at least one download carries a URL. Returns the first ready download.
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

  // 2. Request downloads; 409 means the provider still considers it running.
  for (;;) {
    try {
      await provider.requestRecordingDownloads(sessionId);
      break;
    } catch (error) {
      if (!(error instanceof BrowserProviderError) || error.status !== 409) throw error;
      if (now() >= deadline) throw timedOut('recording not yet available');
      await sleep(options.pollMs);
    }
  }

  // 3. Poll until a download URL appears.
  for (;;) {
    const downloads = await provider.listRecordingDownloads(sessionId);
    const ready = downloads.find((entry) => typeof entry.downloadUrl === 'string' && entry.downloadUrl.length > 0);
    if (ready?.downloadUrl) return { ...ready, downloadUrl: ready.downloadUrl };
    if (downloads.length > 0 && downloads.every((entry) => FAILED_DOWNLOAD_STATUSES.has(entry.status.toUpperCase()))) {
      throw new BrowserProviderError(`Browser recording download failed (${downloads.map((d) => d.status).join(', ')})`);
    }
    if (now() >= deadline) throw timedOut('download not ready');
    await sleep(options.pollMs);
  }
}
