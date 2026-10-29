import {
  BrowserProviderError,
  type BrowserContextOwner,
  type BrowserLiveView,
  type BrowserProvider,
  type BrowserRecordingDownload,
  type BrowserSessionHandle,
  type CreateBrowserSessionOptions,
} from './provider.ts';
import { isRecord } from '../security/content-validation.ts';

export interface BrowserbaseProviderOptions {
  apiKey: string;
  projectId?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** The name a website login's new context gets; its label by default. */
  contextName?: (login: BrowserContextOwner) => string;
}

/** A context's owner record, as the provider keeps it. */
export interface BrowserbaseContextRecord {
  id: string;
  projectId: string;
  name: string;
}

/** A session's owner record and state, as the provider keeps it. */
export interface BrowserbaseSessionRecord {
  id: string;
  projectId: string;
  status: string;
  contextId?: string;
  /** Absent when the response carries none, which is not the same as an empty one. */
  userMetadata?: Record<string, unknown>;
}

/** A session list, and whether the answer or an entry in it was not the shape documented. */
export interface BrowserbaseSessionList {
  sessions: BrowserbaseSessionRecord[];
  malformed: boolean;
}

/** The provider, plus the owner reads a deployment serving many installations checks against. */
export interface BrowserbaseClient extends BrowserProvider {
  getContext(contextId: string): Promise<BrowserbaseContextRecord>;
  getSession(sessionId: string): Promise<BrowserbaseSessionRecord>;
  /**
   * Sessions whose user metadata holds `metadata.key` equal to
   * `metadata.value`, optionally in one status. The provider documents no
   * pagination for this list, so it may be incomplete.
   */
  listSessions(filter: { metadata: { key: string; value: string }; status?: string }): Promise<BrowserbaseSessionList>;
}

/**
 * A create Browserbase answered without a session to connect to. When the
 * answer named one anyway, that session may be running and billed.
 */
export class BrowserbaseIncompleteSessionError extends BrowserProviderError {
  constructor(readonly sessionId: string | undefined) {
    super('Browserbase session response is missing id or connectUrl');
  }
}

const DEFAULT_BASE_URL = 'https://api.browserbase.com';
const ERROR_BODY_LIMIT = 300;
/**
 * Every call is bounded: a stalled Browserbase must not hold an Admin
 * request, a login's deletion, or a maintenance sweep for the platform's
 * own socket timeout.
 */
const REQUEST_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after') ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function sessionRecord(value: unknown): BrowserbaseSessionRecord {
  const obj = asObject(value);
  const id = str(obj.id);
  const status = str(obj.status);
  if (!id || !status) throw new BrowserProviderError('Browserbase session response is missing id or status');
  const contextId = str(obj.contextId);
  return {
    id,
    projectId: str(obj.projectId),
    status,
    ...(contextId ? { contextId } : {}),
    ...(isRecord(obj.userMetadata) ? { userMetadata: obj.userMetadata } : {}),
  };
}

export function createBrowserbaseProvider(options: BrowserbaseProviderOptions): BrowserbaseClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // The exact key, whatever its shape: an environment key is never checked
  // against the bb_ signature that the shared redactor recognizes.
  const redact = (text: string) => (apiKey ? text.split(apiKey).join('[redacted]') : text);

  async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { 'X-BB-API-Key': apiKey, Accept: 'application/json' };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (error) {
      // No status, like any failure to reach Browserbase: every caller tries again later.
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserProviderError(`Browserbase request timed out: ${method} ${path}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserProviderError(`Browserbase request failed: ${method} ${path}: ${redact(message).slice(0, ERROR_BODY_LIMIT)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const snippet = redact(text).slice(0, ERROR_BODY_LIMIT);
      throw new BrowserProviderError(
        `Browserbase ${method} ${path} returned ${response.status}${snippet ? `: ${snippet}` : ''}`,
        response.status,
        response.status === 429 ? retryAfterMs(response) : undefined,
      );
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data };
  }

  const sessionPath = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

  return {
    id: 'browserbase',

    async createSession(opts: CreateBrowserSessionOptions): Promise<BrowserSessionHandle> {
      const browserSettings: Json = { recordSession: opts.recording ?? true };
      if (opts.logSession !== undefined) browserSettings.logSession = opts.logSession;
      if (opts.viewport) browserSettings.viewport = { width: opts.viewport.width, height: opts.viewport.height };
      if (opts.contextId) browserSettings.context = { id: opts.contextId, persist: opts.persistContext ?? false };
      if (opts.allowedDomains && opts.allowedDomains.length > 0) browserSettings.allowedDomains = [...opts.allowedDomains];
      const body: Json = { browserSettings };
      if (options.projectId) body.projectId = options.projectId;
      if (opts.userMetadata) body.userMetadata = { ...opts.userMetadata };
      if (opts.keepAlive !== undefined) body.keepAlive = opts.keepAlive;
      if (opts.timeoutSeconds !== undefined) body.timeout = opts.timeoutSeconds;
      const { data } = await request('POST', '/v1/sessions', body);
      const obj = asObject(data);
      const id = str(obj.id);
      const connectUrl = str(obj.connectUrl);
      if (!id || !connectUrl) throw new BrowserbaseIncompleteSessionError(id || undefined);
      const handle: BrowserSessionHandle = { id, connectUrl };
      const contextId = str(obj.contextId) || opts.contextId;
      if (contextId) handle.contextId = contextId;
      return handle;
    },

    async endSession(sessionId: string): Promise<void> {
      await request('POST', sessionPath(sessionId), { status: 'REQUEST_RELEASE' });
    },

    async sessionStatus(sessionId: string): Promise<string> {
      const { data } = await request('GET', sessionPath(sessionId));
      const status = str(asObject(data).status);
      if (!status) throw new BrowserProviderError('Browserbase session response is missing status');
      return status;
    },

    async getSession(sessionId: string): Promise<BrowserbaseSessionRecord> {
      return sessionRecord((await request('GET', sessionPath(sessionId))).data);
    },

    async listSessions(filter): Promise<BrowserbaseSessionList> {
      const { key, value } = filter.metadata;
      if (/['\\]/.test(key) || /['\\]/.test(value)) throw new BrowserProviderError('A session metadata filter cannot hold a quote');
      const query = new URLSearchParams({
        ...(filter.status ? { status: filter.status } : {}),
        q: `user_metadata['${key}']:'${value}'`,
      });
      const { data } = await request('GET', `/v1/sessions?${query}`);
      const wrapper = asObject(data);
      const list: unknown[] | undefined = Array.isArray(data)
        ? data
        : Array.isArray(wrapper.sessions) ? wrapper.sessions : Array.isArray(wrapper.data) ? wrapper.data : undefined;
      if (!list) return { sessions: [], malformed: true };
      const sessions: BrowserbaseSessionRecord[] = [];
      let malformed = false;
      for (const entry of list) {
        try {
          sessions.push(sessionRecord(entry));
        } catch {
          malformed = true;
        }
      }
      return { sessions, malformed };
    },

    async liveView(sessionId: string): Promise<BrowserLiveView> {
      const { data } = await request('GET', `${sessionPath(sessionId)}/debug`);
      const obj = asObject(data);
      const pages = Array.isArray(obj.pages) ? obj.pages : [];
      return {
        fullscreenUrl: str(obj.debuggerFullscreenUrl),
        url: str(obj.debuggerUrl),
        pages: pages.map((page) => {
          const p = asObject(page);
          return { id: str(p.id), url: str(p.url), title: str(p.title), fullscreenUrl: str(p.debuggerFullscreenUrl) };
        }),
      };
    },

    async requestRecordingDownloads(sessionId: string): Promise<void> {
      await request('POST', `${sessionPath(sessionId)}/recording/downloads`);
    },

    async listRecordingDownloads(sessionId: string): Promise<BrowserRecordingDownload[]> {
      const { data } = await request('GET', `${sessionPath(sessionId)}/recording/downloads`);
      // Browserbase answers `{ downloads: [...] }`; a bare array or `pages`
      // are accepted too so a response-shape change does not silently empty it.
      const wrapper = asObject(data);
      const list: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray(wrapper.downloads)
          ? wrapper.downloads
          : Array.isArray(wrapper.pages)
            ? wrapper.pages
            : [];
      return list.map((entry) => {
        const e = asObject(entry);
        const download: BrowserRecordingDownload = { pageId: str(e.pageId), status: str(e.status) };
        const url = str(e.downloadUrl);
        if (url) download.downloadUrl = url;
        return download;
      });
    },

    async createContext(login: BrowserContextOwner): Promise<{ id: string }> {
      const body: Json = {};
      if (options.projectId) body.projectId = options.projectId;
      const name = options.contextName ? options.contextName(login) : login.label;
      if (name) body.name = name;
      const { data } = await request('POST', '/v1/contexts', body);
      const id = str(asObject(data).id);
      if (!id) throw new BrowserProviderError('Browserbase context response is missing id');
      return { id };
    },

    // This project's own contexts are trusted; a gone one fails the session that loads it.
    async checkContext(): Promise<void> {},

    async getContext(contextId: string): Promise<BrowserbaseContextRecord> {
      const obj = asObject((await request('GET', `/v1/contexts/${encodeURIComponent(contextId)}`)).data);
      const id = str(obj.id);
      if (!id) throw new BrowserProviderError('Browserbase context response is missing id');
      return { id, projectId: str(obj.projectId), name: str(obj.name) };
    },

    async deleteContext(contextId: string): Promise<void> {
      try {
        await request('DELETE', `/v1/contexts/${encodeURIComponent(contextId)}`);
      } catch (error) {
        if (!(error instanceof BrowserProviderError) || error.status !== 404) throw error;
      }
    },
  };
}

export type BrowserbaseKeyVerification =
  | { ok: true; projectId?: string }
  | { ok: false; reason: 'invalid_key' | 'unreachable'; status?: number };

/**
 * Check a pasted Browserbase API key against `GET /v1/projects` before it is
 * stored. A single visible project is returned so the caller can remember it;
 * the key itself never appears in the result.
 */
export async function verifyBrowserbaseApiKey(options: {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<BrowserbaseKeyVerification> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/v1/projects`, {
      method: 'GET',
      headers: { 'X-BB-API-Key': options.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'invalid_key', status: response.status };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'unreachable', status: response.status };
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    data = undefined;
  }
  if (Array.isArray(data) && data.length === 1) {
    const projectId = str(asObject(data[0]).id).trim();
    if (projectId) return { ok: true, projectId };
  }
  return { ok: true };
}
