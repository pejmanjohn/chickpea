import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REQUIRED_SLACK_BOT_SCOPES } from '../src/slack/scopes.ts';
import { evaluateSlackInstallationHealth } from '../src/slack/transport/types.ts';

test('complete manifest grants produce healthy installation state', () => {
  assert.deepEqual(evaluateSlackInstallationHealth(REQUIRED_SLACK_BOT_SCOPES), {
    status: 'healthy',
    missingScopes: [],
  });
});

test('missing grants produce an actionable reinstall state before feature use', () => {
  const granted = REQUIRED_SLACK_BOT_SCOPES.filter(
    (scope) => scope !== 'usergroups:write' && scope !== 'chat:write.customize',
  );
  assert.deepEqual(evaluateSlackInstallationHealth(granted, { appId: 'A123' }), {
    status: 'needs_reauthorization',
    missingScopes: ['chat:write.customize', 'usergroups:write'],
    action: {
      kind: 'reinstall',
      label: 'Reinstall Chickpea in Slack',
      url: 'https://api.slack.com/apps/A123/oauth',
    },
    detail: 'Reinstall Chickpea in Slack to grant: chat:write.customize, usergroups:write.',
  });
});

test('omitted Slack scope evidence is explicitly unverifiable', () => {
  assert.deepEqual(evaluateSlackInstallationHealth(undefined), {
    status: 'unverifiable',
    missingScopes: [],
    detail: 'Slack did not return the installed permission scopes.',
  });
});
