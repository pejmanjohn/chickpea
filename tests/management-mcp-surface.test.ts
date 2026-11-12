import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adminSettingsLinks } from '../src/management/admin-links.ts';
import { WORKSPACE_MANAGEMENT_INSTRUCTIONS } from '../src/management/instructions.ts';
import { workspaceManagementToolDescription } from '../src/management/tool-adapter.ts';

test('the Slack door keeps its own tool descriptions', () => {
  // Chickpea still shows presentation.slack and derives the DM from the origin.
  assert.match(workspaceManagementToolDescription('propose_workspace_changes'), /Introduce presentation\.slack in a sentence or two, show it verbatim/);
  assert.match(workspaceManagementToolDescription('inspect_routines'), /In a DM, omit channelId/);
  assert.match(workspaceManagementToolDescription('prepare_connector_setup'), /agentId may be omitted/);
});

test('the instructions name no Admin link; get_workspace leaves out the Settings sections a hosted Admin hides', () => {
  assert.doesNotMatch(WORKSPACE_MANAGEMENT_INSTRUCTIONS, /\/admin|https?:/);
  const hosted = { CHICKPEA_TENANCY: 'installation' };
  const base = 'https://chickpea.example.test';
  for (const section of ['sandbox', 'browser'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section), { admin: `${base}/admin/settings/${section}` }, `standalone ${section}`);
    assert.equal(adminSettingsLinks(base, section, hosted), undefined, `hosted ${section}`);
  }
  for (const section of ['providers', 'github', 'connectors'] as const) {
    assert.deepEqual(adminSettingsLinks(base, section, hosted), { admin: `${base}/admin/settings/${section}` }, `hosted ${section}`);
  }
});
