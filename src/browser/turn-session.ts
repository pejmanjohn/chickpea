/**
 * One hosted browser per Agent turn.
 *
 * The session is created lazily on the first browser tool call, recorded so
 * the Agent can attach proof, and always ended with the turn. A per-turn time
 * budget bounds cost: once the turn has used `maxSessionMs` of browser time,
 * further browsing is refused.
 *
 * A session is either public or bound to one website login, whose saved
 * browser context it loads and persists. Switching between them ends the open
 * session and starts another within the same budget. A session handed to a
 * person to sign in is detached: it outlives the turn and ends by timeout.
 */
import type { CdpClient, CdpSocket } from './cdp.ts';
import type { BrowserPage } from './page.ts';
import type { BrowserProvider } from './provider.ts';

export const DEFAULT_BROWSER_SESSION_MS = 10 * 60 * 1000;
export const BROWSER_VIEWPORT = { width: 1280, height: 800 } as const;

/** The website login a session is bound to. */
export interface BrowserSessionBinding {
  loginId: string;
  /** The login's host, optionally with a port. */
  host: string;
  /** The hosted-browser context holding the login's saved session. */
  contextId: string;
  /** What the grant allows: `act` lifts read-only browsing for this session. */
  level?: 'check' | 'act';
}

export interface BrowserSessionClosedInfo {
  sessionId: string;
  seconds: number;
}

/** What the Agent may do in the open browser session. */
export interface BrowserPolicy {
  /** Refuse actions the model flags as changing data on a website. */
  readOnly: boolean;
}

export interface BrowserTurnSessionDeps {
  provider: BrowserProvider;
  /**
   * A fixed policy for every session. Absent, a session is read-only unless
   * it is bound to a login whose grant allows actions.
   */
  policy?: BrowserPolicy;
  connect: (connectUrl: string) => Promise<CdpSocket>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Total browser time this turn may use across sessions. */
  maxSessionMs?: number;
  onClosed?: (info: BrowserSessionClosedInfo) => Promise<void>;
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
  binding?: BrowserSessionBinding;
}

interface OpenOptions {
  binding?: BrowserSessionBinding;
  keepAlive?: boolean;
  timeoutSeconds?: number;
}

/** A hand-off window: how long a detached session stays open for the person. */
export const BROWSER_HANDOFF_SECONDS = 600;
/** Secrets shorter than this are not redacted from page text (they would erase ordinary words). */
const MIN_REDACTED_LENGTH = 4;

function sameBinding(left: BrowserSessionBinding | undefined, right: BrowserSessionBinding | undefined): boolean {
  return left?.loginId === right?.loginId;
}

/** A host without its port: Browserbase's domain allowlist names domains. */
function domainOf(host: string): string {
  return host.replace(/:\d+$/, '');
}

export class BrowserTurnSession {
  private current: ActiveSession | undefined;
  private opening: Promise<ActiveSession> | undefined;
  private closing: Promise<BrowserSessionClosedInfo | undefined> | undefined;
  private usedMs = 0;
  private readonly redactions = new Set<string>();
  /** Logins handed to a person this turn; browsing them again must wait for the reply. */
  readonly handedOff = new Set<string>();
  private readonly now: () => number;
  private readonly maxSessionMs: number;

  constructor(private readonly deps: BrowserTurnSessionDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSessionMs = deps.maxSessionMs ?? DEFAULT_BROWSER_SESSION_MS;
  }

  /**
   * What the open session allows. Public sessions and sessions on check-only
   * logins are read-only; a session on a login granted `act` is not.
   */
  get policy(): BrowserPolicy {
    return this.deps.policy ?? { readOnly: this.current?.binding?.level !== 'act' };
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

  /** The login the open session is bound to; undefined when public or closed. */
  get binding(): BrowserSessionBinding | undefined {
    return this.current?.binding;
  }

  /**
   * Remember a secret typed this turn so page text and errors shown to the
   * model replace it with [redacted].
   */
  addRedaction(value: string): void {
    if (value.length >= MIN_REDACTED_LENGTH) this.redactions.add(value);
  }

  redact(text: string): string {
    let result = text;
    for (const secret of this.redactions) result = result.split(secret).join('[redacted]');
    return result;
  }

  /** The open session, whichever login it is bound to; opens a public one when none is open. */
  async ensure(): Promise<{ page: BrowserPage; sessionId: string }> {
    return this.acquire({ any: true });
  }

  /**
   * A session bound to `binding` (public when undefined). An open session
   * bound elsewhere is ended first; the new one draws on the same budget.
   */
  async ensureFor(binding: BrowserSessionBinding | undefined): Promise<{ page: BrowserPage; sessionId: string }> {
    return this.acquire({ any: false, ...(binding ? { binding } : {}) });
  }

  /**
   * Ends any open session and opens a kept-alive one bound to `binding`, for
   * a person to sign in through its live view. Call `detach` once the link
   * is on its way.
   */
  async openForHandoff(binding: BrowserSessionBinding): Promise<{ page: BrowserPage; sessionId: string }> {
    if (this.opening) await this.opening.catch(() => undefined);
    await this.close();
    if (this.usedMs >= this.maxSessionMs) {
      throw new BrowserBudgetExhaustedError(Math.round(this.maxSessionMs / 60_000));
    }
    const session = await this.startOpening({ binding, keepAlive: true, timeoutSeconds: BROWSER_HANDOFF_SECONDS });
    return { page: session.page, sessionId: session.sessionId };
  }

  private async acquire(want: { any: boolean; binding?: BrowserSessionBinding }): Promise<{ page: BrowserPage; sessionId: string }> {
    // Bounded: each pass either returns, opens, or ends a mismatched session.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.closing) await this.closing;
      if (this.opening) await this.opening.catch(() => undefined);
      if (this.current) {
        if (!want.any && !sameBinding(this.current.binding, want.binding)) {
          await this.close();
          continue;
        }
        if (this.elapsedMs >= this.maxSessionMs) {
          await this.close();
          throw new BrowserBudgetExhaustedError(Math.round(this.maxSessionMs / 60_000));
        }
        return { page: this.current.page, sessionId: this.current.sessionId };
      }
      if (this.usedMs >= this.maxSessionMs) {
        throw new BrowserBudgetExhaustedError(Math.round(this.maxSessionMs / 60_000));
      }
      const session = await this.startOpening(want.binding ? { binding: want.binding } : {});
      if (want.any || sameBinding(session.binding, want.binding)) {
        return { page: session.page, sessionId: session.sessionId };
      }
    }
    throw new Error('The browser session changed while it was opening. Try again.');
  }

  private startOpening(options: OpenOptions): Promise<ActiveSession> {
    this.opening ??= this.open(options).finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(options: OpenOptions): Promise<ActiveSession> {
    const remainingMs = this.maxSessionMs - this.usedMs;
    const { binding } = options;
    const handle = await this.deps.provider.createSession({
      recording: true,
      viewport: { ...BROWSER_VIEWPORT },
      timeoutSeconds: options.timeoutSeconds ?? Math.ceil(remainingMs / 1000) + 60,
      // A bound session stays on its site. A hand-off session is driven by a
      // person who may need another domain to sign in (single sign-on), so it
      // carries no allowlist.
      ...(binding
        ? {
            contextId: binding.contextId,
            persistContext: true,
            ...(options.keepAlive ? {} : { allowedDomains: [domainOf(binding.host)] }),
          }
        : {}),
      ...(options.keepAlive ? { keepAlive: true } : {}),
    });
    const startedAt = this.now();
    try {
      // The CDP client and page driver load only when a turn actually
      // browses, which keeps them out of the Worker's startup graph.
      const [socket, { CdpClient }, { BrowserPage }] = await Promise.all([
        this.deps.connect(handle.connectUrl),
        import('./cdp.ts'),
        import('./page.ts'),
      ]);
      const client = new CdpClient(socket);
      try {
        const pageSessionId = await client.attachFirstPage();
        const page = new BrowserPage(client, pageSessionId, this.deps.sleep ? { sleep: this.deps.sleep } : {});
        const active: ActiveSession = { sessionId: handle.id, client, page, startedAt, ...(binding ? { binding } : {}) };
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
   * Lets the open session go without ending it: a kept-alive hand-off
   * session stays open for the person and ends by its own timeout, when the
   * provider saves its context. Its remaining time is not observable, so it
   * is tallied as 0 seconds now. Afterwards `close` has nothing to end.
   */
  async detach(): Promise<BrowserSessionClosedInfo | undefined> {
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.closing) await this.closing;
    const session = this.current;
    if (!session) return undefined;
    this.current = undefined;
    this.usedMs += Math.max(0, this.now() - session.startedAt);
    session.client.close();
    const info = { sessionId: session.sessionId, seconds: 0 };
    if (this.deps.onClosed) await this.deps.onClosed(info).catch(() => undefined);
    return info;
  }

  /**
   * Ends the session so its recording can be finalized. Returns the ended
   * session, or undefined when nothing was open.
   */
  async release(): Promise<BrowserSessionClosedInfo | undefined> {
    return this.close();
  }
}
