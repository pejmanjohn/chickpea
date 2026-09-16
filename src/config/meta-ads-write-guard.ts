import {
  canonicalMetaAdsAccountId,
  isMetaAdsWriteTool,
  metaAdsWriteOwnershipTargets,
} from './meta-ads-policy.ts';

// Match Meta's supported Business SDK version. Ownership is a read-only Graph
// check; the requested mutation still goes through the official Ads MCP server.
export const META_ADS_OWNERSHIP_ORIGIN = 'https://graph.facebook.com';
const GRAPH_VERSION = 'v26.0';
const MAX_OWNERSHIP_BYTES = 16_384;
const OWNERSHIP_TIMEOUT_MS = 8_000;
const NON_ACTIVE_CONFIGURED_STATUSES = new Set(['PAUSED', 'DELETED', 'ARCHIVED']);

type MetaAdsEntityType = 'campaign' | 'ad_set' | 'ad';

class MetaAdsBudgetSafetyError extends Error {}

interface MetaAdsWriteAccountOwnershipInput {
  name: string;
  argumentsValue: unknown;
  approvedAccountIds: readonly string[];
  authorization: string | null;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

/**
 * An account argument alone does not prove an entity's owner. Before any
 * entity mutation, verify its actual owner with the same token used for MCP.
 * Readbacks are consumed here and never become model-visible tool results.
 */
export async function assertMetaAdsWriteAccountOwnership(
  input: MetaAdsWriteAccountOwnershipInput,
): Promise<void> {
  if (!isMetaAdsWriteTool(input.name)) return;
  const targets = metaAdsWriteOwnershipTargets(input.name, input.argumentsValue);
  const budgetEntityType = metaAdsBudgetUpdateEntityType(input.name, input.argumentsValue);
  const approved = new Set(input.approvedAccountIds.map(canonicalMetaAdsAccountId));
  if (approved.size === 0 || approved.has(undefined)) throw ownershipError();
  const args = input.argumentsValue as Record<string, unknown>;
  const accountValues = ['ad_account_id', 'account_id'].filter((key) => Object.hasOwn(args, key));
  if (accountValues.length > 1) throw ownershipError();
  const rawAccount = accountValues.length === 1 ? args[accountValues[0]!] : undefined;
  const requestedAccount = typeof rawAccount === 'string' ? canonicalMetaAdsAccountId(rawAccount) : undefined;
  if (accountValues.length === 1 && (!requestedAccount || !approved.has(requestedAccount))) {
    throw ownershipError();
  }
  // Pure account-scoped creations have no existing mutable entity to inspect.
  if (targets.length === 0) {
    if (!requestedAccount) throw ownershipError();
    return;
  }
  if (!input.authorization || !/^Bearer [^\s\x00-\x1f\x7f]+$/i.test(input.authorization) ||
      input.authorization.length > 16_384) throw ownershipError();
  const signal = AbortSignal.any([
    AbortSignal.timeout(OWNERSHIP_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  try {
    for (const id of targets) {
      if (!/^[0-9]{1,32}$/.test(id)) throw ownershipError();
      const url = new URL(`${META_ADS_OWNERSHIP_ORIGIN}/${GRAPH_VERSION}/${id}`);
      url.searchParams.set('fields', budgetEntityType
        ? 'id,account_id,configured_status'
        : 'id,account_id');
      const response = await input.fetch(new Request(url, {
        method: 'GET',
        headers: { Authorization: input.authorization, Accept: 'application/json' },
        // workerd accepts manual/follow only; the guarded fetch and checks below reject redirects.
        redirect: 'manual',
        signal,
      }));
      if (!response.ok || response.redirected ||
          (response.url && response.url !== url.href)) {
        await response.body?.cancel().catch(() => undefined);
        throw ownershipError();
      }
      const value = await readOwnershipResponse(response);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw ownershipError();
      const record = value as Record<string, unknown>;
      const owner = typeof record.account_id === 'string'
        ? canonicalMetaAdsAccountId(record.account_id) : undefined;
      if (record.id !== id || !owner || !approved.has(owner) ||
          (requestedAccount !== undefined && owner !== requestedAccount)) throw ownershipError();
      if (budgetEntityType) assertBudgetUpdateIsSafe(record.configured_status, budgetEntityType);
    }
  } catch (error) {
    if (error instanceof MetaAdsBudgetSafetyError) throw error;
    // Provider errors may contain tokens or unrelated account details.
    throw ownershipError();
  }
}

function metaAdsBudgetUpdateEntityType(
  name: string,
  argumentsValue: unknown,
): MetaAdsEntityType | undefined {
  if (name !== 'ads_update_entity' || !argumentsValue ||
      typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return undefined;
  const args = argumentsValue as Record<string, unknown>;
  let fields = args.fields;
  if (typeof fields === 'string') {
    try {
      fields = JSON.parse(fields) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
      (!Object.hasOwn(fields, 'daily_budget') && !Object.hasOwn(fields, 'lifetime_budget'))) {
    return undefined;
  }
  return args.entity_type === 'campaign' || args.entity_type === 'ad_set' || args.entity_type === 'ad'
    ? args.entity_type
    : undefined;
}

function assertBudgetUpdateIsSafe(status: unknown, entityType: MetaAdsEntityType): void {
  const entity = entityType === 'ad_set' ? 'ad set' : entityType;
  if (status === 'ACTIVE') {
    throw new MetaAdsBudgetSafetyError(
      `Meta's update service may pause an active ${entity} during budget changes. ` +
      `Use Ads Manager to change this ${entity}'s budget. No ad changes were sent.`,
    );
  }
  if (typeof status !== 'string' || !NON_ACTIVE_CONFIGURED_STATUSES.has(status)) {
    throw new MetaAdsBudgetSafetyError(
      `Meta Ads could not verify whether this ${entity} is active. ` +
      `Use Ads Manager to change this ${entity}'s budget. No ad changes were sent.`,
    );
  }
}

async function readOwnershipResponse(response: Response): Promise<unknown> {
  if (!response.body) throw ownershipError();
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > MAX_OWNERSHIP_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw ownershipError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OWNERSHIP_BYTES) throw ownershipError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function ownershipError(): Error {
  return new Error('Meta Ads could not verify that the target belongs to the selected ad account. No ad changes were sent.');
}
