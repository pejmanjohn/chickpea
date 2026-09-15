import { META_ADS_ACCOUNT_HELPER, canonicalMetaAdsAccountId } from './meta-ads-policy.ts';

const MAX_META_ADS_HELPER_RESPONSE_BYTES = 512_000;
const MAX_META_ADS_TOOL_LIST_BYTES = 8_000_000;
const MAX_META_ADS_ACCOUNT_RECORDS = 1_000;
const MAX_META_ADS_ACCOUNT_TEXT = 240;
const META_ADS_HELPER_RESPONSE_DEADLINE_MS = 30_000;

export const META_ADS_ACCOUNT_HELPER_DESCRIPTION =
  'Verify which owner-approved Meta ad accounts are enabled and queryable. ' +
  'Returns only approved account records in ad_accounts. Do not send ad-account IDs, cursors, or pagination arguments.';

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
 * forwarded. Unknown envelopes fail before any provider text reaches the model.
 */
export async function sanitizeMetaAdsAccountHelperResponse(
  response: Response,
  approvedAccountIds: readonly string[],
  options: { deadlineMs?: number } = {},
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
    const sanitized = sanitizeJsonRpcPayload(payload, approved, response);
    return rebuiltResponse(response, `event: message\ndata: ${JSON.stringify(sanitized)}\n\n`, 'text/event-stream');
  }
  if (!contentType.includes('application/json')) {
    throw unsupportedResponse(response, 'content-type');
  }
  const payload = parseJson(body, response);
  const sanitized = sanitizeJsonRpcPayload(payload, approved, response);
  return rebuiltResponse(response, JSON.stringify(sanitized), 'application/json');
}

/**
 * The account helper result is reconstructed by Chickpea, so the provider's
 * output schema no longer describes what the MCP client receives. Replace only
 * that advertised contract; input schemas and every other tool stay untouched.
 */
export async function advertiseMetaAdsAccountHelperOutput(
  request: Request,
  response: Response,
): Promise<Response> {
  if (!(await isToolsListRequest(request)) || !response.ok) return response;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const body = await readBoundedText(
    response,
    META_ADS_HELPER_RESPONSE_DEADLINE_MS,
    MAX_META_ADS_TOOL_LIST_BYTES,
    (reason) => unsupportedToolListing(reason),
  );
  if (contentType.includes('text/event-stream')) {
    return rebuiltResponse(response, rewriteToolsListSse(body), 'text/event-stream');
  }
  if (!contentType.includes('application/json')) throw unsupportedToolListing('content-type');
  const payload = parseJson(body, response);
  return rebuiltResponse(response, JSON.stringify(rewriteToolsListPayload(payload)), 'application/json');
}

async function readBoundedText(
  response: Response,
  deadlineMs: number,
  maxBytes = MAX_META_ADS_HELPER_RESPONSE_BYTES,
  failure: (reason: string) => Error = (reason) => unsupportedResponse(response, reason),
): Promise<string> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > META_ADS_HELPER_RESPONSE_DEADLINE_MS) {
    throw new RangeError('Meta Ads helper response deadline is invalid.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw failure('response-size');
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
      if (bytes > maxBytes) {
        await reader.cancel();
        throw failure('response-size');
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
      reject(failure('response-deadline'));
    }, deadlineMs);
  });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.releaseLock();
  }
}

async function isToolsListRequest(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  try {
    const value = await request.clone().json() as unknown;
    return isRecord(value) && value.method === 'tools/list';
  } catch {
    return false;
  }
}

function rewriteToolsListPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || !('id' in value) || 'error' in value ||
      !(['string', 'number'].includes(typeof value.id) || value.id === null) ||
      !isRecord(value.result) || !Array.isArray(value.result.tools)) {
    throw unsupportedToolListing('json-rpc');
  }
  let matches = 0;
  const tools = value.result.tools.map((tool) => {
    if (!isRecord(tool) || tool.name !== META_ADS_ACCOUNT_HELPER) return tool;
    matches += 1;
    return {
      ...tool,
      description: META_ADS_ACCOUNT_HELPER_DESCRIPTION,
      outputSchema: META_ADS_ACCOUNT_HELPER_OUTPUT_SCHEMA,
    };
  });
  if (matches > 1) throw unsupportedToolListing('duplicate-account-helper');
  return { ...value, result: { ...value.result, tools } };
}

function rewriteToolsListSse(body: string): string {
  const events = body.replace(/\r\n/g, '\n').split('\n\n').filter((block) => block.trim());
  let responses = 0;
  const rewritten = events.map((event) => {
    const lines = event.split('\n');
    const dataIndexes: number[] = [];
    const data: string[] = [];
    for (const [index, line] of lines.entries()) {
      if (line.startsWith('data:')) {
        dataIndexes.push(index);
        data.push(line.slice(5).replace(/^ /, ''));
      } else if (line && !line.startsWith(':') && !line.startsWith('event:') &&
          !line.startsWith('id:') && !line.startsWith('retry:')) {
        throw unsupportedToolListing('sse-field');
      }
    }
    if (data.length === 0) return event;
    let value: unknown;
    try {
      value = JSON.parse(data.join('\n')) as unknown;
    } catch {
      throw unsupportedToolListing('invalid-json');
    }
    if (isRecord(value) && isRecord(value.result) && Array.isArray(value.result.tools)) {
      value = rewriteToolsListPayload(value);
      responses += 1;
    }
    const first = dataIndexes[0]!;
    return lines.flatMap((line, index) => {
      if (index === first) return [`data: ${JSON.stringify(value)}`];
      return dataIndexes.includes(index) ? [] : [line];
    }).join('\n');
  });
  if (responses !== 1) throw unsupportedToolListing('sse-response-count');
  return `${rewritten.join('\n\n')}\n\n`;
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

  const projected = candidates.map((candidate) => projectApprovedAccounts(candidate, approved, response));
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
): SafeMetaAdsAccount[] {
  const records = accountRecords(value, response);
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

function accountRecords(value: unknown, response: Response): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) throw unsupportedResponse(response, 'account-envelope', value);
  const arrayKeys = ['accounts', 'ad_accounts', 'data'].filter((key) => Array.isArray(value[key]));
  if (arrayKeys.length !== 1) throw unsupportedResponse(response, 'account-envelope', value);
  const allowedKeys = new Set([
    arrayKeys[0]!, 'next_cursor', 'nextCursor', 'cursor', 'has_more', 'hasMore', 'paging',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw unsupportedResponse(response, 'account-envelope-keys', value);
  }
  if (hasMorePages(value)) throw unsupportedResponse(response, 'incomplete-pagination', value);
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

function unsupportedToolListing(reason: string): Error {
  return new Error(`Meta Ads tool discovery returned an unsupported response (${reason}).`);
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_META_ADS_ACCOUNT_TEXT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
