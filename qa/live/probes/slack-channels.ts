export const CHANNELS_PROBE_METHODS = [
  'auth.test', 'users.info', 'conversations.info', 'conversations.members',
  'conversations.create', 'conversations.invite', 'conversations.setPurpose', 'chat.postMessage',
  'conversations.archive',
] as const;

export type ChannelsProbeMethod = typeof CHANNELS_PROBE_METHODS[number];
type JsonObject = Record<string, unknown>;

export interface ChannelsProbeSpec {
  workspaceId: string;
  runNamePrefix: string;
  readableChannelIds: readonly string[];
  runChannelIds: readonly string[];
  userIds: readonly string[];
}

export interface ChannelsProbeReceipt {
  attemptId: string;
  method: ChannelsProbeMethod;
  at: string;
  phase: 'dispatching' | 'observed' | 'unknown';
  request?: JsonObject;
  status?: number;
  scopes?: string[];
  retryAfter?: string | null;
  response?: JsonObject;
}

const RUN_CHANNEL_METHODS: ReadonlySet<ChannelsProbeMethod> = new Set([
  'conversations.invite', 'conversations.setPurpose', 'chat.postMessage', 'conversations.archive',
]);

export class SlackChannelsProbe {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #record: (receipt: ChannelsProbeReceipt) => Promise<void>;
  readonly #attempts = new Set<string>();
  #authenticatedWorkspace: string | undefined;

  constructor(options: {
    token: string;
    record: (receipt: ChannelsProbeReceipt) => Promise<void>;
    fetch?: typeof fetch;
  }) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(options.token)) throw new Error('A QA bot token is required.');
    this.#token = options.token;
    this.#record = options.record;
    this.#fetch = options.fetch ?? fetch;
  }

  async call(attemptId: string, method: ChannelsProbeMethod, input: JsonObject, spec: ChannelsProbeSpec): Promise<ChannelsProbeReceipt> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) || this.#attempts.has(attemptId)) {
      throw new Error('Use a new, reconciled probe attempt ID.');
    }
    if (!CHANNELS_PROBE_METHODS.includes(method)) throw new Error('Probe method is not allowed.');
    if (!/^T[A-Z0-9]+$/.test(spec.workspaceId)) throw new Error('Exact QA workspace is required.');
    if (method !== 'auth.test' && this.#authenticatedWorkspace !== spec.workspaceId) throw new Error('Verify bot workspace with auth.test first.');
    if (method === 'auth.test') this.#authenticatedWorkspace = undefined;
    validateInput(method, input, spec);
    const serialized = JSON.stringify(input);
    if (serialized.length > 32_768 || serialized.includes(this.#token)) throw new Error('Invalid probe payload.');
    this.#attempts.add(attemptId);
    const base = { attemptId, method, at: new Date().toISOString() };
    await this.#record({ ...base, phase: 'dispatching', request: input });
    let receipt: ChannelsProbeReceipt;
    try {
      const response = await this.#fetch(`https://slack.com/api/${method}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)])).toString(),
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
      receipt = { ...base, phase: 'unknown' };
    }
    await this.#record(receipt);
    return receipt;
  }
}

function validateInput(method: ChannelsProbeMethod, input: JsonObject, spec: ChannelsProbeSpec): void {
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|authorization|team_id|enterprise_id/i.test(key)) throw new Error('Authority overrides are prohibited.');
    if (value !== null && typeof value === 'object') throw new Error('Probe inputs are flat form fields.');
  }
  if (input.force !== undefined) throw new Error('Probe invites leave force unset, as the tool does.');
  const users = [input.user, ...String(input.users ?? '').split(',')].filter((id) => id !== undefined && id !== '');
  if (users.some((id) => typeof id !== 'string' || !spec.userIds.includes(id))) throw new Error('User is not a declared QA actor.');
  if (input.channel !== undefined) {
    const channel = String(input.channel);
    const allowed = RUN_CHANNEL_METHODS.has(method) ? spec.runChannelIds : [...spec.readableChannelIds, ...spec.runChannelIds];
    if (!allowed.includes(channel)) throw new Error(RUN_CHANNEL_METHODS.has(method) ? 'Only a channel this run created.' : 'Channel is not a declared fixture.');
  } else if (RUN_CHANNEL_METHODS.has(method) || method === 'conversations.members') {
    throw new Error('An exact channel is required.');
  }
  if (method === 'conversations.create' &&
      (typeof input.name !== 'string' || !spec.runNamePrefix || !input.name.startsWith(spec.runNamePrefix))) {
    throw new Error('A run channel is named with the run prefix.');
  }
}
