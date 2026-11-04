/**
 * Raw, attended check that a workspace bot's `conversations.invite` accepts
 * another app's bot user. Never mounted as an Agent tool.
 */
export const AGENT_BOT_INVITE_PROBE_METHODS = [
  'auth.test', 'conversations.info', 'conversations.members', 'conversations.invite', 'conversations.kick',
] as const;

export type AgentBotInviteProbeMethod = typeof AGENT_BOT_INVITE_PROBE_METHODS[number];
type JsonObject = Record<string, unknown>;

export interface AgentBotInviteProbeSpec {
  workspaceId: string;
  /** Exact fixture Channels the workspace bot is in: one public, one private. */
  channelIds: readonly string[];
  /** The Agent apps' bot users the probe may invite and remove again. */
  botUserIds: readonly string[];
}

export interface AgentBotInviteProbeReceipt {
  attemptId: string;
  method: AgentBotInviteProbeMethod;
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
 * restart, the operator reconciles it before another invite or removal.
 */
export class SlackAgentBotInviteProbe {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #record: (receipt: AgentBotInviteProbeReceipt) => Promise<void>;
  readonly #attempts = new Set<string>();
  #authenticatedWorkspace: string | undefined;

  constructor(options: {
    token: string;
    record: (receipt: AgentBotInviteProbeReceipt) => Promise<void>;
    fetch?: typeof fetch;
  }) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(options.token)) throw new Error('A workspace bot token is required.');
    this.#token = options.token;
    this.#record = options.record;
    this.#fetch = options.fetch ?? fetch;
  }

  async call(attemptId: string, method: AgentBotInviteProbeMethod, input: JsonObject, spec: AgentBotInviteProbeSpec): Promise<AgentBotInviteProbeReceipt> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId) || this.#attempts.has(attemptId)) {
      throw new Error('Use a new, reconciled probe attempt ID.');
    }
    if (!AGENT_BOT_INVITE_PROBE_METHODS.includes(method)) throw new Error('Probe method is not allowed.');
    if (!/^T[A-Z0-9]+$/.test(spec.workspaceId)) throw new Error('Exact QA workspace is required.');
    if (method !== 'auth.test' && this.#authenticatedWorkspace !== spec.workspaceId) throw new Error('Verify bot workspace with auth.test first.');
    if (method === 'auth.test') this.#authenticatedWorkspace = undefined;
    validateInput(method, input, spec);
    const serialized = JSON.stringify(input);
    if (serialized.length > 4_096 || serialized.includes(this.#token)) throw new Error('Invalid probe payload.');
    this.#attempts.add(attemptId);
    const base = { attemptId, method, at: new Date().toISOString() };
    await this.#record({ ...base, phase: 'dispatching', request: input });
    let receipt: AgentBotInviteProbeReceipt;
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
      // Never serialize fetch errors: they can include request credentials.
      receipt = { ...base, phase: 'unknown' };
    }
    await this.#record(receipt);
    return receipt;
  }
}

/**
 * The whole check for one fixture Channel: the workspace bot is in it, the
 * app's bot is not, the invite, the app's bot now a member, and a second
 * invite (`already_in_channel` expected). Only a bot this run's invite added
 * is removed again, so the run can repeat. It stops at an unknown outcome.
 * Read the answers from the receipts; nothing here judges them.
 */
export async function inviteSequence(
  probe: SlackAgentBotInviteProbe,
  spec: AgentBotInviteProbeSpec,
  run: { id: string; channelId: string; botUserId: string },
): Promise<AgentBotInviteProbeReceipt[]> {
  const channel = run.channelId;
  const steps: Array<[string, AgentBotInviteProbeMethod, JsonObject]> = [
    ['auth', 'auth.test', {}],
    ['info', 'conversations.info', { channel }],
    ['members-before', 'conversations.members', { channel, limit: 200 }],
    ['invite', 'conversations.invite', { channel, users: run.botUserId }],
    ['members-after', 'conversations.members', { channel, limit: 200 }],
    ['invite-again', 'conversations.invite', { channel, users: run.botUserId }],
  ];
  const receipts: AgentBotInviteProbeReceipt[] = [];
  for (const [step, method, input] of steps) {
    const receipt = await probe.call(`${run.id}-${step}`, method, input, spec);
    receipts.push(receipt);
    if (receipt.phase !== 'observed') return receipts;
  }
  if (receipts.find((receipt) => receipt.attemptId === `${run.id}-invite`)?.response?.ok === true) {
    receipts.push(await probe.call(`${run.id}-remove`, 'conversations.kick', { channel, user: run.botUserId }, spec));
  }
  return receipts;
}

function validateInput(method: AgentBotInviteProbeMethod, input: JsonObject, spec: AgentBotInviteProbeSpec): void {
  for (const [key, value] of Object.entries(input)) {
    if (/token|secret|authorization|team_id|enterprise_id/i.test(key)) throw new Error('Authority overrides are prohibited.');
    if (value !== null && typeof value === 'object') throw new Error('Probe arguments are plain values.');
  }
  if (method === 'auth.test') return;
  if (typeof input.channel !== 'string' || !spec.channelIds.includes(input.channel)) throw new Error('Channel is not a declared fixture.');
  const allowed: Record<Exclude<AgentBotInviteProbeMethod, 'auth.test'>, readonly string[]> = {
    'conversations.info': ['channel'],
    'conversations.members': ['channel', 'limit'],
    'conversations.invite': ['channel', 'users'],
    'conversations.kick': ['channel', 'user'],
  };
  if (Object.keys(input).some((key) => !allowed[method].includes(key))) throw new Error('Unexpected probe argument.');
  if (method === 'conversations.invite' || method === 'conversations.kick') {
    const botUser = method === 'conversations.invite' ? input.users : input.user;
    if (typeof botUser !== 'string' || !spec.botUserIds.includes(botUser)) throw new Error('Only a declared Agent app bot may be invited or removed.');
  }
  if (method === 'conversations.members' && (typeof input.limit !== 'number' || input.limit < 1 || input.limit > 200)) {
    throw new Error('Probe reads require a page limit of 1-200.');
  }
}
