import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMcpUrl } from '../src/config/mcp-url.ts';
import {
  CONNECTOR_PRESETS,
  getConnectorPreset,
  presetLanes,
  type ConnectorPreset,
} from '../src/config/presets.ts';

const API_PRESET_IDS = new Set(['asana', 'zendesk']);
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
      assert.ok(api.placeholder.length > 0);
    }
  }
});

test('preset lanes classify the existing MCP catalog, the API additions, and both', () => {
  const existingMcpPresets = CONNECTOR_PRESETS.filter((preset) => !API_PRESET_IDS.has(preset.id));
  assert.equal(existingMcpPresets.length, 21);
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

test('the Linear MCP preset uses its server-enforced read-only OAuth endpoint', () => {
  assert.deepEqual(getConnectorPreset('linear'), {
    id: 'linear',
    name: 'Linear',
    category: 'project',
    accent: '#5E6AD2',
    url: 'https://mcp.linear.app/mcp/readonly',
    transport: 'streamable-http',
    auth: { kind: 'oauth', scope: 'read' },
    tokenDocsUrl: 'https://linear.app/docs/mcp',
    tokenDocsHint: 'Sign in to Linear and choose the workspace Chickpea should access.',
    notes:
      'Chickpea uses Linear\'s server-enforced read-only MCP endpoint and requests only the read scope.',
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
