/** Raw, attended Slack Lists experiments. Never mounted as an Agent tool. */
export const LISTS_PROBE_METHODS = [
  'auth.test', 'users.info', 'conversations.info', 'conversations.members',
  'slackLists.create', 'slackLists.items.list', 'slackLists.items.info',
  'slackLists.items.create', 'slackLists.items.update', 'slackLists.access.set',
  'slackLists.items.delete',
] as const;

export type ListsProbeMethod = typeof LISTS_PROBE_METHODS[number];
type JsonObject = Record<string, unknown>;

export interface ListsProbeSpec {
  workspaceId: string;
  /** Exact fixture IDs, including human-owned negative controls. */
  listIds: readonly string[];
  channelIds: readonly string[];
  userIds: readonly string[];
  /** Deletion is restricted to exact run-owned rows, never whole lists. */
  cleanupItemIds: readonly string[];
}

export interface ListsProbeReceipt {
  attemptId: string;
  method: ListsProbeMethod;
  at: string;
  phase: 'dispatching' | 'observed' | 'unknown';
  request?: JsonObject;
  status?: number;
  scopes?: string[];
  retryAfter?: string | null;
  response?: JsonObject;
}

/**
 * Credentials stay in the invoking QA process. Persist receipts in a private
 * attended run directory. A receipt must be saved before dispatch; after a
 * restart, the operator reconciles it before attempting another write.
 */
export class SlackListsProbe {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #record: (receipt: ListsProbeReceipt) => Promise<void>;
  readonly #attempts = new Set<string>();
  #authenticatedWorkspace: string | undefined;

  constructor(options: {
    token: string;
    record: (receipt: ListsProbeReceipt) => Promise<void>;
    fetch?: typeof fetch;
  }) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(options.token)) throw new Error('A QA bot token is required.');
    this.#token = options.token;
    this.#record = options.record;
    this.#fetch = options.fetch ?? fetch;
  }

  async call(attemptId: string, method: ListsProbeMethod, input: JsonObject, spec: ListsProbeSpec): Promise<ListsProbeReceipt> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) || this.#attempts.has(attemptId)) {
      throw new Error('Use a new, reconciled probe attempt ID.');
    }
    if (!LISTS_PROBE_METHODS.includes(method)) throw new Error('Probe method is not allowed.');
    if (!/^T[A-Z0-9]+$/.test(spec.workspaceId)) throw new Error('Exact QA workspace is required.');
    if (method !== 'auth.test' && this.#authenticatedWorkspace !== spec.workspaceId) throw new Error('Verify bot workspace with auth.test first.');
    if (method === 'auth.test') this.#authenticatedWorkspace = undefined;
    validateInput(method, input, spec);
    const serialized = JSON.stringify(input);
    if (serialized.length > 32_768 || serialized.includes(this.#token)) throw new Error('Invalid probe payload.');
    this.#attempts.add(attemptId);
    const base = { attemptId, method, at: new Date().toISOString() };
    await this.#record({ ...base, phase: 'dispatching', request: input });
    let receipt: ListsProbeReceipt;
    try {
      // Classic read helpers accept form parameters; Lists methods accept JSON.
      const json = method.startsWith('slackLists.');
      const bodyText = json ? serialized : new URLSearchParams(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      ).toString();
      const response = await this.#fetch(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': json ? 'application/json; charset=utf-8' : 'application/x-www-form-urlencoded' },
        body: bodyText,
      });
      const text = await response.text();
      if (text.length > 1_048_576 || text.includes(this.#token)) throw new Error('Invalid probe response.');
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
      // Never serialize fetch errors: they can include request credentials.
      receipt = { ...base, phase: 'unknown' };
    }
    await this.#record(receipt);
    return receipt;
  }
}

function validateInput(method: ListsProbeMethod, input: JsonObject, spec: ListsProbeSpec): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/token|secret|authorization|team_id|enterprise_id/i.test(key)) throw new Error('Authority overrides are prohibited.');
      if (['user', 'user_ids'].includes(key)) {
        const ids = Array.isArray(child) ? child : [child];
        if (ids.some(id => typeof id !== 'string' || !spec.userIds.includes(id))) throw new Error('User is not a declared QA actor.');
      }
      if (['channel', 'channel_ids'].includes(key)) {
        const ids = Array.isArray(child) ? child : [child];
        if (ids.some(id => typeof id !== 'string' || !spec.channelIds.includes(id))) throw new Error('Channel is not a declared fixture.');
      }
      walk(child);
    }
  };
  walk(input);
  if (method.startsWith('slackLists.') && method !== 'slackLists.create') {
    if (typeof input.list_id !== 'string' || !spec.listIds.includes(input.list_id)) throw new Error('List is not a declared fixture.');
  }
  if (method === 'slackLists.create' && ('copy_from_list_id' in input || 'include_copied_list_records' in input)) {
    throw new Error('Probe creation cannot copy other lists.');
  }
  if (method === 'slackLists.access.set' && !['read', 'write'].includes(String(input.access_level))) {
    throw new Error('Probe sharing permits view/edit only.');
  }
  if (method === 'slackLists.items.delete' && (typeof input.id !== 'string' || !spec.cleanupItemIds.includes(input.id))) {
    throw new Error('Cleanup requires an exact run-owned item.');
  }
  if (method === 'slackLists.items.list' && (typeof input.limit !== 'number' || input.limit < 1 || input.limit > 50)) {
    throw new Error('Probe reads require a page limit of 1–50.');
  }
}
