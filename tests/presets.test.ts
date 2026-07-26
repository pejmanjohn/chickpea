import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMcpUrl } from '../src/config/mcp-url.ts';
import {
  CONNECTOR_PRESETS,
  GOOGLE_WORKSPACE_SERVICE_PRESETS,
  getConnectorPreset,
  presetLanes,
  type ConnectorPreset,
} from '../src/config/presets.ts';

const API_PRESET_IDS = new Set(['google-workspace', 'asana', 'zendesk']);
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

function isAllowedConnectorHost(host: string): boolean {
  if (host.includes('*')) return false;
  const result = validateMcpUrl(`https://${host}`);
  if (!result.ok) return false;
  const url = new URL(result.url);
  return (
    url.hostname.toLowerCase() === host.toLowerCase() &&
    url.port === '' &&
    url.pathname === '/' &&
    url.search === ''
  );
}

test('connector preset catalog entries are valid', () => {
  const ids = CONNECTOR_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const preset of CONNECTOR_PRESETS) {
    assert.match(preset.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(preset.name.trim().length > 0 && preset.name.length <= 80);
    const lanes = presetLanes(preset);
    assert.ok(lanes.mcp || lanes.api, `${preset.id} has no connector lane`);

    if (lanes.mcp) {
      assert.ok('url' in preset && typeof preset.url === 'string');
      assert.ok('transport' in preset && preset.transport === 'streamable-http');
      assert.ok('auth' in preset);
      assert.equal(validateMcpUrl(preset.url).ok, true, `${preset.id} has an invalid MCP URL`);

      if (preset.auth.kind === 'header') {
        assert.match(preset.auth.headerName, /^[A-Za-z0-9-]{1,128}$/);
        assert.ok(preset.auth.placeholder.length > 0);
      }

      if (preset.auth.kind === 'bearer') {
        assert.ok(preset.auth.placeholder.length > 0);
      }
    }

    if (lanes.api) {
      assert.ok('api' in preset && preset.api);
      const api = preset.api;
      assert.ok(api.hosts.length > 0 && api.hosts.length <= 20);
      for (const host of api.hosts) {
        assert.ok(host.length <= 253);
        assert.equal(isAllowedConnectorHost(host), true, `${preset.id} has an invalid API host`);
      }
      assert.match(api.headerName, /^[A-Za-z0-9-]{1,128}$/);
      assert.ok((api.pathPrefixes ?? []).length <= 20);
      for (const prefix of api.pathPrefixes ?? []) {
        assert.match(prefix, /^\/[^\s?#]*$/);
        assert.ok(prefix.length <= 512);
      }
      assert.ok(api.methods.length > 0);
      assert.ok(api.methods.every((method) => API_METHODS.has(method)));
      assert.equal(new Set(api.methods).size, api.methods.length);
      if (!api.oauth) assert.ok(api.placeholder.length > 0);
    }
  }
});

test('preset lanes classify the existing MCP catalog, the API additions, and both', () => {
  const existingMcpPresets = CONNECTOR_PRESETS.filter((preset) => !API_PRESET_IDS.has(preset.id));
  assert.equal(existingMcpPresets.length, 20);
  for (const preset of existingMcpPresets) {
    assert.deepEqual(presetLanes(preset), { mcp: true, api: false }, preset.id);
  }

  for (const id of API_PRESET_IDS) {
    const preset = getConnectorPreset(id);
    assert.ok(preset);
    assert.deepEqual(presetLanes(preset), { mcp: false, api: true }, id);
  }

  const both = {
    id: 'both-test',
    name: 'Both Test',
    category: 'dev',
    accent: '#123456',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    auth: { kind: 'none' },
    api: {
      hosts: ['api.example.com'],
      headerName: 'Authorization',
      methods: ['GET'],
      placeholder: 'API token',
    },
  } satisfies ConnectorPreset;
  assert.deepEqual(presetLanes(both), { mcp: true, api: true });
});

test('the Notion MCP preset keeps the official OAuth-only hosted-server shape', () => {
  assert.deepEqual(getConnectorPreset('notion'), {
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
  });
});

test('the Linear MCP preset requests read-write OAuth access', () => {
  assert.deepEqual(getConnectorPreset('linear'), {
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
  });
});

test('the Airtable MCP preset requests the documented read-write OAuth scopes', () => {
  assert.deepEqual(getConnectorPreset('airtable'), {
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
  });
});

test('the PostHog MCP preset uses the provider-recommended OAuth flow', () => {
  assert.deepEqual(getConnectorPreset('posthog'), {
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
  });
});

test('the Supabase MCP preset requests every currently required OAuth scope', () => {
  assert.deepEqual(getConnectorPreset('supabase'), {
    id: 'supabase',
    name: 'Supabase',
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
  });
});

test('the Cloudflare API preset uses the token-efficient full API OAuth server', () => {
  assert.deepEqual(getConnectorPreset('cloudflare-api'), {
    id: 'cloudflare-api',
    name: 'Cloudflare API',
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
  });
  assert.equal(getConnectorPreset('cloudflare-docs'), undefined);
  assert.equal(getConnectorPreset('cloudflare-bindings'), undefined);
  assert.equal(getConnectorPreset('cloudflare-observability'), undefined);
});

test('the Google Workspace API preset starts with read-only service policy', () => {
  assert.deepEqual(getConnectorPreset('google-workspace'), {
    id: 'google-workspace',
    name: 'Google Workspace',
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
  });
});

test('Google services are separate catalog entries backed by one shared OAuth connection', () => {
  assert.deepEqual(GOOGLE_WORKSPACE_SERVICE_PRESETS, [
    {
      id: 'gmail',
      service: 'gmail',
      connectionPresetId: 'google-workspace',
      name: 'Gmail',
      description: 'Search mail, summarize threads, and draft or organize messages.',
      accent: '#EA4335',
    },
    {
      id: 'google-calendar',
      service: 'calendar',
      connectionPresetId: 'google-workspace',
      name: 'Google Calendar',
      description: 'Review availability and create or update events.',
      accent: '#4285F4',
    },
    {
      id: 'google-drive',
      service: 'drive',
      connectionPresetId: 'google-workspace',
      name: 'Google Drive',
      description: 'Find, read, create, and organize files.',
      accent: '#4285F4',
    },
  ]);
});

test('the Atlassian MCP preset requests the advertised read-write OAuth scopes', () => {
  assert.deepEqual(getConnectorPreset('atlassian'), {
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
  });
});

test('the Asana and Zendesk API presets keep their locked shapes', () => {
  assert.deepEqual(getConnectorPreset('asana'), {
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
  });
  assert.deepEqual(getConnectorPreset('zendesk'), {
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
  });
});

test('getConnectorPreset looks up known ids', () => {
  assert.equal(getConnectorPreset('linear'), CONNECTOR_PRESETS[0]);
  assert.equal(getConnectorPreset('github'), undefined);
  assert.equal(getConnectorPreset('unknown'), undefined);
});
