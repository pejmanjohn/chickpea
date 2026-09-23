import {
  BrowserProviderError,
  type BrowserLiveView,
  type BrowserProvider,
  type BrowserRecordingDownload,
  type BrowserSessionHandle,
  type CreateBrowserSessionOptions,
} from './provider.ts';

export interface BrowserbaseProviderOptions {
  apiKey: string;
  projectId?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.browserbase.com';
const ERROR_BODY_LIMIT = 300;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createBrowserbaseProvider(options: BrowserbaseProviderOptions): BrowserProvider {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const apiKey = options.apiKey;

  const redact = (text: string) => (apiKey ? text.split(apiKey).join('[redacted]') : text);

  async function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { 'X-BB-API-Key': apiKey, Accept: 'application/json' };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BrowserProviderError(`Browserbase request failed: ${method} ${path}: ${redact(message).slice(0, ERROR_BODY_LIMIT)}`);
    }
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      const snippet = redact(text).slice(0, ERROR_BODY_LIMIT);
      throw new BrowserProviderError(
        `Browserbase ${method} ${path} returned ${response.status}${snippet ? `: ${snippet}` : ''}`,
        response.status,
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
      if (opts.viewport) browserSettings.viewport = { width: opts.viewport.width, height: opts.viewport.height };
      if (opts.contextId) browserSettings.context = { id: opts.contextId, persist: opts.persistContext ?? false };
      if (opts.allowedDomains && opts.allowedDomains.length > 0) browserSettings.allowedDomains = [...opts.allowedDomains];
      const body: Json = { browserSettings };
      if (options.projectId) body.projectId = options.projectId;
      if (opts.keepAlive !== undefined) body.keepAlive = opts.keepAlive;
      if (opts.timeoutSeconds !== undefined) body.timeout = opts.timeoutSeconds;
      const { data } = await request('POST', '/v1/sessions', body);
      const obj = asObject(data);
      const id = str(obj.id);
      const connectUrl = str(obj.connectUrl);
      if (!id || !connectUrl) throw new BrowserProviderError('Browserbase session response is missing id or connectUrl');
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

    async createContext(name?: string): Promise<{ id: string }> {
      const body: Json = {};
      if (options.projectId) body.projectId = options.projectId;
      if (name) body.name = name;
      const { data } = await request('POST', '/v1/contexts', body);
      const id = str(asObject(data).id);
      if (!id) throw new BrowserProviderError('Browserbase context response is missing id');
      return { id };
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
}): Promise<BrowserbaseKeyVerification> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/v1/projects`, {
      method: 'GET',
      headers: { 'X-BB-API-Key': options.apiKey, Accept: 'application/json' },
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
