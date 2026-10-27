import type { GoogleWorkspaceService } from './api-oauth-policy.ts';
import { BUGSNAG_MCP_SERVER_URL } from './bugsnag-policy.ts';
import { MANAGED_CONNECTOR_CATALOG, composioManifest } from '../connections/catalog/index.ts';
import {
  META_ADS_OAUTH_DEFAULT_SCOPE,
  META_ADS_OAUTH_MANAGEMENT_SCOPE,
} from './mcp-oauth-clients.ts';

type ConnectorCategory = 'project' | 'dev' | 'data' | 'search' | 'docs' | 'business';

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
  toolAccessMode?: 'review';
  /** Optional provider-owned URL narrowing rendered in the recommended setup. */
  oauthPathScope?: 'sentry-org-project';
  auth:
    | { kind: 'none' }
    | { kind: 'oauth'; scope?: string; writeScope?: string }
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

interface GoogleWorkspaceServicePreset {
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

interface ManagedConnectorPreset {
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
    description: 'Research CRM records and make requested updates in one portal.',
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
  ...MANAGED_CONNECTOR_CATALOG.list().flatMap(({ id, toolkit }) => {
    const manifest = composioManifest(toolkit);
    return manifest ? [{
      id,
      managedToolkit: toolkit,
      providerId: toolkit,
      name: manifest.label,
      ...(manifest.preset.aliases ? { aliases: manifest.preset.aliases } : {}),
      description: manifest.description,
      category: manifest.preset.category,
      accent: manifest.preset.accent,
      logoId: toolkit,
    }] : [];
  }),
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
    id: 'meta-ads',
    name: 'Meta Ads',
    aliases: ['Facebook Ads', 'Instagram Ads'],
    description: 'Report on and manage ads for approved Meta ad accounts.',
    category: 'business',
    accent: '#0866FF',
    url: 'https://mcp.facebook.com/ads',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope: META_ADS_OAUTH_DEFAULT_SCOPE,
      writeScope: META_ADS_OAUTH_MANAGEMENT_SCOPE,
    },
    toolAccessMode: 'review',
    tokenDocsUrl: 'https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started',
    notes: 'An administrator first configures a Meta developer app for this installation. After signing in, choose the ad accounts and tools this Agent may use.',
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
    id: 'bugsnag',
    name: 'BugSnag',
    description: 'Investigate errors, releases, and performance, and manage error status.',
    category: 'dev',
    accent: '#4949E4',
    url: BUGSNAG_MCP_SERVER_URL,
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'api' },
    toolAccessMode: 'review',
    tokenDocsUrl: 'https://developer.smartbear.com/smartbear-mcp/docs/remote-bugsnag',
    tokenDocsHint: 'Sign in with SmartBear, then choose the tools this Agent may use.',
    notes: 'Tool access can reach every project available to the signed-in BugSnag account. Investigation tools are suggested first; editing tools are optional. Error severity changes are not supported.',
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
    id: 'amplitude',
    name: 'Amplitude',
    description: 'Query product analytics and manage charts, dashboards, cohorts, and experiments.',
    category: 'data',
    accent: '#1E61F0',
    url: 'https://mcp.amplitude.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'all:read all:write offline_access' },
    tokenDocsUrl: 'https://amplitude.com/docs/amplitude-ai/amplitude-mcp',
    tokenDocsHint: 'Sign in to the US-hosted Amplitude organization Chickpea should access.',
    notes:
      'This preset uses Amplitude\'s US data region. For an EU organization, add a custom connection to https://mcp.eu.amplitude.com/mcp.',
  },
  {
    id: 'better-stack',
    name: 'Better Stack',
    description: 'Query logs and metrics, manage incidents and monitors, and update status pages.',
    category: 'dev',
    accent: '#000000',
    url: 'https://mcp.betterstack.com',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write' },
    tokenDocsUrl: 'https://betterstack.com/docs/getting-started/integrations/mcp/',
    tokenDocsHint:
      'Sign in to Better Stack and choose the team and access level Chickpea should receive.',
    notes:
      'Choose Full access at sign-in if this Agent should change incidents, monitors, or status pages.',
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    description: 'Explore ClickHouse Cloud services and schemas, and run read-only SQL queries.',
    category: 'data',
    accent: '#FFCC01',
    url: 'https://mcp.clickhouse.cloud/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp:access openid profile email' },
    tokenDocsUrl: 'https://clickhouse.com/docs/use-cases/AI/MCP/remote_mcp',
    tokenDocsHint: 'Sign in to the ClickHouse Cloud account Chickpea should access.',
    notes:
      'Turn on remote MCP for each service first, under Connect → MCP in the ClickHouse Cloud console. All tools are read-only.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    description: 'Search logs, metrics, traces, and incidents, and manage monitors and dashboards.',
    category: 'dev',
    accent: '#632CA6',
    url: 'https://mcp.datadoghq.com/v1/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp_all' },
    tokenDocsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    tokenDocsHint:
      'Sign in to the Datadog organization on the US1 site (app.datadoghq.com) that Chickpea should access.',
    notes:
      'A Datadog administrator must first add this installation\'s /oauth/callback URL under Organization Settings → MCP OAuth Redirect URLs and enable MCP access on that page. For another Datadog site, add a custom connection to that site\'s MCP URL.',
  },
  {
    id: 'grafana',
    name: 'Grafana Cloud',
    description: 'Query metrics, logs, and traces, and manage dashboards, alerts, and incidents.',
    category: 'dev',
    accent: '#F46800',
    url: 'https://mcp.grafana.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'grafana:read grafana:query grafana:write' },
    tokenDocsUrl: 'https://grafana.com/docs/grafana-cloud/ai-tools/mcp-servers/cloud-mcp/',
    tokenDocsHint:
      'Sign in to Grafana Cloud, enter your stack URL, and choose the access Chickpea should receive.',
    notes:
      'The stack needs Grafana Assistant. Each connected user counts as an Assistant active user, and Grafana asks users to sign in again every 30 days. If Write access is greyed out at sign-in, ask an administrator for the Assistant Admin role.',
  },
  {
    id: 'honeycomb',
    name: 'Honeycomb',
    description: 'Query traces and events, and manage boards, triggers, and SLOs.',
    category: 'dev',
    accent: '#0298EC',
    url: 'https://mcp.honeycomb.io/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp:read mcp:write' },
    tokenDocsUrl: 'https://docs.honeycomb.io/integrations/mcp/configuration-guide',
    tokenDocsHint: 'Sign in to the US-hosted Honeycomb team Chickpea should access.',
    notes:
      'A team owner must turn on Honeycomb Intelligence first. For an EU team, add a custom connection to https://mcp.eu1.honeycomb.io/mcp.',
  },
  {
    id: 'motherduck',
    name: 'MotherDuck',
    description: 'Explore and query cloud DuckDB databases, and update their data and schemas.',
    category: 'data',
    accent: '#FF9539',
    url: 'https://api.motherduck.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp:connect' },
    tokenDocsUrl: 'https://motherduck.com/docs/key-tasks/ai-and-motherduck/mcp-setup/',
    tokenDocsHint: 'Sign in to the MotherDuck account Chickpea should access.',
    notes: 'One MotherDuck URL serves every region. Queries run in your organization\'s region.',
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Create, deploy, and manage projects, environment variables, forms, and access controls.',
    category: 'dev',
    accent: '#00C7B7',
    url: 'https://netlify-mcp.netlify.app/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write offline_access' },
    tokenDocsUrl: 'https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/',
    tokenDocsHint: 'Sign in to the Netlify account Chickpea should access.',
  },
  {
    id: 'statsig',
    name: 'Statsig',
    description: 'Manage feature gates, experiments, and dynamic configs, and review their results.',
    category: 'data',
    accent: '#232425',
    url: 'https://api.statsig.com/v3/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'personal_read_write' },
    tokenDocsUrl: 'https://docs.statsig.com/integrations/mcp',
    tokenDocsHint: 'Sign in to the Statsig account Chickpea should access.',
    notes:
      'Statsig sign-in uses a Personal Console API Key. An organization owner may first need to allow Personal Console API Keys for your role.',
  },
  {
    id: 'clay',
    name: 'Clay',
    description: 'Find and enrich people and companies, draft outreach, and run Clay Functions.',
    category: 'business',
    accent: '#4ACEF5',
    url: 'https://api.clay.com/v3/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp' },
    tokenDocsUrl: 'https://university.clay.com/docs/connect-to-clay-mcp',
    tokenDocsHint: 'Sign in to Clay and choose the workspace Chickpea should access.',
    notes:
      'If Clay says the application is not permitted, a workspace admin must turn on Unknown under Allowed MCP clients. Enrichment spends the workspace\'s Clay credits.',
  },
  {
    id: 'close',
    name: 'Close',
    description: 'Search leads, contacts, and activities, and create, update, and delete CRM records.',
    category: 'business',
    accent: '#1463FF',
    url: 'https://mcp.close.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp.read mcp.write_safe mcp.write_destructive offline_access' },
    tokenDocsUrl: 'https://help.close.com/integrations/close-mcp-server',
    tokenDocsHint: 'Sign in to Close and choose the organization Chickpea should access.',
    notes:
      'Close asks which permissions to grant at sign-in. Close groups record updates with deletes, so keep the delete permission if this Agent should change existing records.',
  },
  {
    id: 'customer-io',
    name: 'Customer.io',
    description: 'Read people, segments, and metrics, and update people and draft campaigns and templates.',
    category: 'business',
    accent: '#0B363B',
    url: 'https://mcp.customer.io/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write' },
    tokenDocsUrl: 'https://docs.customer.io/ai/mcp-server',
    tokenDocsHint:
      'Sign in to the US-hosted Customer.io account and choose the workspaces Chickpea should access.',
    notes:
      'An account admin must first turn on Customer.io MCP under Settings → AI. This connection drafts messages but cannot send them. For an EU account, add a custom connection to https://mcp-eu.customer.io/mcp.',
  },
  {
    id: 'mercury',
    name: 'Mercury',
    description: 'Read balances, transactions, and invoices, request payments and transfers, and edit categories.',
    category: 'business',
    accent: '#272735',
    url: 'https://mcp.mercury.com/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope:
        'read offline_access transactions:request transfers:request categories:create categories:edit transactions:update',
    },
    tokenDocsUrl: 'https://docs.mercury.com/docs/connecting-mercury-mcp',
    tokenDocsHint: 'Sign in to the Mercury account Chickpea should access.',
    notes:
      'Mercury MCP is in beta. Payments and transfers that this Agent requests wait for approval in Mercury before any money moves.',
  },
  {
    id: 'paypal',
    name: 'PayPal',
    description: 'Review transactions and disputes, and create invoices, issue refunds, and manage subscriptions.',
    category: 'business',
    accent: '#002991',
    url: 'https://mcp.paypal.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://developer.paypal.com/ai-tools/mcp-server',
    tokenDocsHint: 'Sign in to the PayPal account Chickpea should access.',
    notes:
      'This preset connects live PayPal accounts. For PayPal sandbox test accounts, add a custom connection to https://mcp.sandbox.paypal.com/mcp.',
  },
  {
    id: 'plain',
    name: 'Plain',
    description: 'Search threads, customers, and tenants, and reply to, assign, label, and resolve threads.',
    category: 'business',
    accent: '#2CE68C',
    url: 'https://mcp.plain.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'openid offline_access' },
    tokenDocsUrl: 'https://www.plain.com/docs/integrations/mcp-server',
    tokenDocsHint: 'Sign in to Plain and choose the workspace Chickpea should access.',
    notes:
      'This Agent acts with the signed-in user\'s Plain role, and replies appear to come from that user.',
  },
  {
    id: 'pylon',
    name: 'Pylon',
    description: 'Search issues, accounts, and contacts, and reply to customers, update issues, and edit articles.',
    category: 'business',
    accent: '#5B0EFF',
    url: 'https://mcp.usepylon.com',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'openid offline_access' },
    tokenDocsUrl: 'https://docs.usepylon.com/pylon-docs/integrations/pylon-mcp',
    tokenDocsHint: 'Sign in to the US-hosted Pylon workspace Chickpea should access.',
    notes:
      'Members and Admins with MCP Access can connect; Viewers and Integration Users cannot. For an EU workspace, add a custom connection to https://mcp.eu.usepylon.com.',
  },
  {
    id: 'calendly',
    name: 'Calendly',
    description: 'Find open times and meetings, and book or cancel meetings, edit event types, and create links.',
    category: 'business',
    accent: '#006BFF',
    url: 'https://mcp.calendly.com',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp:scheduling:read mcp:scheduling:write' },
    tokenDocsUrl: 'https://calendly.com/help/connect-calendly-to-your-ai-tools',
    tokenDocsHint: 'Sign in to the Calendly account Chickpea should access.',
    notes:
      'Any Calendly plan can connect. Booking a meeting for an invitee needs a paid plan, and routing-form tools need Teams or higher.',
  },
  {
    id: 'fathom',
    name: 'Fathom',
    description: 'Search and list meetings, and read summaries, transcripts, and action items.',
    category: 'docs',
    accent: '#00BEFF',
    url: 'https://api.fathom.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp' },
    tokenDocsUrl: 'https://developers.fathom.ai/mcp-docs',
    tokenDocsHint: 'Sign in to the Fathom account Chickpea should access.',
  },
  {
    id: 'lucid',
    name: 'Lucid',
    description: 'Search and read Lucid documents, and create diagrams, edit documents, and share them.',
    category: 'docs',
    accent: '#282C33',
    url: 'https://mcp.lucid.app/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'offline_access' },
    tokenDocsUrl:
      'https://help.lucid.co/hc/en-us/articles/42578801807508-Integrate-Lucid-with-AI-tools-using-the-Lucid-MCP-server',
    tokenDocsHint: 'Sign in to the Lucid account Chickpea should access.',
    notes:
      'On Lucid Team and Enterprise accounts, an admin must first enable MCP access. Lucid MCP is not available on FedRAMP accounts.',
  },
  {
    id: 'otter',
    name: 'Otter.ai',
    description: 'Search meetings and fetch full conversation transcripts.',
    category: 'docs',
    accent: '#144FFF',
    url: 'https://mcp.otter.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'profile:read conversations:read' },
    tokenDocsUrl: 'https://help.otter.ai/hc/en-us/articles/35287607569687-Otter-MCP-Server',
    tokenDocsHint: 'Sign in to the Otter account Chickpea should access.',
  },
  {
    id: 'pandadoc',
    name: 'PandaDoc',
    description: 'Search and track documents and templates, and create, edit, and send documents for signature.',
    category: 'business',
    accent: '#258567',
    url: 'https://mcp.pandadoc.com/v1/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write documents:read documents:edit documents:send' },
    tokenDocsUrl: 'https://developers.pandadoc.com/docs/getting-started-with-mcp',
    tokenDocsHint:
      'Sign in to the PandaDoc account at app.pandadoc.com that Chickpea should access.',
    notes:
      'For an account at app.pandadoc.eu, add a custom connection to https://mcp.pandadoc.eu/v1/mcp.',
  },
  {
    id: 'read-ai',
    name: 'Read AI',
    description: 'Search and read meetings, manage and share folders and reports, and send a bot to meetings.',
    category: 'docs',
    accent: '#4361EE',
    url: 'https://api.read.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp:execute meeting:read offline_access' },
    tokenDocsUrl: 'https://support.read.ai/hc/en-us/articles/49381158409491-MCP-Server',
    tokenDocsHint: 'Sign in to the Read AI account Chickpea should access.',
    notes:
      'Read AI MCP is in open beta. In a Read AI workspace, Downloads must be on under Workspace Settings → Reports & Sharing. For an EU account, add a custom connection to https://prod-eu-api.read.ai/mcp.',
  },
  {
    id: 'todoist',
    name: 'Todoist',
    description: 'Find tasks, projects, and activity, and add, update, complete, and move Todoist items.',
    category: 'project',
    accent: '#E44332',
    url: 'https://ai.todoist.net/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'data:read_write' },
    tokenDocsUrl:
      'https://www.todoist.com/help/todoist/todoist-and-ai/connect-todoist-to-an-ai-assistant-xMSzFfHng',
    tokenDocsHint: 'Sign in to the Todoist account Chickpea should access.',
    notes: 'In a Todoist organization, an administrator may first need to allow third-party connections.',
  },
  {
    id: 'webflow',
    name: 'Webflow',
    description: 'Read site, CMS, and analytics data, and edit pages, styles, and CMS items and publish sites.',
    category: 'dev',
    accent: '#146EF5',
    url: 'https://mcp.webflow.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth' },
    tokenDocsUrl: 'https://developers.webflow.com/mcp/reference/getting-started',
    tokenDocsHint: 'Sign in to Webflow and choose the workspace and sites Chickpea should access.',
    notes:
      'Only site owners and admins can authorize a site, and each connection covers one Webflow workspace. Analytics needs the Webflow Analyze add-on.',
  },
  {
    id: 'wix',
    name: 'Wix',
    description: 'List sites, query and update site data such as stores and bookings, and create and publish sites.',
    category: 'dev',
    accent: '#0C6EFC',
    url: 'https://mcp.wix.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'offline_access' },
    tokenDocsUrl: 'https://dev.wix.com/docs/overview/ai-the-wix-platform/the-wix-mcp',
    tokenDocsHint: 'Sign in to the Wix account whose sites Chickpea should manage.',
  },
  {
    id: 'apollo',
    name: 'Apollo.io',
    description: 'Search and enrich people and companies, manage contacts, deals, and sequences, and send emails.',
    category: 'business',
    accent: '#EBF212',
    url: 'https://mcp.apollo.io/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'oauth',
      scope:
        'read_user_profile app_scopes people_bulk_match organizations_bulk_enrich organizations_enrich people_match webhook_result_read mixed_people_api_search organizations_job_posting mixed_companies_search organizations_search contact_write contact_update contacts_search contact_read account_write account_update context_center_read context_center_write emailer_campaigns_search emailer_campaigns_create emailer_campaigns_update emailer_campaigns_approve emailer_campaigns_add_contact_ids emailer_campaigns_remove_or_stop_contact_ids emailer_schedules_list emailer_messages_search emailer_messages_create emailer_messages_send_now emailer_messages_email_send_status emailer_messages_get_content emailer_campaigns_activity_feed report_sync agent_task email_accounts_list custom_objects_write custom_objects_read custom_field_write opportunity_write opportunities_list opportunity_read tasks_create tasks_list email_account_purchase_list email_account_purchase_create domain_purchase_list domain_purchase_create domain_authentication_status waterfall_enrichments phone_call_write phone_call_update phone_call_search account_bulk_create contacts_bulk_create api_usage_stats_read credit_usage_stats_read users_list custom_fields_list conversation_intelligence_search conversation_intelligence_show tags_list lists_create lists_update lists_add_entities lists_remove_entities website_visitor_domain_tracker_read website_visitor_domain_tracker_update website_visitor_domain_tracker_send_install_email website_visitor_domain_tracker_install_script website_visitors_read emailer_campaign_read',
    },
    tokenDocsUrl: 'https://docs.apollo.io/docs/apollo-mcp',
    tokenDocsHint: 'Sign in to the Apollo account Chickpea should access.',
    notes:
      'Enrichment actions spend Apollo credits. Free accounts registered with a personal email address cannot search or enrich people and companies.',
  },
  {
    id: 'attio',
    name: 'Attio',
    description: 'Search records, notes, emails, and calls, and create and update records, lists, notes, and tasks.',
    category: 'business',
    accent: '#141415',
    url: 'https://mcp.attio.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'openid offline_access mcp' },
    tokenDocsUrl: 'https://docs.attio.com/mcp/overview',
    tokenDocsHint: 'Sign in to the Attio account Chickpea should access.',
    notes: 'SQL reporting is not available on every Attio billing plan.',
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    description: 'Search tasks and Docs, create and update tasks, lists, and Docs, track time, and post comments.',
    category: 'project',
    accent: '#7B68EE',
    url: 'https://mcp.clickup.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read write' },
    tokenDocsUrl: 'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server',
    tokenDocsHint: 'Sign in to ClickUp and select the Workspaces Chickpea should access.',
    notes:
      'Without the Everything AI add-on, ClickUp allows a set number of MCP calls per rolling 24 hours, from 100 on the Free Forever plan.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Search code, issues, and pipelines, create issues, commit files, and open and merge merge requests.',
    category: 'dev',
    accent: '#FC6D26',
    url: 'https://gitlab.com/api/v4/mcp',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'mcp' },
    tokenDocsUrl: 'https://docs.gitlab.com/user/model_context_protocol/mcp_server/',
    tokenDocsHint: 'Sign in to the GitLab.com account Chickpea should access.',
    notes:
      'This preset connects GitLab.com. For GitLab Self-Managed or Dedicated, add a custom connection to your instance\'s /api/v4/mcp URL. Duo Agent Platform tools need a Premium or Ultimate group with GitLab Duo Agent Platform turned on, or GitLab credits.',
  },
  {
    id: 'miro',
    name: 'Miro',
    description: 'Search and read boards, create diagrams, tables, and prototypes, edit boards, and reply to comments.',
    category: 'docs',
    accent: '#050038',
    url: 'https://mcp.miro.com/',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'boards:read boards:write' },
    tokenDocsUrl: 'https://developers.miro.com/docs/miro-mcp',
    tokenDocsHint: 'Sign in to the Miro account Chickpea should access.',
    notes:
      'On Enterprise plans, an admin must first turn on MCP under Admin settings → Apps and integrations → MCP. Each Miro user connects one team at a time, so authorizing another team or app replaces the earlier connection.',
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
