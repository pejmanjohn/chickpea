/**
 * A card's side of MCP Apps: JSON-RPC 2.0 over `postMessage` with the host.
 * ext-apps' `App` does this too, but it ships as one prebundled file with zod
 * and the MCP SDK (about 390 KB minified), so even its two theme helpers cost
 * the whole file. This covers what a card uses: the handshake, the tool
 * result, host context, tool calls, messages, model context, links and size.
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
  /** ChatGPT's cursor for things a person can press, such as `pointer`. */
  'openai/interactionCursor'?: string;
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
  /** The `_meta` of the tool result this card draws, which ChatGPT keeps from its model. */
  toolResponseMetadata?: unknown;
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
    this.on('ui/notifications/host-context-changed', (params) => {
      const changed = params as HostContext;
      const { styles, ...kept } = this.hostContext ?? {};
      // Style variables are one theme's colors: a new theme without its own drops them.
      const flipped = changed.theme !== undefined && changed.theme !== kept.theme && !changed.styles;
      this.hostContext = { ...kept, ...styles && !flipped ? { styles } : {}, ...changed };
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

  /**
   * A tool call through the host. After a timeout the call rejects, and a
   * reply that still comes goes to `late`: a write may have run after all.
   */
  async callTool(name: string, args: Record<string, unknown>, late: (result: CallToolResult) => void): Promise<CallToolResult> {
    return await this.#request('tools/call', { name, arguments: args }, late as (value: unknown) => void) as CallToolResult;
  }

  /**
   * A message from the person to the chat. With a draft and a host that takes
   * one, it waits in the composer for them to finish; otherwise `sent` goes.
   */
  async sendMessage(message: { draft?: string | undefined; sent: string }): Promise<void> {
    const drafts = this.hostCapabilities?.experimental?.['openai/message']?.draft !== undefined;
    const text = message.draft !== undefined && drafts ? message.draft : message.sent;
    refused(await this.#request('ui/message', {
      role: 'user',
      content: [{ type: 'text', text }],
      ...text === message.draft ? { _meta: { 'openai/message': { target: 'active', send: false } } } : {},
    }));
  }

  /**
   * Tells the host's model what the card did, for its next turn. Each call
   * replaces this card's last one; a host that keeps no model context refuses.
   */
  async updateModelContext(text: string): Promise<void> {
    refused(await this.#request('ui/update-model-context', { content: [{ type: 'text', text }] }));
  }

  /**
   * Opens a link outside the chat. ChatGPT's own call skips the host's
   * redirect parameter; a host that refuses it may still take the standard request.
   */
  async openLink(url: string): Promise<void> {
    if (window.openai?.openExternal) {
      try {
        await window.openai.openExternal({ href: url, redirectUrl: false });
        return;
      } catch {
        // Fall through to ui/open-link.
      }
    }
    refused(await this.#request('ui/open-link', { url }));
  }

  #notify(method: string, params: unknown): void {
    window.parent.postMessage({ jsonrpc: '2.0', method, params } satisfies Rpc, '*');
  }

  #request(method: string, params: unknown, late?: (value: unknown) => void): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (late) this.#pending.set(id, { resolve: late, reject: () => undefined });
        else this.#pending.delete(id);
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

/** A host's `{ isError: true }` reply to a message or a link. */
function refused(result: unknown): void {
  if ((result as { isError?: unknown } | undefined)?.isError === true) throw new Error('The host refused it');
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

let applied: string[] = [];

/**
 * The host's theme, style variables and cursor, as given now. A variable it
 * no longer gives is removed, so the card's own colors for the theme show.
 */
export function applyHostContext(context: HostContext | undefined): void {
  if (context?.theme) applyDocumentTheme(context.theme);
  const cursor = context?.['openai/interactionCursor'];
  const variables: Record<string, string | undefined> = {
    ...context?.styles?.variables,
    // Only a keyword: a url() cursor would fetch something.
    '--cursor-interaction': typeof cursor === 'string' && /^[a-z-]+$/.test(cursor) ? cursor : undefined,
  };
  for (const name of applied) {
    if (variables[name] === undefined) document.documentElement.style.removeProperty(name);
  }
  applyHostStyleVariables(variables);
  applied = Object.keys(variables).filter((name) => variables[name] !== undefined);
}
