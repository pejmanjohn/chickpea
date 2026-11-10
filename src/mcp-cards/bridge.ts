/**
 * A card's side of MCP Apps: JSON-RPC 2.0 over `postMessage` with the host.
 * ext-apps' `App` does this too, but it ships as one prebundled file with zod
 * and the MCP SDK (about 390 KB minified), so even its two theme helpers cost
 * the whole file. This covers what a card uses: the handshake, the tool
 * result, host context, tool calls, messages, links and size.
 */

/** ext-apps 1.7.5's `LATEST_PROTOCOL_VERSION`; a test keeps them equal. */
export const PROTOCOL_VERSION = '2026-01-26';

/**
 * The parts of MCP Apps' host context and capabilities a card reads. ext-apps'
 * own declarations re-export without file extensions, which this project's
 * NodeNext resolution cannot follow.
 */
export type HostTheme = 'light' | 'dark';
export interface HostContext {
  theme?: HostTheme;
  styles?: { variables?: Record<string, string | undefined> };
}
interface HostCapabilities {
  experimental?: Record<string, { draft?: unknown } | undefined>;
}

export interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** ChatGPT's own bridge, where it has one; every use is feature-detected. */
interface OpenAiGlobals {
  openExternal?: (options: { href: string; redirectUrl?: false }) => Promise<void> | void;
  widgetState?: unknown;
  setWidgetState?: (state: unknown) => Promise<void> | void;
}

declare global {
  interface Window {
    openai?: OpenAiGlobals;
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

export class HostBridge {
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  readonly #listeners = new Map<string, Array<(params: unknown) => void>>();
  hostContext: HostContext | undefined;
  hostCapabilities: HostCapabilities | undefined;

  constructor(readonly appInfo: { name: string; version: string }) {
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      this.#receive(event.data as Rpc);
    });
    this.on('ui/notifications/host-context-changed', (changed) => {
      this.hostContext = { ...this.hostContext, ...changed as HostContext };
    });
  }

  /** Listen before `connect`, so the first tool result is not missed. */
  on(method: string, listener: (params: unknown) => void): void {
    this.#listeners.set(method, [...this.#listeners.get(method) ?? [], listener]);
  }

  async connect(): Promise<void> {
    const result = await this.#request('ui/initialize', {
      appInfo: this.appInfo,
      appCapabilities: { availableDisplayModes: ['inline'] },
      protocolVersion: PROTOCOL_VERSION,
    }) as { hostContext?: HostContext; hostCapabilities?: HostCapabilities } | undefined;
    this.hostContext = result?.hostContext;
    this.hostCapabilities = result?.hostCapabilities;
    this.#notify('ui/notifications/initialized', {});
    new ResizeObserver(() => this.#notify('ui/notifications/size-changed', {
      height: Math.ceil(document.body.getBoundingClientRect().height),
    })).observe(document.body);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return await this.#request('tools/call', { name, arguments: args }) as CallToolResult;
  }

  /**
   * A message from the person to the chat. With a draft and a host that takes
   * one, it waits in the composer for them to finish; otherwise `sent` goes.
   */
  async sendMessage(message: { draft?: string | undefined; sent: string }): Promise<void> {
    const drafts = this.hostCapabilities?.experimental?.['openai/message']?.draft !== undefined;
    const text = message.draft !== undefined && drafts ? message.draft : message.sent;
    await this.#request('ui/message', {
      role: 'user',
      content: [{ type: 'text', text }],
      ...text === message.draft ? { _meta: { 'openai/message': { target: 'active', send: false } } } : {},
    });
  }

  /** Opens a link outside the chat. ChatGPT's own call skips the host's redirect parameter. */
  async openLink(url: string): Promise<void> {
    if (window.openai?.openExternal) {
      await window.openai.openExternal({ href: url, redirectUrl: false });
      return;
    }
    await this.#request('ui/open-link', { url });
  }

  #notify(method: string, params: unknown): void {
    window.parent.postMessage({ jsonrpc: '2.0', method, params } satisfies Rpc, '*');
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params } satisfies Rpc, '*');
    });
  }

  #receive(message: Rpc): void {
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === undefined) {
      const pending = typeof message.id === 'number' ? this.#pending.get(message.id) : undefined;
      if (!pending) return;
      this.#pending.delete(message.id as number);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
      return;
    }
    for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    // A host request this card has no handler for (ping, teardown) gets an empty result.
    if (message.id !== undefined) window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} } satisfies Rpc, '*');
  }
}

/** ext-apps' `applyDocumentTheme`. */
export function applyDocumentTheme(theme: HostTheme): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

/** ext-apps' `applyHostStyleVariables`. */
export function applyHostStyleVariables(styles: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(styles)) {
    if (value !== undefined) document.documentElement.style.setProperty(name, value);
  }
}

/** The host's theme and style variables, as given now. */
export function applyHostContext(context: HostContext | undefined): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
