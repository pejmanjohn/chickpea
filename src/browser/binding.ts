/**
 * Which granted website login a browser session is bound to. The plan's
 * frozen logins are the ceiling for the turn; they are intersected with the
 * Agent's live grants once, on first use, and the live grants are read again
 * only where a revocation must stop the next step: when a session is bound to
 * a login, before `browser_sign_in` reads secrets, and when an approved step
 * is claimed. Reading or looking at an open page never reads the store.
 */
import {
  getWebsiteLogin,
  intersectFrozenWebsiteLogins,
  setWebsiteLoginContext,
  touchWebsiteLoginUsed,
  setWebsiteLoginHandoff,
  type FrozenWebsiteLoginEntry,
  type WebsiteLogin,
  type WebsiteLoginDependencies,
} from './logins.ts';
import {
  BROWSER_LOGIN_REVOKED_MESSAGE,
  BROWSER_NO_LOGINS_MESSAGE,
  BROWSER_NO_PAGE_MESSAGE,
  BROWSER_UNKNOWN_LOGIN_MESSAGE,
} from './messages.ts';
import type { BrowserPage } from './page.ts';
import type { BrowserSessionBinding, BrowserTurnSession } from './turn-session.ts';

/** A granted website login as the tools see it: metadata only, never a secret. */
export interface BrowserWebsiteLogin extends FrozenWebsiteLoginEntry {
  label: string;
  username?: string;
}

export interface BrowserLoginOptions {
  /** The logins frozen into the turn's plan: the ceiling for this turn. */
  granted: readonly BrowserWebsiteLogin[];
  /** The Agent's current grants joined with login metadata, read at call time. */
  readLive: () => Promise<readonly FrozenWebsiteLoginEntry[]>;
  /** Login storage; secrets are read from it only inside `browser_sign_in`. */
  dependencies: () => Promise<WebsiteLoginDependencies>;
}

/** The live grants for one tool call: the first use reads them, later uses reuse that read. */
export type LiveLogins = () => Promise<readonly BrowserWebsiteLogin[]>;

const HANDOFF_END_POLL_MS = 1_000;
const HANDOFF_END_WAIT_MS = 10_000;

/**
 * Whether `url` is on a login's host: the same host or a subdomain of it, on
 * the same port. A login host may carry an explicit non-default port.
 */
export function websiteLoginMatchesUrl(loginHost: string, url: URL): boolean {
  const match = /^(.*?)(?::(\d+))?$/.exec(loginHost);
  const hostname = match?.[1] ?? loginHost;
  const port = match?.[2] ?? '';
  if (url.port !== port) return false;
  const target = url.hostname.toLowerCase();
  return target === hostname || target.endsWith(`.${hostname}`);
}

/**
 * The one rule for a login id: a login still in `logins` (grants intersected
 * with the frozen plan) is usable; one the plan granted but `logins` lacks was
 * revoked; anything else was never granted.
 */
export function classifyGrantedLogin(
  granted: readonly BrowserWebsiteLogin[],
  logins: readonly BrowserWebsiteLogin[],
  loginId: string,
): BrowserWebsiteLogin | 'unknown' | 'revoked' {
  const login = logins.find(({ id }) => id === loginId);
  if (login) return login;
  return granted.some(({ id }) => id === loginId) ? 'revoked' : 'unknown';
}

/**
 * Only browser_open starts a session. Every other tool needs a page that is
 * already open, so a stray call after browser_recording ended the session
 * cannot quietly start (and pay for) a blank one.
 */
export async function requireOpenPage(
  session: BrowserTurnSession,
): Promise<{ page: BrowserPage; sessionId: string }> {
  if (!session.active) throw new Error(BROWSER_NO_PAGE_MESSAGE);
  return session.ensure();
}

export class BrowserLoginBinder {
  #mounted: Promise<readonly BrowserWebsiteLogin[]> | undefined;

  constructor(
    private readonly session: BrowserTurnSession,
    private readonly options: BrowserLoginOptions | undefined,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  get granted(): readonly BrowserWebsiteLogin[] {
    return this.options?.granted ?? [];
  }

  /** The plan's logins intersected with the live grants, read once per turn. */
  mounted(): Promise<readonly BrowserWebsiteLogin[]> {
    return (this.#mounted ??= this.readLive());
  }

  /**
   * A live read scoped to one tool call. What it finds also narrows the
   * mounted list for the rest of the turn.
   */
  liveReader(): LiveLogins {
    let read: Promise<readonly BrowserWebsiteLogin[]> | undefined;
    return () => (read ??= this.readLive().then((logins) => {
      this.#mounted = Promise.resolve(logins);
      return logins;
    }));
  }

  /** A login by id for the sign-in tools, or the refusal to return. */
  async find(loginId: string, logins: readonly BrowserWebsiteLogin[]): Promise<BrowserWebsiteLogin | string> {
    if (!this.granted.length) return BROWSER_NO_LOGINS_MESSAGE;
    const login = classifyGrantedLogin(this.granted, logins, loginId);
    if (login === 'unknown') return BROWSER_UNKNOWN_LOGIN_MESSAGE;
    if (login === 'revoked') return this.revoked(loginId);
    return login;
  }

  /**
   * The granted login a URL opens with, if any. The most specific host wins;
   * logins sharing it need an explicit loginId. A site whose grant was
   * revoked this turn refuses rather than opening signed out.
   *
   * A loginId that names no granted login is ignored on a site no grant
   * covers: that page opens public and read-only, as it would without one.
   * On a granted site it is refused, so it never falls back to another login.
   */
  async loginForUrl(url: string, loginId: string | undefined): Promise<BrowserWebsiteLogin | undefined> {
    if (!this.granted.length) return undefined;
    const target = new URL(url);
    const logins = await this.mounted();
    const matches = (candidates: readonly BrowserWebsiteLogin[]) =>
      candidates.filter((login) => websiteLoginMatchesUrl(login.host, target));
    const grantedSite = matches(this.granted).length > 0;
    if (loginId) {
      const login = classifyGrantedLogin(this.granted, logins, loginId);
      if (login === 'unknown') {
        if (grantedSite) throw new Error(BROWSER_UNKNOWN_LOGIN_MESSAGE);
        return undefined;
      }
      const host = login === 'revoked' ? this.granted.find(({ id }) => id === loginId)!.host : login.host;
      if (!websiteLoginMatchesUrl(host, target)) throw new Error(`That login is for ${host}. Open a URL on that site.`);
      if (login === 'revoked') throw new Error(BROWSER_LOGIN_REVOKED_MESSAGE);
      return login;
    }
    const live = matches(logins);
    if (live.length === 0) {
      if (grantedSite) throw new Error(BROWSER_LOGIN_REVOKED_MESSAGE);
      return undefined;
    }
    const specificity = (login: BrowserWebsiteLogin) => login.host.replace(/:\d+$/, '').length;
    const best = Math.max(...live.map(specificity));
    const top = live.filter((login) => specificity(login) === best);
    if (top.length > 1) {
      const choices = top.map(({ id, label }) => `${label} (${id})`).join(', ');
      throw new Error(`Several granted logins match this site: ${choices}. Call browser_open again with loginId.`);
    }
    return top[0];
  }

  /**
   * The binding for a login's session, checked against the live grants and
   * creating its browser context on first use.
   */
  async bindingFor(login: BrowserWebsiteLogin, live: LiveLogins): Promise<BrowserSessionBinding> {
    const current = classifyGrantedLogin(this.granted, await live(), login.id);
    if (typeof current === 'string') throw new Error(await this.revoked(login.id));
    const bound = this.session.binding;
    if (bound?.loginId === current.id) return bound;
    const deps = await this.options!.dependencies();
    const stored = await getWebsiteLogin(deps.store, current.id);
    if (!stored || stored.host !== current.host) throw new Error(BROWSER_LOGIN_REVOKED_MESSAGE);
    await this.finishHandoff(deps, stored);
    let contextId = stored.contextId;
    if (!contextId) {
      contextId = (await this.session.provider.createContext(stored.label)).id;
      await setWebsiteLoginContext(deps.store, stored.id, contextId);
    }
    // Opening the site on its saved session is a use of the login, signed in or not.
    await touchWebsiteLoginUsed(deps.store, stored.id, this.now()).catch(() => undefined);
    return { loginId: stored.id, host: stored.host, contextId, level: current.level };
  }

  /**
   * The revocation refusal. A session still bound to the revoked login is
   * ended first, so its signed-in page is not used again.
   */
  async revoked(loginId: string): Promise<string> {
    if (this.session.binding?.loginId !== loginId) return BROWSER_LOGIN_REVOKED_MESSAGE;
    await this.session.close().catch(() => undefined);
    return `${BROWSER_LOGIN_REVOKED_MESSAGE} The signed-in browser was closed.`;
  }

  private async readLive(): Promise<readonly BrowserWebsiteLogin[]> {
    if (!this.options) return [];
    // A failed live read grants nothing.
    const live = await this.options.readLive().catch(() => []);
    return intersectFrozenWebsiteLogins(this.options.granted, live);
  }

  /**
   * End a hand-off session a person may have left open, so the provider
   * saves its sign-in to the context before a new session loads it.
   */
  private async finishHandoff(deps: WebsiteLoginDependencies, stored: WebsiteLogin): Promise<void> {
    const sessionId = stored.handoffSessionId;
    if (!sessionId) return;
    await this.session.provider.endSession(sessionId).catch(() => undefined);
    const deadline = Date.now() + HANDOFF_END_WAIT_MS;
    for (;;) {
      const status = await this.session.provider.sessionStatus(sessionId).catch(() => 'UNKNOWN');
      if (status !== 'RUNNING' && status !== 'PENDING') break;
      if (Date.now() >= deadline) break;
      await this.sleep(HANDOFF_END_POLL_MS);
    }
    await setWebsiteLoginHandoff(deps.store, stored.id, undefined).catch(() => undefined);
  }
}
