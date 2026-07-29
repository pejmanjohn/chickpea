export interface UsageProviderGuidance {
  providerId: string;
  displayName: string;
  authModes: string[];
  runtimeCoverage: 'metered' | 'mixed' | 'operations_only';
  priceCoverage: 'release_pinned' | 'mixed' | 'unknown';
  scopeGuidance: string;
  accountBoundary: string;
  limitsUrl: string | null;
  pricingUrl: string | null;
  reviewedAt: number;
}

const REVIEWED_AT = Date.UTC(2026, 6, 28);

/**
 * Release-pinned operator guidance for current Chickpea routes. This catalog is
 * explanatory only: it contains no provider-control endpoints, quota reads, or
 * billing credentials and must never be interpreted as live provider state.
 */
export const USAGE_PROVIDER_GUIDANCE: readonly UsageProviderGuidance[] = [
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    authModes: ['API key'],
    runtimeCoverage: 'metered',
    priceCoverage: 'release_pinned',
    scopeGuidance: 'Use a dedicated Anthropic Workspace and API key for the Chickpea installation when practical.',
    accountBoundary: 'Provider limits and spend include activity in the key workspace, including work outside Chickpea.',
    limitsUrl: 'https://platform.claude.com/docs/en/api/rate-limits',
    pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    reviewedAt: REVIEWED_AT,
  },
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    authModes: ['API key'],
    runtimeCoverage: 'metered',
    priceCoverage: 'release_pinned',
    scopeGuidance: 'Use a dedicated OpenAI Project and project API key for the Chickpea installation when practical.',
    accountBoundary: 'Provider budgets and limits apply to the selected project or organization, not only to Chickpea work.',
    limitsUrl: 'https://developers.openai.com/api/docs/guides/production-best-practices',
    pricingUrl: 'https://developers.openai.com/api/docs/pricing',
    reviewedAt: REVIEWED_AT,
  },
  {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    authModes: ['API key'],
    runtimeCoverage: 'metered',
    priceCoverage: 'release_pinned',
    scopeGuidance: 'Use a dedicated OpenRouter API key and configure its credit limit for the Chickpea installation.',
    accountBoundary: 'OpenRouter routing and account activity can make provider totals differ from Chickpea list-price estimates.',
    limitsUrl: 'https://openrouter.ai/docs/api/api-reference/api-keys/create-keys',
    pricingUrl: 'https://openrouter.ai/docs/faq',
    reviewedAt: REVIEWED_AT,
  },
  {
    providerId: 'cloudflare-workers-ai',
    displayName: 'Cloudflare Workers AI (REST)',
    authModes: ['API token'],
    runtimeCoverage: 'metered',
    priceCoverage: 'release_pinned',
    scopeGuidance: 'Use a narrowly scoped Cloudflare API token and a dedicated account boundary where your deployment model permits it.',
    accountBoundary: 'Cloudflare account usage includes Workers AI requests outside Chickpea that share the same account.',
    limitsUrl: 'https://developers.cloudflare.com/workers-ai/platform/limits/',
    pricingUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    reviewedAt: REVIEWED_AT,
  },
  {
    providerId: 'cloudflare',
    displayName: 'Cloudflare Workers AI binding',
    authModes: ['Workers binding'],
    runtimeCoverage: 'operations_only',
    priceCoverage: 'unknown',
    scopeGuidance: 'Treat the Cloudflare account containing this Worker as the provider accounting boundary.',
    accountBoundary: 'The binding route currently proves work status only; token usage and estimated spend remain unknown.',
    limitsUrl: 'https://developers.cloudflare.com/workers-ai/platform/limits/',
    pricingUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    reviewedAt: REVIEWED_AT,
  },
  {
    providerId: 'custom',
    displayName: 'Local or custom provider',
    authModes: ['Operator supplied'],
    runtimeCoverage: 'operations_only',
    priceCoverage: 'unknown',
    scopeGuidance: 'Configure limits and accounting directly with the custom runtime or upstream provider.',
    accountBoundary: 'Chickpea cannot infer the billing boundary or price contract for a custom route.',
    limitsUrl: null,
    pricingUrl: null,
    reviewedAt: REVIEWED_AT,
  },
] as const;
