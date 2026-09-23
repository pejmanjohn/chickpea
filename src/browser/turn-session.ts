/**
 * One hosted browser per Agent turn.
 *
 * The session is created lazily on the first browser tool call, recorded so
 * the Agent can attach proof, and always ended with the turn. A per-turn time
 * budget bounds cost: once the turn has used `maxSessionMs` of browser time,
 * further browsing is refused.
 */
import { CdpClient, type CdpSocket } from './cdp.ts';
import { BrowserPage, type BrowserPageOptions } from './page.ts';
import type { BrowserProvider } from './provider.ts';

export const DEFAULT_BROWSER_SESSION_MS = 10 * 60 * 1000;
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

export interface BrowserSessionClosedInfo {
  sessionId: string;
  seconds: number;
}

export interface BrowserTurnSessionDeps {
  provider: BrowserProvider;
  connect: (connectUrl: string) => Promise<CdpSocket>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total browser time this turn may use across sessions. */
  maxSessionMs?: number;
  onClosed?: (info: BrowserSessionClosedInfo) => Promise<void>;
  pageOptions?: BrowserPageOptions;
}

export class BrowserBudgetExhaustedError extends Error {
  constructor(minutes: number) {
    super(`This turn has used its ${minutes}-minute browser budget. Answer with what you found so far.`);
    this.name = 'BrowserBudgetExhaustedError';
  }
}

interface ActiveSession {
  sessionId: string;
  client: CdpClient;
  page: BrowserPage;
  startedAt: number;
}

export class BrowserTurnSession {
  private current: ActiveSession | undefined;
  private opening: Promise<ActiveSession> | undefined;
  private closing: Promise<BrowserSessionClosedInfo | undefined> | undefined;
  private usedMs = 0;
  private readonly now: () => number;
  private readonly maxSessionMs: number;

  constructor(private readonly deps: BrowserTurnSessionDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSessionMs = deps.maxSessionMs ?? DEFAULT_BROWSER_SESSION_MS;
  }

  get active(): boolean {
    return this.current !== undefined;
  }

  get sessionId(): string | undefined {
    return this.current?.sessionId;
  }

  get startedAt(): number | undefined {
    return this.current?.startedAt;
  }

  /** Browser time used by this turn, including the open session. */
  get elapsedMs(): number {
    return this.usedMs + (this.current ? Math.max(0, this.now() - this.current.startedAt) : 0);
  }

  get provider(): BrowserProvider {
    return this.deps.provider;
  }

  async ensure(): Promise<{ page: BrowserPage; sessionId: string }> {
    if (this.closing) await this.closing;
    if (this.current) {
      if (this.elapsedMs >= this.maxSessionMs) {
        await this.close();
        throw new BrowserBudgetExhaustedError(Math.round(this.maxSessionMs / 60_000));
      }
      return { page: this.current.page, sessionId: this.current.sessionId };
    }
    if (this.usedMs >= this.maxSessionMs) {
      throw new BrowserBudgetExhaustedError(Math.round(this.maxSessionMs / 60_000));
    }
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    const session = await this.opening;
    return { page: session.page, sessionId: session.sessionId };
  }

  private async open(): Promise<ActiveSession> {
    const remainingMs = this.maxSessionMs - this.usedMs;
    const handle = await this.deps.provider.createSession({
      recording: true,
      viewport: { ...BROWSER_VIEWPORT },
      timeoutSeconds: Math.ceil(remainingMs / 1000) + 60,
    });
    const startedAt = this.now();
    try {
      const socket = await this.deps.connect(handle.connectUrl);
      const client = new CdpClient(socket);
      try {
        const pageSessionId = await client.attachFirstPage();
        const page = new BrowserPage(client, pageSessionId, {
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
          ...this.deps.pageOptions,
        });
        const active: ActiveSession = { sessionId: handle.id, client, page, startedAt };
        this.current = active;
        return active;
      } catch (error) {
        client.close();
        throw error;
      }
    } catch (error) {
      // Never leave a paid session running when the connection failed.
      await this.deps.provider.endSession(handle.id).catch(() => undefined);
      this.usedMs += Math.max(0, this.now() - startedAt);
      throw error;
    }
  }

  /** Ends the open session, if any. Safe to call repeatedly. */
  async close(): Promise<BrowserSessionClosedInfo | undefined> {
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.closing) return this.closing;
    const session = this.current;
    if (!session) return undefined;
    this.closing = (async () => {
      const durationMs = Math.max(0, this.now() - session.startedAt);
      this.current = undefined;
      this.usedMs += durationMs;
      session.client.close();
      try {
        await this.deps.provider.endSession(session.sessionId);
      } finally {
        const info = { sessionId: session.sessionId, seconds: Math.round(durationMs / 1000) };
        if (this.deps.onClosed) await this.deps.onClosed(info).catch(() => undefined);
      }
      return { sessionId: session.sessionId, seconds: Math.round(durationMs / 1000) };
    })().finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }

  /**
   * Ends the session so its recording can be finalized. Returns the ended
   * session, or undefined when nothing was open.
   */
  async release(): Promise<BrowserSessionClosedInfo | undefined> {
    return this.close();
  }
}
