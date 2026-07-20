import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMcpUrl } from '../src/config/mcp-url.ts';
import { CONNECTOR_PRESETS, getConnectorPreset } from '../src/config/presets.ts';

test('connector preset catalog entries are valid', () => {
  const ids = CONNECTOR_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const preset of CONNECTOR_PRESETS) {
    assert.match(preset.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.equal(validateMcpUrl(preset.url).ok, true, `${preset.id} has an invalid MCP URL`);
    assert.equal(preset.transport, 'streamable-http');

    if (preset.auth.kind === 'header') {
      assert.match(preset.auth.headerName, /^[A-Za-z0-9-]{1,128}$/);
      assert.ok(preset.auth.placeholder.length > 0);
    }

    if (preset.auth.kind === 'bearer') {
      assert.ok(preset.auth.placeholder.length > 0);
    }
  }
});

test('getConnectorPreset looks up known ids', () => {
  assert.equal(getConnectorPreset('linear'), CONNECTOR_PRESETS[0]);
  assert.equal(getConnectorPreset('unknown'), undefined);
});
