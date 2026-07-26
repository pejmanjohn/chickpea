import assert from 'node:assert/strict';
import { test } from 'node:test';

import { discoverMcpConnectionIdentity } from '../src/config/mcp-identity.ts';

const notionInput = {
  id: 'notion',
  url: 'https://mcp.notion.com/mcp',
  transport: 'streamable-http' as const,
  headers: { Authorization: 'Bearer secret-not-for-profile' },
  presetId: 'notion',
};

test('Notion identity discovery keeps bounded workspace and account labels only', async () => {
  const identity = await discoverMcpConnectionIdentity(notionInput, async (input) => {
    assert.equal(input, notionInput);
    return {
      self: {
        workspace: { id: 'workspace-secret-id', name: "  Pejman   Pour-Moezzi's Notion  " },
        user: {
          id: 'user-secret-id',
          name: 'Pejman Pour-Moezzi',
          email: 'must-not-enter-profile@example.com',
        },
        current_tool_access: { notion_search: { status: 'available' } },
      },
    };
  });

  assert.deepEqual(identity, {
    workspaceName: "Pejman Pour-Moezzi's Notion",
    accountName: 'Pejman Pour-Moezzi',
  });
  assert.doesNotMatch(JSON.stringify(identity), /secret-id|example\.com|Authorization/);
});

test('identity discovery is provider-gated and tolerates an absent self payload', async () => {
  let calls = 0;
  const unknown = await discoverMcpConnectionIdentity(
    { ...notionInput, presetId: 'unknown-provider' },
    async () => {
      calls += 1;
      return {};
    },
  );
  assert.equal(unknown, undefined);
  assert.equal(calls, 0);

  const missing = await discoverMcpConnectionIdentity(notionInput, async () => ({ self: {} }));
  assert.equal(missing, undefined);
});

test('Linear identity discovery requests the current user and stores only a bounded display name', async () => {
  const input = {
    ...notionInput,
    id: 'linear',
    url: 'https://mcp.linear.app/mcp',
    presetId: 'linear',
  };
  const identity = await discoverMcpConnectionIdentity(input, async (received, probe) => {
    assert.equal(received, input);
    assert.deepEqual(probe, { name: 'get_user', arguments: { query: 'me' } });
    return {
      id: 'user-secret-id',
      name: 'Fallback Name',
      displayName: '  Pejman   Pour-Moezzi  ',
      email: 'must-not-enter-profile@example.com',
      teams: [{ id: 'team-secret-id', name: 'Chickpea', key: 'CHI' }],
    };
  });

  assert.deepEqual(identity, { accountName: 'Pejman Pour-Moezzi' });
  assert.doesNotMatch(JSON.stringify(identity), /secret-id|example\.com|Chickpea|CHI/);
});

test('Airtable identity discovery summarizes accessible workspaces without retaining ids', async () => {
  const input = {
    ...notionInput,
    id: 'airtable',
    url: 'https://mcp.airtable.com/mcp',
    presetId: 'airtable',
  };
  const oneWorkspace = await discoverMcpConnectionIdentity(input, async (_received, probe) => {
    assert.deepEqual(probe, { name: 'list_workspaces', arguments: {} });
    return {
      structuredContent: {
        workspaces: [{ id: 'workspace-secret-id', name: '  Product   Ops ', permissionLevel: 'owner' }],
      },
    };
  });
  assert.deepEqual(oneWorkspace, { workspaceName: 'Product Ops' });

  const severalWorkspaces = await discoverMcpConnectionIdentity(input, async () => ({
    structuredContent: {
      workspaces: [
        { id: 'one', name: 'First', permissionLevel: 'owner' },
        { id: 'two', name: 'Second', permissionLevel: 'editor' },
        { id: 'three', name: 'Third', permissionLevel: 'viewer' },
      ],
    },
  }));
  assert.deepEqual(severalWorkspaces, { workspaceName: '3 accessible workspaces' });
  assert.doesNotMatch(JSON.stringify(severalWorkspaces), /First|Second|Third|owner|editor|viewer/);
});

test('Granola identity discovery keeps only the connected email and active workspace label', async () => {
  const input = {
    ...notionInput,
    id: 'granola',
    url: 'https://mcp.granola.ai/mcp',
    presetId: 'granola',
  };
  const identity = await discoverMcpConnectionIdentity(input, async (received, probe) => {
    assert.equal(received, input);
    assert.deepEqual(probe, { name: 'get_account_info', arguments: {} });
    return {
      structuredContent: {
        email: '  pejman@example.com  ',
        active_workspace: {
          id: 'workspace-secret-id',
          name: '  Magoosh   Leadership  ',
        },
        access_token: 'must-not-enter-profile',
      },
    };
  });

  assert.deepEqual(identity, {
    workspaceName: 'Magoosh Leadership',
    accountName: 'pejman@example.com',
  });
  assert.doesNotMatch(JSON.stringify(identity), /secret-id|access_token|must-not-enter-profile/);
});

test('identity discovery stays provider-gated for presets without a proven probe', async () => {
  let calls = 0;
  const identity = await discoverMcpConnectionIdentity(
    { ...notionInput, presetId: 'supabase' },
    async () => {
      calls += 1;
      return {};
    },
  );
  assert.equal(identity, undefined);
  assert.equal(calls, 0);
});
