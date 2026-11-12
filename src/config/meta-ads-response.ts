import { META_ADS_ACCOUNT_HELPER, canonicalMetaAdsAccountId, metaAdsRuntimePropertyNames } from './meta-ads-policy.ts';
import { readToolsListAnswer, type ToolsRewrite } from './mcp-tools-list.ts';
import type { McpConnectionConfig } from './types.ts';

const MAX_META_ADS_HELPER_RESPONSE_BYTES = 512_000;
const MAX_META_ADS_ACCOUNT_RECORDS = 1_000;
const MAX_META_ADS_ACCOUNT_TEXT = 240;
const META_ADS_HELPER_RESPONSE_DEADLINE_MS = 30_000;

export const META_ADS_ACCOUNT_HELPER_DESCRIPTION =
  'Verify which owner-approved Meta ad accounts are enabled and queryable. ' +
  'Returns only approved account records in ad_accounts. Do not send ad-account IDs, cursors, or pagination arguments.';

/**
 * Hints appended to a reviewed argument's description. An activity-log call
 * without a limit returned 2.33 MB for one week on Amber, so the first call
 * asks for a page that fits in one tool result.
 */
const META_ADS_ARGUMENT_HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  ads_account_get_activity_logs: {
    limit: 'Start with 50. Without a limit, one week of history can be too large to read in full. ' +
      'For more, narrow start_time, end_time or event_category, or raise the limit.',
  },
};

export const META_ADS_ACCOUNT_HELPER_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ad_accounts: {
      type: 'array',
      // Access policy permits at most 50 approved account IDs, so the
      // reconstructed result cannot legitimately contain more rows.
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          ad_account_id: { type: 'string' },
          is_ads_mcp_enabled: { type: 'boolean' },
          is_queryable: { type: 'boolean' },
          not_queryable_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          currency: { type: 'string' },
          account_status: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          ad_account_name: { type: 'string' },
        },
        required: ['ad_account_id', 'is_ads_mcp_enabled', 'is_queryable'],
        additionalProperties: false,
      },
    },
  },
  required: ['ad_accounts'],
  additionalProperties: false,
} as const;

interface SafeMetaAdsAccount {
  ad_account_id: string;
  is_ads_mcp_enabled: boolean;
  is_queryable: boolean;
  not_queryable_reason?: string | null;
  currency?: string;
  account_status?: string | number;
  ad_account_name?: string;
}

/**
 * Replace the broad account-enumeration result with a new selected-account-only
 * MCP result. No provider content block, structured payload, or outer object is
 * forwarded. An envelope without exactly one account array, or with more
 * pages, fails before any provider text reaches the model; other top-level
 * keys are dropped and their names logged.
 */
export async function sanitizeMetaAdsAccountHelperResponse(
  response: Response,
  approvedAccountIds: readonly string[],
  options: { deadlineMs?: number; connectionId?: string } = {},
): Promise<Response> {
  if (!response.ok) throw unsupportedResponse(response, 'upstream-status');
  const approved = new Map<string, string>();
  for (const stored of approvedAccountIds) {
    const canonical = canonicalMetaAdsAccountId(stored);
    if (canonical && !approved.has(canonical)) approved.set(canonical, stored);
  }
  if (approved.size === 0) throw new Error('Meta Ads account verification has no approved account scope.');

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await readBoundedText(response, options.deadlineMs ?? META_ADS_HELPER_RESPONSE_DEADLINE_MS);
  if (contentType.includes('text/event-stream')) {
    const payload = parseSingleSsePayload(body, response);
    const sanitized = sanitizeJsonRpcPayload(payload, approved, response, options.connectionId);
    return rebuiltResponse(response, `event: message\ndata: ${JSON.stringify(sanitized)}\n\n`, 'text/event-stream');
  }
  if (!contentType.includes('application/json')) {
    throw unsupportedResponse(response, 'content-type');
  }
  const payload = parseJson(body, response);
  const sanitized = sanitizeJsonRpcPayload(payload, approved, response, options.connectionId);
  return rebuiltResponse(response, JSON.stringify(sanitized), 'application/json');
}

/**
 * Show the model each Meta tool's reviewed arguments only, the ones the
 * call-time key check permits. A tool whose live schema requires another
 * argument, or that has no reviewed schema, is withheld: no call to it can
 * pass both Meta and that check.
 */
export function reviewedMetaAdsTools(
  tools: unknown[],
  connection: Pick<McpConnectionConfig, 'discoveredTools'>,
): ReturnType<ToolsRewrite> {
  const withheld = new Map<string, string[]>();
  const shown = tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== 'string') return [tool];
    const reviewed = metaAdsRuntimePropertyNames(connection, tool.name);
    const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
    const required: unknown[] = Array.isArray(schema.required) ? schema.required : [];
    const unreviewed = required.filter((name) => typeof name !== 'string' || !reviewed?.includes(name));
    if (!reviewed || unreviewed.length > 0) {
      withheld.set(tool.name, reviewed ? loggedNames(unreviewed) : []);
      return [];
    }
    const hints = META_ADS_ARGUMENT_HINTS[tool.name];
    const properties = Object.entries(isRecord(schema.properties) ? schema.properties : {})
      .filter(([name]) => reviewed.includes(name))
      .map(([name, definition]) => [name, withHint(definition, hints?.[name])]);
    return [{ ...tool, inputSchema: { ...schema, properties: Object.fromEntries(properties) } }];
  });
  return { tools: shown, withheld };
}

/**
 * The account helper result is reconstructed by Chickpea, so the provider's
 * output schema no longer describes what the MCP client receives. Replace only
 * that advertised contract; input schemas and every other tool stay untouched.
 */
export function advertiseMetaAdsAccountHelper(tools: unknown[]): unknown[] {
  let matches = 0;
  const rewritten = tools.map((tool) => {
    if (!isRecord(tool) || tool.name !== META_ADS_ACCOUNT_HELPER) return tool;
    matches += 1;
    return {
      ...tool,
      description: META_ADS_ACCOUNT_HELPER_DESCRIPTION,
      outputSchema: META_ADS_ACCOUNT_HELPER_OUTPUT_SCHEMA,
    };
  });
  if (matches > 1) throw unsupportedToolListing('duplicate-account-helper');
  return rewritten;
}

/** {@link advertiseMetaAdsAccountHelper} over one tools/list answer. */
export async function advertiseMetaAdsAccountHelperOutput(
  request: Request,
  response: Response,
): Promise<Response> {
  const listing = await toolsListRequest(request);
  if (!listing || !response.ok) return response;
  return readToolsListAnswer(response, {
    id: listing.id,
    page: (result) => ({ ...result, tools: advertiseMetaAdsAccountHelper(result.tools) }),
    refuse: unsupportedToolListing,
  });
}

async function toolsListRequest(request: Request): Promise<Record<string, unknown> | undefined> {
  if (request.method !== 'POST') return undefined;
  try {
    const value = await request.clone().json() as unknown;
    return isRecord(value) && value.method === 'tools/list' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedText(response: Response, deadlineMs: number): Promise<string> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > META_ADS_HELPER_RESPONSE_DEADLINE_MS) {
    throw new RangeError('Meta Ads helper response deadline is invalid.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_META_ADS_HELPER_RESPONSE_BYTES) {
    throw unsupportedResponse(response, 'response-size');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let value = '';
  const read = async (): Promise<string> => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_META_ADS_HELPER_RESPONSE_BYTES) {
        await reader.cancel();
        throw unsupportedResponse(response, 'response-size');
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return value;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel();
      reject(unsupportedResponse(response, 'response-deadline'));
    }, deadlineMs);
  });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

function parseSingleSsePayload(body: string, response: Response): unknown {
  const events = body.replace(/\r\n/g, '\n').split('\n\n').filter((block) => block.trim());
  const data: string[] = [];
  for (const event of events) {
    const lines = event.split('\n');
    const payloadLines: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) continue;
      if (!line.startsWith('data:')) throw unsupportedResponse(response, 'sse-field');
      payloadLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (payloadLines.length > 0) data.push(payloadLines.join('\n'));
  }
  if (data.length !== 1) throw unsupportedResponse(response, 'sse-event-count');
  return parseJson(data[0]!, response);
}

function parseJson(value: string, response: Response): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw unsupportedResponse(response, 'invalid-json');
  }
}

function sanitizeJsonRpcPayload(
  value: unknown,
  approved: ReadonlyMap<string, string>,
  response: Response,
  connectionId: string | undefined,
): Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !('id' in value) ||
      !(['string', 'number'].includes(typeof value.id) || value.id === null)) {
    throw unsupportedResponse(response, 'json-rpc', value);
  }
  if ('error' in value) throw unsupportedResponse(response, 'provider-error', value);
  if (!isRecord(value.result)) throw unsupportedResponse(response, 'result', value);
  const result = value.result;
  if (result.isError === true) throw unsupportedResponse(response, 'tool-error', value);
  if (result.isError !== undefined && result.isError !== false) {
    throw unsupportedResponse(response, 'is-error', value);
  }

  const candidates: unknown[] = [];
  if (result.structuredContent !== undefined) candidates.push(result.structuredContent);
  if (result.content !== undefined) {
    if (!Array.isArray(result.content) || result.content.length === 0) {
      throw unsupportedResponse(response, 'content', value);
    }
    for (const block of result.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
        throw unsupportedResponse(response, 'content-block', value);
      }
      candidates.push(parseJson(block.text, response));
    }
  }
  if (candidates.length === 0) throw unsupportedResponse(response, 'account-payload', value);

  const extraKeys = new Set<string>();
  const projected = candidates.map((candidate) => projectApprovedAccounts(candidate, approved, response, extraKeys));
  if (extraKeys.size > 0) {
    console.info({
      event: 'chickpea.meta_ads.account_envelope_extra_keys', connectionId, keys: loggedNames([...extraKeys]),
    });
  }
  const canonical = JSON.stringify(projected[0]);
  if (projected.some((candidate) => JSON.stringify(candidate) !== canonical)) {
    throw unsupportedResponse(response, 'conflicting-payloads', value);
  }
  const safe = { ad_accounts: projected[0]! };
  return {
    jsonrpc: '2.0',
    id: value.id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(safe) }],
      structuredContent: safe,
      isError: false,
    },
  };
}

function projectApprovedAccounts(
  value: unknown,
  approved: ReadonlyMap<string, string>,
  response: Response,
  extraKeys: Set<string>,
): SafeMetaAdsAccount[] {
  const records = accountRecords(value, response, extraKeys);
  if (records.length > MAX_META_ADS_ACCOUNT_RECORDS) throw unsupportedResponse(response, 'record-count');
  const selected = new Map<string, SafeMetaAdsAccount>();
  for (const value of records) {
    if (!isRecord(value)) throw unsupportedResponse(response, 'account-record');
    const rawId = typeof value.ad_account_id === 'string'
      ? value.ad_account_id
      : typeof value.id === 'string' ? value.id : undefined;
    const accountId = rawId ? canonicalMetaAdsAccountId(rawId) : undefined;
    if (!accountId) throw unsupportedResponse(response, 'account-id');
    const approvedRepresentation = approved.get(accountId);
    if (!approvedRepresentation) continue;
    if (typeof value.is_ads_mcp_enabled !== 'boolean' || typeof value.is_queryable !== 'boolean') {
      throw unsupportedResponse(response, 'queryability');
    }
    const projected: SafeMetaAdsAccount = {
      ad_account_id: approvedRepresentation,
      is_ads_mcp_enabled: value.is_ads_mcp_enabled,
      is_queryable: value.is_queryable,
    };
    if ('not_queryable_reason' in value) {
      if (value.not_queryable_reason !== null && !boundedText(value.not_queryable_reason)) {
        throw unsupportedResponse(response, 'not-queryable-reason');
      }
      projected.not_queryable_reason = value.not_queryable_reason as string | null;
    }
    if ('currency' in value) {
      if (!boundedText(value.currency)) throw unsupportedResponse(response, 'currency');
      projected.currency = value.currency;
    }
    if ('account_status' in value) {
      if (!(boundedText(value.account_status) ||
          (typeof value.account_status === 'number' && Number.isSafeInteger(value.account_status)))) {
        throw unsupportedResponse(response, 'account-status');
      }
      projected.account_status = value.account_status;
    }
    if ('ad_account_name' in value) {
      if (!boundedText(value.ad_account_name)) throw unsupportedResponse(response, 'account-name');
      projected.ad_account_name = value.ad_account_name;
    }
    const previous = selected.get(accountId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(projected)) {
      throw unsupportedResponse(response, 'conflicting-account-aliases');
    }
    selected.set(accountId, projected);
  }
  return [...selected.values()].sort((left, right) => left.ad_account_id.localeCompare(right.ad_account_id));
}

/** The one account array, from a complete answer. Other top-level keys go to `extraKeys`: nothing forwards them. */
function accountRecords(value: unknown, response: Response, extraKeys: Set<string>): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw unsupportedResponse(response, 'account-envelope', value);
  const arrayKeys = ['accounts', 'ad_accounts', 'data'].filter((key) => Array.isArray(value[key]));
  if (arrayKeys.length !== 1) throw unsupportedResponse(response, 'account-envelope', value);
  if (hasMorePages(value)) throw unsupportedResponse(response, 'incomplete-pagination', value);
  const knownKeys = [arrayKeys[0]!, 'next_cursor', 'nextCursor', 'cursor', 'has_more', 'hasMore', 'paging'];
  for (const key of Object.keys(value)) {
    if (!knownKeys.includes(key)) extraKeys.add(key);
  }
  return value[arrayKeys[0]!] as unknown[];
}

function hasMorePages(value: Record<string, unknown>): boolean {
  if (value.has_more === true || value.hasMore === true) return true;
  for (const key of ['next_cursor', 'nextCursor', 'cursor']) {
    if (typeof value[key] === 'string' && value[key] !== '') return true;
  }
  if (isRecord(value.paging)) {
    if (Object.keys(value.paging).some((key) => !['next', 'cursors'].includes(key))) return true;
    if (typeof value.paging.next === 'string' && value.paging.next !== '') return true;
    if (isRecord(value.paging.cursors) && typeof value.paging.cursors.after === 'string' &&
        value.paging.cursors.after !== '') return true;
  } else if (value.paging !== undefined && value.paging !== null) {
    return true;
  }
  return false;
}

function rebuiltResponse(response: Response, body: string, contentType: string): Response {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', contentType);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function unsupportedResponse(response: Response, reason: string, value?: unknown): Error {
  const topLevel = Array.isArray(value) ? 'array' : isRecord(value) ? 'object' : typeof value;
  const declaredType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const responseKind = declaredType.includes('application/json')
    ? 'json'
    : declaredType.includes('text/event-stream') ? 'sse' : declaredType ? 'other' : 'none';
  return new Error(
    `Meta Ads account verification returned an unsupported response (${reason}; response-kind=${responseKind}; top-level=${topLevel}).`,
  );
}

/** Names the provider chose, as a log may carry them: the first 20, and none that is not a short identifier. */
function loggedNames(names: readonly unknown[]): string[] {
  return names.slice(0, 20).map((name) =>
    typeof name === 'string' && /^[\w.-]{1,120}$/.test(name) ? name : '(other)');
}

function unsupportedToolListing(reason: string): Error {
  return new Error(`Meta Ads tool discovery returned an unsupported response (${reason}).`);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_META_ADS_ACCOUNT_TEXT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function withHint(definition: unknown, hint: string | undefined): unknown {
  if (!hint || !isRecord(definition)) return definition;
  const own = typeof definition.description === 'string' ? definition.description.trim() : '';
  return { ...definition, description: own ? `${own} ${hint}` : hint };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
