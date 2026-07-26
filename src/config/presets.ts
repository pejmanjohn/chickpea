export type ConnectorCategory = 'project' | 'dev' | 'data' | 'search' | 'docs' | 'business';

interface ConnectorPresetCommon {
  id: string; // also seeds the connection id; MUST match /^[a-z0-9][a-z0-9-]{0,63}$/
  name: string;
  category: ConnectorCategory;
  accent: string; // hex color for the monogram chip, e.g. '#5E6AD2'
  tokenDocsUrl?: string;
  tokenDocsHint?: string;
  notes?: string;
}

interface McpPresetLane {
  url: string;
  transport: 'streamable-http';
  auth:
    | { kind: 'none' }
    | { kind: 'oauth'; scope?: string }
    | { kind: 'bearer'; placeholder: string }
    | { kind: 'header'; headerName: string; valuePrefix?: string; placeholder: string };
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
  };
}

export type ConnectorPreset = ConnectorPresetCommon &
  (
    | McpPresetLane
    | (ApiPresetLane & { url?: never; transport?: never; auth?: never })
    | (McpPresetLane & ApiPresetLane)
  );

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: 'linear',
    name: 'Linear',
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
    name: 'Notion',
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
    category: 'dev',
    accent: '#362D59',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'streamable-http',
    auth: {
      kind: 'header',
      headerName: 'Authorization',
      valuePrefix: 'Sentry-Bearer ',
      placeholder: 'User Auth Token',
    },
    tokenDocsUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    tokenDocsHint: 'Sentry → Settings → Account → User Auth Tokens',
    notes: 'Uses a non-standard Sentry-Bearer authorization scheme.',
  },
  {
    id: 'stripe',
    name: 'Stripe',
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
    id: 'cloudflare-docs',
    name: 'Cloudflare Docs',
    category: 'dev',
    accent: '#F38020',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'none' },
  },
  {
    id: 'cloudflare-bindings',
    name: 'Cloudflare Bindings',
    category: 'dev',
    accent: '#F38020',
    url: 'https://bindings.mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Cloudflare API token' },
    tokenDocsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    tokenDocsHint: 'Cloudflare → My Profile → API Tokens',
  },
  {
    id: 'cloudflare-observability',
    name: 'Cloudflare Observability',
    category: 'dev',
    accent: '#F38020',
    url: 'https://observability.mcp.cloudflare.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Cloudflare API token' },
    tokenDocsUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    tokenDocsHint: 'Cloudflare → My Profile → API Tokens',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'data',
    accent: '#3ECF8E',
    url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'sbp_…' },
    tokenDocsUrl: 'https://supabase.com/dashboard/account/tokens',
    tokenDocsHint: 'Supabase → Account → Access Tokens',
    notes: 'Append ?read_only=true to the URL (Advanced) to limit to reads.',
  },
  {
    id: 'neon',
    name: 'Neon',
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
    category: 'project',
    accent: '#FF3D57',
    url: 'https://mcp.monday.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'monday.com API token' },
    tokenDocsUrl: 'https://developer.monday.com/api-reference/docs/authentication',
    tokenDocsHint: 'monday.com → avatar → Developers → My access tokens',
  },
  {
    id: 'intercom',
    name: 'Intercom',
    category: 'business',
    accent: '#1F8DED',
    url: 'https://mcp.intercom.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'bearer', placeholder: 'Intercom access token' },
    tokenDocsUrl:
      'https://developers.intercom.com/docs/build-an-integration/learn-more/authentication',
    tokenDocsHint: 'Intercom → Settings → Developers',
    notes: 'US-hosted workspaces only.',
  },
  {
    id: 'exa',
    name: 'Exa',
    category: 'search',
    accent: '#1F40FF',
    url: 'https://mcp.exa.ai/mcp',
    transport: 'streamable-http',
    auth: { kind: 'header', headerName: 'x-api-key', placeholder: 'Exa API key' },
    tokenDocsUrl: 'https://dashboard.exa.ai/api-keys',
    tokenDocsHint: 'Exa → Dashboard → API keys',
    notes: 'Also works without a key at lower limits.',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
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
    id: 'incident-io',
    name: 'incident.io',
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
    id: 'asana',
    name: 'Asana',
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

export function presetLanes(preset: ConnectorPreset): { mcp: boolean; api: boolean } {
  return {
    mcp: 'url' in preset && typeof preset.url === 'string',
    api: 'api' in preset && preset.api !== undefined,
  };
}

export function getConnectorPreset(id: string): ConnectorPreset | undefined {
  return CONNECTOR_PRESETS.find((preset) => preset.id === id);
}
