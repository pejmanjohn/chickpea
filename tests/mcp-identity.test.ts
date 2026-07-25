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
    { ...notionInput, presetId: 'linear' },
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
