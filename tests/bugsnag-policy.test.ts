import assert from 'node:assert/strict';
import test from 'node:test';
import { BUGSNAG_MCP_SERVER_URL, compileBugsnagToolAccess } from '../src/config/bugsnag-policy.ts';
import { allowedToolsAfterMcpDiscovery, isMcpToolReviewRequired } from '../src/config/mcp-access.ts';
import { assertMcpToolArguments } from '../src/config/mcp-tool-policy.ts';
import { getConnectorPreset, resolveConnectorCatalogPreset } from '../src/config/presets.ts';
import type { McpConnectionToolInfo } from '../src/config/types.ts';

const tool = (name: string, readOnlyHint: boolean): McpConnectionToolInfo => ({
  name, readOnlyHint,
  inputSchema: { propertyNames: ['projectId', 'errorId', 'operation'], accountFields: [], ambiguous: false, fingerprint: 'a'.repeat(64) },
});

test('BugSnag uses public-client OAuth and never grants discovered tools before review', () => {
  const preset = getConnectorPreset('bugsnag')!;
  assert.equal(resolveConnectorCatalogPreset('BugSnag')?.id, 'bugsnag');
  assert.equal(preset.url, BUGSNAG_MCP_SERVER_URL);
  assert.deepEqual('auth' in preset && preset.auth, { kind: 'oauth', scope: 'api' });
  for (const identity of [{ presetId: 'bugsnag' }, { url: BUGSNAG_MCP_SERVER_URL }]) {
    assert.equal(isMcpToolReviewRequired(identity), true);
    assert.deepEqual(allowedToolsAfterMcpDiscovery({ ...identity, allowedTools: [], discoveredTools: [] },
      [tool('bugsnag_get_error', true), tool('bugsnag_update_error', false)]), []);
  }
});

test('BugSnag grants only selected discovered tools and enforces supported error operations', () => {
  const discoveredTools = [tool('bugsnag_get_error', true), tool('bugsnag_update_error', true), tool('bugsnag_set_network_endpoint_groupings', true)];
  const read = compileBugsnagToolAccess({ discoveredTools, requestedTools: ['bugsnag_get_error'] });
  assert.deepEqual(read, { allowedTools: ['bugsnag_get_error'], toolPolicies: { bugsnag_get_error: { effect: 'read' } } });
  const write = compileBugsnagToolAccess({ discoveredTools, requestedTools: ['bugsnag_update_error', 'bugsnag_set_network_endpoint_groupings'] });
  assert.equal(write.toolPolicies.bugsnag_update_error?.effect, 'write');
  assert.equal(write.toolPolicies.bugsnag_set_network_endpoint_groupings?.effect, 'write');
  const constraints = { bugsnag_update_error: write.toolPolicies.bugsnag_update_error!.argumentConstraints! };
  assert.doesNotThrow(() => assertMcpToolArguments('bugsnag_update_error', { operation: 'fix' }, constraints));
  for (const args of [{ operation: 'override_severity' }, {}, { operation: 'unknown' }]) {
    assert.throws(() => assertMcpToolArguments('bugsnag_update_error', args, constraints), /approved value/);
  }
  assert.throws(() => compileBugsnagToolAccess({ discoveredTools, requestedTools: ['invented'] }), /Reconnect/);
  assert.throws(() => compileBugsnagToolAccess({ discoveredTools: [{ name: 'bugsnag_update_error' }], requestedTools: ['bugsnag_update_error'] }), /Reconnect/);
});

test('BugSnag reconnect preserves selected schemas and leaves new tools unselected', () => {
  const stable = tool('bugsnag_get_error', true);
  const changed = tool('bugsnag_update_error', false);
  assert.deepEqual(allowedToolsAfterMcpDiscovery({ presetId: 'bugsnag',
    allowedTools: [stable.name, changed.name], discoveredTools: [stable, changed] },
  [stable, { ...changed, inputSchema: { ...changed.inputSchema!, fingerprint: 'b'.repeat(64) } }, tool('new_tool', true)]), [stable.name]);
});
