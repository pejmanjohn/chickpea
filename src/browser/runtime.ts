/**
 * Runtime wiring for the browser tools: a provider that reads the install's
 * key at call time, and a per-instance session that survives Flue's
 * re-render before every model turn.
 */
import { useAgentFinish, useResponseStart } from '@flue/runtime';

import type { BrowserProvider } from './provider.ts';
import { BrowserNotConnectedError } from './tools.ts';
import type { BrowserTurnSession } from './turn-session.ts';

/**
 * Forwards every method call to the object `resolve` returns. Properties in
 * `fixed` are answered directly; `then` is never forwarded so the forwarder
 * is not mistaken for a promise.
 */
function forwardMethods<T extends object>(fixed: Partial<T>, resolve: () => Promise<T>): T {
  return new Proxy(fixed, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return async (...args: unknown[]) => {
        const real = await resolve();
        return (Reflect.get(real, key) as (...values: unknown[]) => unknown).apply(real, args);
      };
    },
  }) as T;
}

/**
 * A BrowserProvider that resolves the real provider on first use. The
 * resolver reads current settings, so a key removed after the turn was
 * admitted fails closed with BrowserNotConnectedError. A failed resolve is
 * not cached; a successful one is reused for the rest of the turn.
 */
export function createLazyBrowserProvider(
  resolve: () => Promise<BrowserProvider | undefined>,
): BrowserProvider {
  let resolved: BrowserProvider | undefined;
  return forwardMethods<BrowserProvider>({ id: 'browserbase' }, async () => {
    if (resolved) return resolved;
    const provider = await resolve();
    if (!provider) throw new BrowserNotConnectedError();
    resolved = provider;
    return provider;
  });
}

/**
 * Flue re-renders the agent function before every model turn, so a session
 * created in one render must be found again by the next. Keyed by the agent
 * instance id: one response runs at a time per instance.
 */
const sessions = new Map<string, BrowserTurnSession>();

export function browserSessionFor(key: string, create: () => BrowserTurnSession): BrowserTurnSession {
  let session = sessions.get(key);
  if (!session) {
    session = create();
    sessions.set(key, session);
  }
  return session;
}

/**
 * Root-Agent hook: the response's browser session. The session is shared by
 * every render of one response and always ends when the response would stop.
 *
 * A response starts clean: a session still registered when it starts was
 * left by a response that stopped without its finish hook, so it is ended and
 * replaced. The render that declares the start hook runs before it, so the
 * returned handle forwards to the registered session at call time rather
 * than holding the one that render found.
 */
export function useBrowserSession(id: string, create: () => BrowserTurnSession): BrowserTurnSession {
  let created = false;
  browserSessionFor(id, () => {
    created = true;
    return create();
  });
  useResponseStart(() => {
    if (created) return;
    const stale = sessions.get(id);
    sessions.set(id, create());
    void stale?.close().catch(() => {
      console.warn('[chickpea] A stale browser session did not end cleanly; the provider timeout will end it');
    });
  });
  useAgentFinish(async () => {
    const session = sessions.get(id);
    sessions.delete(id);
    try {
      await session?.close();
    } catch {
      console.warn('[chickpea] Browser session did not end cleanly; the provider timeout will end it');
    }
  });
  const current = () => browserSessionFor(id, create);
  return new Proxy({} as BrowserTurnSession, {
    get(_target, key) {
      const session = current();
      const value: unknown = Reflect.get(session, key, session);
      return typeof value === 'function' ? value.bind(session) : value;
    },
  });
}
