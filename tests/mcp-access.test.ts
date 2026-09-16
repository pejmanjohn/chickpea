import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedToolsAfterMcpDiscovery, isMcpToolReviewRequired } from '../src/config/mcp-access.ts';
import type { McpConnectionToolInfo } from '../src/config/types.ts';
const tool = (name: string, fingerprint = 'a'.repeat(64)): McpConnectionToolInfo => ({ name,
  inputSchema: { propertyNames: ['account_id'], accountFields: [{ name: 'account_id', type: 'string', required: true }], ambiguous: false, fingerprint },
});
test('review mode keeps empty access empty on initial discovery and reconnect', () => {
  for (const prior of [[], [tool('report')]]) {
    assert.deepEqual(allowedToolsAfterMcpDiscovery({ presetId: 'meta-ads', allowedTools: [], discoveredTools: prior }, [tool('report')]), []);
  }
  assert.equal(isMcpToolReviewRequired({ url: 'https://mcp.facebook.com/ads' }), true);
});
test('reviewed rediscovery narrows grants when tools disappear or schemas change', () => {
  assert.deepEqual(allowedToolsAfterMcpDiscovery({ toolAccessMode: 'review', allowedTools: ['stable', 'changed', 'removed'],
    discoveredTools: [tool('stable'), tool('changed'), tool('removed')] }, [tool('stable'), tool('changed', 'b'.repeat(64)), tool('new')]), ['stable']);
});
test('legacy automatic presets retain first-discovery behavior', () => {
  assert.deepEqual(allowedToolsAfterMcpDiscovery({ allowedTools: [], discoveredTools: [] }, [tool('report')]), ['report']);
  assert.deepEqual(allowedToolsAfterMcpDiscovery({ allowedTools: [], discoveredTools: [tool('report')] }, [tool('report')]), []);
});
