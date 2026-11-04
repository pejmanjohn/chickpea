export const CANVASES_PROBE_METHODS = [
  'auth.test', 'conversations.info', 'files.info',
  'canvases.getContent', 'canvases.sections.lookup',
  'conversations.canvases.create', 'canvases.create', 'canvases.edit', 'canvases.access.set',
  'canvases.delete',
] as const;

export type CanvasesProbeMethod = typeof CANVASES_PROBE_METHODS[number];
const JSON_METHODS: ReadonlySet<CanvasesProbeMethod> = new Set([
  'canvases.getContent', 'canvases.sections.lookup', 'conversations.canvases.create',
  'canvases.create', 'canvases.edit', 'canvases.access.set', 'canvases.delete',
]);
type JsonObject = Record<string, unknown>;

export interface CanvasesProbeSpec {
  workspaceId: string;
  channelIds: readonly string[];
  canvasIds: readonly string[];
  cleanupCanvasIds: readonly string[];
}

export interface CanvasesProbeReceipt {
  attemptId: string;
  method: CanvasesProbeMethod;
  at: string;
  phase: 'dispatching' | 'observed' | 'unknown';
  request?: JsonObject;
  status?: number;
  scopes?: string[];
  retryAfter?: string | null;
  response?: JsonObject;
}

export class SlackCanvasesProbe {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #record: (receipt: CanvasesProbeReceipt) => Promise<void>;
  readonly #attempts = new Set<string>();
  #authenticatedWorkspace: string | undefined;

  constructor(options: {
    token: string;
    record: (receipt: CanvasesProbeReceipt) => Promise<void>;
    fetch?: typeof fetch;
  }) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(options.token)) throw new Error('A QA bot token is required.');
    this.#token = options.token;
    this.#record = options.record;
    this.#fetch = options.fetch ?? fetch;
  }

  async call(attemptId: string, method: CanvasesProbeMethod, input: JsonObject, spec: CanvasesProbeSpec): Promise<CanvasesProbeReceipt> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) || this.#attempts.has(attemptId)) {
      throw new Error('Use a new, reconciled probe attempt ID.');
    }
    if (!CANVASES_PROBE_METHODS.includes(method)) throw new Error('Probe method is not allowed.');
    if (!/^T[A-Z0-9]+$/.test(spec.workspaceId)) throw new Error('Exact QA workspace is required.');
    if (method !== 'auth.test' && this.#authenticatedWorkspace !== spec.workspaceId) throw new Error('Verify bot workspace with auth.test first.');
    if (method === 'auth.test') this.#authenticatedWorkspace = undefined;
    validateInput(method, input, spec);
    const serialized = JSON.stringify(input);
    if (serialized.length > 65_536 || serialized.includes(this.#token)) throw new Error('Invalid probe payload.');
    this.#attempts.add(attemptId);
    const base = { attemptId, method, at: new Date().toISOString() };
    await this.#record({ ...base, phase: 'dispatching', request: input });
    let receipt: CanvasesProbeReceipt;
    try {
      const json = JSON_METHODS.has(method);
      const bodyText = json ? serialized : new URLSearchParams(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      ).toString();
      const response = await this.#fetch(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
        body: bodyText,
      });
      const text = await response.text();
      if (text.length > 2_097_152 || text.includes(this.#token)) throw new Error('Invalid probe response.');
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as JsonObject).ok !== 'boolean') {
        throw new Error('Malformed Slack response.');
      }
      receipt = {
        ...base, phase: 'observed', status: response.status, response: body as JsonObject,
        scopes: (response.headers.get('x-oauth-scopes') ?? '').split(',').filter(Boolean),
        retryAfter: response.headers.get('retry-after'),
      };
      if (method === 'auth.test') {
        const auth = body as JsonObject;
        this.#authenticatedWorkspace = response.ok && auth.ok === true && auth.team_id === spec.workspaceId && typeof auth.bot_id === 'string'
          ? spec.workspaceId : undefined;
        if (!this.#authenticatedWorkspace) receipt.response = { ...auth, probe_identity_verified: false };
      }
    } catch {
      receipt = { ...base, phase: 'unknown' };
    }
    await this.#record(receipt);
    return receipt;
  }
}

function validateInput(method: CanvasesProbeMethod, input: JsonObject, spec: CanvasesProbeSpec): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/token|secret|authorization|team_id|enterprise_id/i.test(key)) throw new Error('Authority overrides are prohibited.');
      if (key === 'user_ids') throw new Error('Probe sharing is to declared channels only.');
      if (['channel', 'channel_id', 'channel_ids'].includes(key)) {
        const ids = Array.isArray(child) ? child : [child];
        if (ids.some(id => typeof id !== 'string' || !spec.channelIds.includes(id))) throw new Error('Channel is not a declared fixture.');
      }
      walk(child);
    }
  };
  walk(input);
  const canvas = method === 'files.info' ? input.file : input.canvas_id;
  const declared = [...spec.canvasIds, ...spec.cleanupCanvasIds];
  if (['files.info', 'canvases.getContent', 'canvases.sections.lookup', 'canvases.edit', 'canvases.access.set'].includes(method) &&
      (typeof canvas !== 'string' || !declared.includes(canvas))) {
    throw new Error('Canvas is not a declared fixture.');
  }
  if (method === 'canvases.delete' && (typeof input.canvas_id !== 'string' || !spec.cleanupCanvasIds.includes(input.canvas_id))) {
    throw new Error('Cleanup requires an exact run-owned canvas.');
  }
  if (method === 'canvases.access.set' && !['read', 'write'].includes(String(input.access_level))) {
    throw new Error('Probe sharing permits view/edit only.');
  }
  if (method === 'canvases.edit' && (!Array.isArray(input.changes) || input.changes.length !== 1 ||
      ['delete', 'rename'].includes(String((input.changes[0] as JsonObject | undefined)?.operation)))) {
    throw new Error('Probe edits make one content change.');
  }
}
