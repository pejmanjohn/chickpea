import type { GoogleWorkspaceService } from './api-oauth-policy.ts';

export type ConnectorCategory = 'project' | 'dev' | 'data' | 'search' | 'docs' | 'business';

interface ConnectorPresetCommon {
  id: string; // also seeds the connection id; MUST match /^[a-z0-9][a-z0-9-]{0,63}$/
  name: string;
  /** Exact user-facing lookup names owned by this catalog entry. */
  aliases?: string[];
  description: string;
  category: ConnectorCategory;
  accent: string; // hex color for the monogram chip, e.g. '#5E6AD2'
  tokenDocsUrl?: string;
  tokenDocsHint?: string;
  notes?: string;
  /** Reuse another preset's brand mark for a distinct connection lane. */
  logoId?: string;
}

interface McpPresetLane {
  url: string;
  transport: 'streamable-http';
  /** Optional provider-owned URL narrowing rendered in the recommended setup. */
  oauthPathScope?: 'sentry-org-project';
  auth:
    | { kind: 'none' }
    | { kind: 'oauth'; scope?: string }
    | { kind: 'bearer'; placeholder: string }
    | {
        kind: 'header';
        headerName: string;
        valuePrefix?: string;
        placeholder: string;
        /** The server also accepts anonymous requests, usually at lower limits. */
        optional?: boolean;
      };
}

interface ApiPresetLane {
  api: {
    hosts: string[];
    hostTemplate?: boolean;
    pathPrefixes?: string[];
    headerName: string;
    valuePrefix?: string;
    methods: string[];
    placeholder: string;
    oauth?: { provider: 'google' };
  };
}

export type ConnectorPreset = ConnectorPresetCommon &
  (
    | McpPresetLane
    | (ApiPresetLane & { url?: never; transport?: never; auth?: never })
    | (McpPresetLane & ApiPresetLane)
  );

export interface GoogleWorkspaceServicePreset {
  id: string;
  /** Native Google OAuth fallback. Managed-only connectors intentionally omit this. */
  service?: GoogleWorkspaceService;
  /** Managed-provider toolkit used when that lane is available. */
  managedToolkit:
    | 'gmail'
    | 'googlecalendar'
    | 'googledrive'
    | 'googlesheets'
    | 'googledocs'
    | 'googleslides';
  /** Native Google OAuth fallback preset. Managed-only connectors omit this. */
  connectionPresetId?: 'google-workspace';
  name: string;
  aliases?: string[];
  description: string;
  accent: string;
  logoId?: string;
}

export interface ManagedConnectorPreset {
  id: string;
  managedToolkit: string;
  providerId: string;
  name: string;
  aliases?: string[];
  description: string;
  category: ConnectorCategory;
  accent: string;
  logoId?: string;
}

// These are service-level catalog entries, not independent connector configs.
// Each one opens and updates the canonical google-workspace connection so the
// BYO OAuth client, token bundle, identity, and refresh lease remain shared.
export const GOOGLE_WORKSPACE_SERVICE_PRESETS: GoogleWorkspaceServicePreset[] = [
  {
    id: 'gmail',
    aliases: ['Google Mail'],
    service: 'gmail',
    managedToolkit: 'gmail',
    connectionPresetId: 'google-workspace',
    name: 'Gmail',
    description: 'Search mail, summarize threads, and draft or organize messages.',
    accent: '#EA4335',
  },
  {
    id: 'google-calendar',
    aliases: ['Calendar', 'GCal'],
    service: 'calendar',
    managedToolkit: 'googlecalendar',
    connectionPresetId: 'google-workspace',
    name: 'Google Calendar',
    description: 'Review availability and create or update events.',
    accent: '#4285F4',
  },
  {
    id: 'google-drive',
    aliases: ['Drive'],
    service: 'drive',
    managedToolkit: 'googledrive',
    connectionPresetId: 'google-workspace',
    name: 'Google Drive',
    description: 'Find, read, create, and organize files.',
    accent: '#4285F4',
  },
  {
    id: 'google-sheets',
    aliases: ['Sheets'],
    managedToolkit: 'googlesheets',
    name: 'Google Sheets',
    description: 'Find spreadsheets, read ranges, and make bounded table updates.',
    accent: '#0F9D58',
    logoId: 'google-sheets',
  },
  {
    id: 'google-docs',
    aliases: ['Docs'],
    managedToolkit: 'googledocs',
    name: 'Google Docs',
    description: 'Find, read, export, create, and update documents.',
    accent: '#4285F4',
    logoId: 'google-docs',
  },
  {
    id: 'google-slides',
    aliases: ['Slides'],
    managedToolkit: 'googleslides',
    name: 'Google Slides',
    description: 'Read presentations and create or update slides through bounded operations.',
    accent: '#F4B400',
    logoId: 'google-slides',
  },
];

export const MANAGED_CONNECTOR_PRESETS: ManagedConnectorPreset[] = [
  {
    id: 'notion-managed',
    managedToolkit: 'notion',
    providerId: 'notion',
    name: 'Notion',
    description: 'Search, read, create, and update only the pages and databases you approve.',
    category: 'docs',
    accent: '#000000',
    logoId: 'notion',
  },
  {
    id: 'google-search-console',
    managedToolkit: 'google_search_console',
    providerId: 'google',
    name: 'Google Search Console',
    description: 'Inspect indexing, sitemaps, and search performance for selected sites.',
    category: 'business',
    accent: '#458CF5',
    logoId: 'google-search-console',
  },
  {
    id: 'google-analytics',
    managedToolkit: 'google_analytics',
    providerId: 'google',
    name: 'Google Analytics',
    description: 'Read metadata, quotas, and bounded GA4 reports for selected properties.',
    category: 'business',
    accent: '#E37400',
    logoId: 'google-analytics',
  },
  {
    id: 'hubspot-managed',
    managedToolkit: 'hubspot',
    providerId: 'hubspot',
    name: 'HubSpot',
    description: 'Research CRM records and make explicitly confirmed updates in one portal.',
    category: 'business',
    accent: '#FF7A59',
    logoId: 'hubspot',
  },
  {
    id: 'gong-managed',
    managedToolkit: 'gong',
    providerId: 'gong',
    name: 'Gong',
    description: 'Analyze calls, transcripts, coaching, tasks, and trackers in selected workspaces.',
    category: 'business',
    accent: '#6E3BF4',
    logoId: 'gong',
  },
  {
    id: 'google-ads',
    managedToolkit: 'googleads',
    providerId: 'google',
    name: 'Google Ads',
    description: 'Analyze and manage campaigns for explicitly selected client accounts.',
    category: 'business',
    accent: '#4285F4',
    logoId: 'google-ads',
  },
  {
    id: 'youtube-managed',
    managedToolkit: 'youtube',
    providerId: 'google',
    name: 'YouTube',
    description: 'Analyze and manage explicitly selected channels with quota-aware publishing.',
    category: 'business',
    accent: '#FF0000',
    logoId: 'youtube',
  },
];

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'linear',
    name: 'Linear',
    description: 'Find, create, and update issues, projects, and workspace plans.',
    category: 'project',
    accent: '#5E6AD2',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write' },
    tokenDocsUrl: 'https://linear.app/docs/mcp',
    tokenDocsHint: 'Sign in to Linear and choose the workspace Chickpea should access.',
    notes:
      'Chickpea requests Linear read and write access so it can find, create, and update workspace objects.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    description: 'Search and update Jira work, Confluence content, and Compass data.',
    category: 'project',
    accent: '#0052CC',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope:
        'read:me read:account offline_access email read:jira-work write:jira-work search:confluence read:confluence-user read:page:confluence write:page:confluence read:comment:confluence write:comment:confluence read:space:confluence read:hierarchical-content:confluence write:component:compass read:component:compass read:scorecard:compass write:scorecard:compass read:event:compass read:metric:compass read:all:twg write:all:twg',
    },
    tokenDocsUrl: 'https://developer.atlassian.com/cloud/rovo-mcp/guides/getting-started/',
    tokenDocsHint:
      'Sign in to Atlassian and choose the sites and products Chickpea should access.',
    notes:
      'Chickpea requests Atlassian read and write access; available Jira, Confluence, Compass, and Teamwork Graph tools still follow your user permissions and organization policy.',
  },
  {
    id: 'notion',
    name: 'Native Notion',
    description: 'Search, read, create, and update workspace pages and databases.',
    category: 'docs',
    accent: '#000000',
    url: 'https://mcp.notion.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://developers.notion.com/guides/mcp/build-mcp-client',
    tokenDocsHint: 'Sign in to Notion and choose the workspace access Chickpea should receive.',
    notes:
      'Notion MCP requires user OAuth. Chickpea discovers Notion metadata, registers this self-hosted install when needed, and stores the resulting credentials outside the profile.',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    description: 'Investigate errors, issues, traces, and application health.',
    category: 'dev',
    accent: '#362D59',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'streamable-http',
    oauthPathScope: 'sentry-org-project',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://github.com/getsentry/sentry-mcp',
    tokenDocsHint: 'Sign in to Sentry and approve the MCP skills Chickpea should receive.',
    notes:
      'Optionally narrow the OAuth resource to one organization or one organization/project. The scoped URL is enforced on every Sentry MCP request.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Search Stripe data and manage customers, invoices, payments, and subscriptions.',
    category: 'business',
    accent: '#635BFF',
    url: 'https://mcp.stripe.com',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'rk_live_…' },
    tokenDocsUrl: 'https://dashboard.stripe.com/apikeys',
    tokenDocsHint: 'Stripe → Developers → API keys',
    notes: 'Use a restricted key (rk_), not a full secret key.',
  },
  {
    id: 'cloudflare-api',
    name: 'Cloudflare API',
    description: 'Search Cloudflare docs and execute approved operations across your account.',
    category: 'dev',
    accent: '#F38020',
    url: 'https://mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/',
    tokenDocsHint:
      'Sign in to Cloudflare and choose the account permissions Chickpea should receive.',
    notes:
      'Cloudflare Code Mode covers the entire API through three token-efficient tools: docs, search, and execute. Granted actions remain limited by the permissions you approve.',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    description: 'Manage projects, databases, storage, functions, and development settings.',
    category: 'data',
    accent: '#3ECF8E',
    url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope:
        'organizations:read projects:read projects:write database:write database:read analytics:read secrets:read edge_functions:read edge_functions:write environment:read environment:write storage:read',
    },
    tokenDocsUrl: 'https://supabase.com/docs/guides/ai-tools/mcp',
    tokenDocsHint:
      'Sign in to Supabase and choose the organization and projects Chickpea should access.',
    notes:
      'Use a development or test project; do not connect production data. Chickpea limits the connection to that project, with read-only access recommended by default.',
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Inspect and manage Postgres projects, branches, databases, and compute.',
    category: 'data',
    accent: '#00E599',
    url: 'https://mcp.neon.tech/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Neon API key' },
    tokenDocsUrl: 'https://console.neon.tech/app/settings/api-keys',
    tokenDocsHint: 'Neon → Account settings → API keys',
  },
  {
    id: 'posthog',
    name: 'PostHog',
    description: 'Analyze product data and manage insights, feature flags, and experiments.',
    category: 'data',
    accent: '#F54E00',
    url: 'https://mcp.posthog.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://posthog.com/docs/model-context-protocol',
    tokenDocsHint:
      'Sign in to PostHog and choose the organization and project Chickpea should access.',
    notes:
      'PostHog OAuth routes to the correct US or EU region and provides the read and write tools allowed by your account.',
  },
  {
    id: 'airtable',
    name: 'Airtable',
    description: 'Read and update records, bases, schemas, and comments.',
    category: 'data',
    accent: '#18BFFF',
    url: 'https://mcp.airtable.com/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope:
        'data.records:read data.records:write schema.bases:read schema.bases:write data.recordComments:read data.recordComments:write workspacesAndBases:read',
    },
    tokenDocsUrl: 'https://support.airtable.com/using-the-airtable-mcp-server',
    tokenDocsHint:
      'Sign in to Airtable and choose the workspaces and bases Chickpea should access.',
    notes:
      'Chickpea requests read and write access for records, schemas, and comments in the workspaces and bases you approve.',
  },
  {
    id: 'monday',
    name: 'Monday.com',
    description: 'Find and update workspaces, boards, items, and columns.',
    category: 'project',
    accent: '#FF3D57',
    url: 'https://mcp.monday.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'monday.com API token' },
    tokenDocsUrl: 'https://developer.monday.com/api-reference/docs/authentication',
    tokenDocsHint: 'monday.com → avatar → Developers → My access tokens',
    notes:
      'monday.com also supports hosted MCP OAuth. This release keeps the existing token path; evaluate an additive OAuth migration separately.',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    description: 'Search customers and conversations, and manage support content.',
    category: 'business',
    accent: '#1F8DED',
    url: 'https://mcp.intercom.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://developers.intercom.com/docs/guides/mcp',
    tokenDocsHint: 'Sign in to the US-hosted Intercom workspace Chickpea should access.',
    notes:
      'Intercom currently supports its hosted MCP server only for US-hosted workspaces. EU and Australian workspaces cannot use this preset yet.',
  },
  {
    id: 'exa',
    name: 'Exa',
    description: 'Search the web and retrieve research-ready pages and context.',
    category: 'search',
    accent: '#1F40FF',
    url: 'https://mcp.exa.ai/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'header',
      headerName: 'x-api-key',
      placeholder: 'Exa API key',
      optional: true,
    },
    tokenDocsUrl: 'https://dashboard.exa.ai/api-keys',
    tokenDocsHint: 'Exa → Dashboard → API keys',
    notes: 'Also works without a key at lower limits.',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    description: 'Search, scrape, crawl, and map websites into structured content.',
    category: 'search',
    accent: '#FF5A1F',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'fc-…' },
    tokenDocsUrl: 'https://www.firecrawl.dev/app/api-keys',
    tokenDocsHint: 'Firecrawl → Dashboard → API keys',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    description: 'Explore models, datasets, Spaces, papers, and community tools.',
    category: 'data',
    accent: '#FFD21E',
    url: 'https://huggingface.co/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'hf_…' },
    tokenDocsUrl: 'https://huggingface.co/settings/tokens',
    tokenDocsHint: 'Hugging Face → Settings → Access Tokens (read scope)',
  },
  {
    id: 'ahrefs',
    name: 'Ahrefs',
    description: 'Research keywords, backlinks, competitors, and search performance.',
    category: 'search',
    accent: '#FF8D00',
    url: 'https://api.ahrefs.com/mcp/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Ahrefs MCP key' },
    tokenDocsUrl: 'https://docs.ahrefs.com/docs/mcp/reference/introduction',
    tokenDocsHint: 'Ahrefs → Account settings → API keys → Generate MCP key',
    notes: 'Lite plan or higher. Use a dedicated MCP key — regular API keys are not accepted.',
  },
  {
    id: 'fireflies',
    name: 'Fireflies',
    description: 'Search meeting transcripts, summaries, speakers, and action items.',
    category: 'business',
    accent: '#E1447E',
    url: 'https://api.fireflies.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Fireflies API key' },
    tokenDocsUrl: 'https://docs.fireflies.ai/getting-started/mcp-configuration',
    tokenDocsHint: 'Fireflies → Settings → Developer settings → API key',
  },
  {
    id: 'gamma',
    name: 'Gamma',
    description: 'Create and browse presentations, documents, and webpages.',
    category: 'docs',
    accent: '#3B5BDB',
    url: 'https://mcp.gamma.app/mcp',
    transport: 'streamable-http',
    auth: { kind: 'header', headerName: 'X-API-KEY', placeholder: 'sk-gamma-…' },
    tokenDocsUrl: 'https://gamma.app/settings/api-keys',
    tokenDocsHint: 'Gamma → Settings → API keys',
    notes: 'API keys require a Pro, Ultra, Teams, or Business plan.',
  },
  {
    id: 'granola',
    name: 'Granola',
    description:
      'Search meeting notes and transcripts, browse folders, and extract decisions and action items.',
    category: 'docs',
    accent: '#292929',
    url: 'https://mcp.granola.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp' },
    tokenDocsUrl: 'https://docs.granola.ai/help-center/sharing/integrations/mcp',
    tokenDocsHint:
      'Sign in to Granola and choose the account whose meeting notes Chickpea should access.',
    notes:
      'Granola MCP uses personal browser OAuth. Anyone who can use this profile may query meetings available to the connected account; plan and workspace restrictions still apply.',
  },
  {
    id: 'incident-io',
    name: 'incident.io',
    description: 'Query incidents and alerts, check on-call, and manage escalations.',
    category: 'dev',
    accent: '#F25533',
    url: 'https://mcp.incident.io/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'incident.io API key' },
    tokenDocsUrl: 'https://docs.incident.io/ai/remote-mcp',
    tokenDocsHint: 'incident.io → Settings → API keys',
    notes: 'Public beta — Team, Pro, and Enterprise plans.',
  },
  {
    id: 'lunarcrush',
    name: 'LunarCrush',
    description: 'Analyze social activity and market signals for digital assets.',
    category: 'data',
    accent: '#101113',
    url: 'https://lunarcrush.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'LunarCrush API key' },
    tokenDocsUrl: 'https://lunarcrush.com/developers/api/authentication',
    tokenDocsHint: 'LunarCrush → Developers → API authentication',
    notes: 'API key requires a LunarCrush subscription.',
  },
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Use one shared OAuth client for Gmail, Calendar, and Drive.',
    category: 'docs',
    accent: '#4285F4',
    api: {
      hosts: ['gmail.googleapis.com', 'www.googleapis.com'],
      pathPrefixes: ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3'],
      headerName: 'Authorization',
      valuePrefix: 'Bearer ',
      methods: ['GET', 'HEAD'],
      placeholder: '',
      oauth: { provider: 'google' },
    },
    tokenDocsUrl: 'https://console.cloud.google.com/apis/credentials',
    tokenDocsHint:
      'Create a Web application OAuth client in your own Google Cloud project, then paste its client ID and secret here.',
    notes:
      'Use a dedicated Google account when possible. Chickpea stores the OAuth client and tokens outside the profile and grants only the services selected during setup.',
  },
  {
    id: 'asana',
    name: 'Asana',
    description: 'Find, create, and update tasks, projects, teams, and portfolios.',
    category: 'project',
    accent: '#F06A6A',
    api: {
      hosts: ['app.asana.com'],
      pathPrefixes: ['/api/1.0'],
      headerName: 'Authorization',
      valuePrefix: 'Bearer ',
      methods: ['GET', 'POST', 'PUT'],
      placeholder: 'Asana personal access token',
    },
    tokenDocsUrl: 'https://app.asana.com/0/my-apps',
    tokenDocsHint: 'Asana → Settings → Apps → Developer apps → Personal access tokens',
  },
  {
    id: 'zendesk',
    name: 'Zendesk',
    description: 'Search and update tickets, users, organizations, and help-center content.',
    category: 'business',
    accent: '#03363D',
    api: {
      hosts: ['your-subdomain.zendesk.com'],
      hostTemplate: true,
      pathPrefixes: ['/api/v2'],
      headerName: 'Authorization',
      valuePrefix: 'Basic ',
      methods: ['GET', 'POST', 'PUT'],
      placeholder: 'base64 of email/token:api_token',
    },
    tokenDocsUrl: 'https://support.zendesk.com/hc/en-us/articles/4408889192858',
    tokenDocsHint:
      'Admin Center → Apps and integrations → APIs → Zendesk API → add an API token; credential = base64("<email>/token:<api_token>")',
  },
];

export type ConnectorCatalogPreset =
  | ConnectorPreset
  | GoogleWorkspaceServicePreset
  | ManagedConnectorPreset;

/** Connector catalog entries used to start a fresh Agent-owned connection. */
export const CONNECTION_CATALOG_PRESETS: ConnectorCatalogPreset[] = [
  ...CONNECTOR_PRESETS.filter(({ id }) => id !== 'google-workspace' && id !== 'notion'),
  ...GOOGLE_WORKSPACE_SERVICE_PRESETS,
  ...MANAGED_CONNECTOR_PRESETS,
].sort((left, right) => left.name.localeCompare(right.name));

export function resolveConnectorCatalogPreset(
  value: string,
): ConnectorCatalogPreset | undefined {
  const matches = matchingConnectorCatalogPresets(value);
  return matches.length === 1 ? matches[0] : undefined;
}

export function matchingConnectorCatalogPresets(
  value: string,
  catalog: readonly ConnectorCatalogPreset[] = CONNECTION_CATALOG_PRESETS,
): ConnectorCatalogPreset[] {
  const normalized = normalizeConnectorLookup(value);
  if (!normalized) return [];
  return catalog.filter(({ id, name, aliases = [] }) =>
    [id, name, ...aliases].some((candidate) =>
      normalized === normalizeConnectorLookup(candidate)
    )
  );
}

export function connectorCatalogLookupNames(preset: ConnectorCatalogPreset): string[] {
  return [preset.id, preset.name, ...(preset.aliases ?? [])];
}

export function presetLanes(preset: ConnectorPreset): { mcp: boolean; api: boolean } {
  return {
    mcp: 'url' in preset && typeof preset.url === 'string',
    api: 'api' in preset && preset.api !== undefined,
  };
}

export function getConnectorPreset(id: string): ConnectorPreset | undefined {
  return CONNECTOR_PRESETS.find((preset) => preset.id === id);
}

function normalizeConnectorLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
