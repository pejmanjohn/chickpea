import type {
  McpConnectionConfig,
  McpConnectionToolInfo,
  McpToolPolicy,
} from './types.ts';

export const META_ADS_MCP_URL = 'https://mcp.facebook.com/ads';

/** Reporting tools reviewed against Meta's official Ads MCP documentation. */
export const META_ADS_REVIEWED_TOOL_EFFECTS = {
  ads_get_ad_entities: 'read',
  ads_get_opportunity_score: 'read',
  ads_insights_advertiser_context: 'read',
  ads_insights_anomaly_signal: 'read',
  ads_insights_auction_ranking_benchmarks: 'read',
  ads_insights_industry_benchmark: 'read',
  ads_insights_performance_trend: 'read',
} as const satisfies Readonly<Record<string, 'read'>>;

export class MetaAdsAccessPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaAdsAccessPolicyError';
  }
}

export interface CompileMetaAdsToolAccessInput {
  discoveredTools: readonly McpConnectionToolInfo[];
  requestedTools: readonly string[];
  approvedAccountIds: readonly string[];
}

export interface CompiledMetaAdsToolAccess {
  allowedTools: string[];
  toolPolicies: Record<string, McpToolPolicy>;
}

interface MetaAdsConnectionLocator {
  presetId?: string | undefined;
  url?: string | undefined;
}

/**
 * Compile explicit installer choices into the existing exact-argument policy.
 * Tool names and server annotations never establish either account scope or a
 * read-only effect. Authenticated schema evidence is required for every grant.
 */
export function compileMetaAdsToolAccess(
  input: CompileMetaAdsToolAccessInput,
): CompiledMetaAdsToolAccess {
  const requestedTools = uniqueStrings(input.requestedTools, 'Meta Ads tool');
  if (requestedTools.length === 0) return { allowedTools: [], toolPolicies: {} };
  const accountIds = normalizeMetaAdsAccountIds(input.approvedAccountIds);
  if (accountIds.length === 0) {
    throw new MetaAdsAccessPolicyError('Select at least one Meta ad account before granting tools.');
  }
  const policyEntries: Array<[string, McpToolPolicy]> = [];
  for (const name of requestedTools) {
    if (!isReviewedMetaAdsTool(name)) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} is not in the reviewed reporting contract.`);
    }
    const matches = input.discoveredTools.filter((tool) => tool.name === name);
    if (matches.length !== 1) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} is not uniquely present in current discovery.`);
    }
    const field = metaAdsAccountField(matches[0]!);
    if (!field) {
      throw new MetaAdsAccessPolicyError(`Meta Ads tool ${name} cannot be restricted to an approved ad account.`);
    }
    policyEntries.push([name, {
      effect: META_ADS_REVIEWED_TOOL_EFFECTS[name],
      argumentConstraints: { [field]: accountIds },
    }]);
  }
  return { allowedTools: requestedTools, toolPolicies: Object.fromEntries(policyEntries) };
}

export function isMetaAdsMcpConnection(
  connection: MetaAdsConnectionLocator,
): boolean {
  if (connection.presetId === 'meta-ads') return true;
  if (!connection.url) return false;
  try {
    const url = new URL(connection.url);
    const path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
    return url.protocol === 'https:' && url.hostname === 'mcp.facebook.com' && url.port === '' &&
      url.username === '' && url.password === '' && path === '/ads';
  } catch {
    return false;
  }
}

/** Return only tools whose current schema and persisted exact constraint agree. */
export function metaAdsRuntimeAllowedTools(
  connection: Pick<McpConnectionConfig, 'discoveredTools' | 'toolPolicies' | 'allowedTools'>,
): string[] {
  return connection.allowedTools.filter((name) => metaAdsRuntimeConstraint(connection, name) !== undefined);
}

/**
 * Revalidate persisted policy against current authenticated discovery. A
 * schema-less, duplicate, ambiguous, optional, or differently constrained tool
 * has no executable Meta policy.
 */
export function metaAdsRuntimeConstraint(
  connection: Pick<McpConnectionConfig, 'discoveredTools' | 'toolPolicies'>,
  name: string,
): Record<string, string[]> | undefined {
  if (!isReviewedMetaAdsTool(name)) return undefined;
  const matches = connection.discoveredTools.filter((tool) => tool.name === name);
  if (matches.length !== 1) return undefined;
  const field = metaAdsAccountField(matches[0]!);
  if (!field) return undefined;
  const constraints = connection.toolPolicies?.[name]?.argumentConstraints;
  return metaAdsConstraintField(constraints) === field ? normalizedConstraint(constraints, field) : undefined;
}

/** Validate the frozen/runtime form even when authenticated discovery is not embedded in it. */
export function metaAdsConstraintField(
  constraints: Record<string, string[]> | undefined,
): 'ad_account_id' | 'account_id' | undefined {
  if (!constraints) return undefined;
  const keys = Object.keys(constraints);
  if (keys.length !== 1) return undefined;
  const field = keys[0];
  if (field !== 'ad_account_id' && field !== 'account_id') return undefined;
  return normalizedConstraint(constraints, field) ? field : undefined;
}

/** A supported tool has exactly one required top-level scalar account field. */
export function metaAdsAccountField(tool: McpConnectionToolInfo): 'ad_account_id' | 'account_id' | undefined {
  if (!metaAdsToolEffect(tool.name)) return undefined;
  const schema = tool.inputSchema;
  if (!schema || schema.ambiguous || !/^[a-f0-9]{64}$/.test(schema.fingerprint) ||
      schema.accountFields.length !== 1) return undefined;
  const [field] = schema.accountFields;
  if (!field || field.type !== 'string' || !field.required) return undefined;
  const names = schema.propertyNames;
  if (!Array.isArray(names) || names.length === 0 || names.length > 64 ||
      new Set(names).size !== names.length || !names.includes(field.name) ||
      names.some((value) => typeof value !== 'string' || value.length === 0 || value.length > 120)) {
    return undefined;
  }
  return field.name;
}

/** Trusted server-owned effect metadata for the reviewed Meta tool contract. */
export function metaAdsToolEffect(name: string): 'read' | 'write' | undefined {
  return isReviewedMetaAdsTool(name) ? META_ADS_REVIEWED_TOOL_EFFECTS[name] : undefined;
}

export function metaAdsRuntimePropertyNames(
  connection: Pick<McpConnectionConfig, 'discoveredTools'>,
  name: string,
): string[] | undefined {
  const matches = connection.discoveredTools.filter((tool) => tool.name === name);
  if (matches.length !== 1 || !metaAdsAccountField(matches[0]!)) return undefined;
  const names = matches[0]!.inputSchema?.propertyNames;
  return Array.isArray(names) && names.length > 0 && names.length <= 64 &&
    names.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 120)
    ? [...new Set(names)] : undefined;
}

export function normalizeMetaAdsAccountIds(ids: readonly string[]): string[] {
  const values = uniqueStrings(ids, 'Meta ad account');
  if (values.length > 50) throw new MetaAdsAccessPolicyError('Select no more than 50 Meta ad accounts.');
  if (values.some((value) => !/^(?:act_)?[0-9]{1,32}$/.test(value))) {
    throw new MetaAdsAccessPolicyError('Meta ad account IDs must contain 1 to 32 digits, optionally prefixed with act_.');
  }
  return values;
}

function isReviewedMetaAdsTool(name: string): name is keyof typeof META_ADS_REVIEWED_TOOL_EFFECTS {
  return Object.hasOwn(META_ADS_REVIEWED_TOOL_EFFECTS, name);
}

function normalizedConstraint(
  constraints: Record<string, string[]> | undefined,
  field: 'ad_account_id' | 'account_id',
): Record<string, string[]> | undefined {
  const allowed = constraints?.[field];
  if (!Array.isArray(allowed) || allowed.length === 0 ||
      allowed.some((value) => typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 120)) {
    return undefined;
  }
  return { [field]: [...new Set(allowed)] };
}

function uniqueStrings(values: readonly string[], label: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') throw new MetaAdsAccessPolicyError(`${label} selection is invalid.`);
    const value = raw.trim();
    if (!value || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new MetaAdsAccessPolicyError(`${label} selection is invalid.`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      unique.push(value);
    }
  }
  return unique;
}
