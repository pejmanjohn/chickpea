/**
 * Runtime wiring for the browser tools: a provider that reads the install's
 * key at call time, and a per-instance session registry that survives Flue's
 * re-render before every model turn.
 */
import type { BrowserProvider } from './provider.ts';
import { BrowserNotConnectedError } from './tools.ts';
import type { BrowserTurnSession } from './turn-session.ts';

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
  const get = async (): Promise<BrowserProvider> => {
    if (resolved) return resolved;
    const provider = await resolve();
    if (!provider) throw new BrowserNotConnectedError();
    resolved = provider;
    return provider;
  };
  return {
    id: 'browserbase',
    createSession: async (options) => (await get()).createSession(options),
    endSession: async (sessionId) => (await get()).endSession(sessionId),
    sessionStatus: async (sessionId) => (await get()).sessionStatus(sessionId),
    liveView: async (sessionId) => (await get()).liveView(sessionId),
    requestRecordingDownloads: async (sessionId) => (await get()).requestRecordingDownloads(sessionId),
    listRecordingDownloads: async (sessionId) => (await get()).listRecordingDownloads(sessionId),
    createContext: async (name) => (await get()).createContext(name),
  };
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

/** Ends and forgets the instance's session. Safe to call when none exists. */
export async function endBrowserSessionFor(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  await session.close();
}
