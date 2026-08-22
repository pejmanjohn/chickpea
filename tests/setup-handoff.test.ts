import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
  safeSetupDestination,
  safeSlackLoginDestination,
  slackManualSetupClientScript,
  slackSetupClientScript,
} from '../src/auth/setup-handoff.ts';

const CAPABILITY = '9d'.repeat(32);

test('Slack setup accepts only same-origin Admin destinations', () => {
  assert.equal(safeSetupDestination('/admin/channels'), '/admin/channels');
  assert.equal(safeSetupDestination('/admin/api/secrets'), '/admin');
  assert.equal(safeSetupDestination('/admin/api'), '/admin');
  assert.equal(safeSetupDestination('/admin/../logout'), '/admin');
  assert.equal(safeSetupDestination('/admin/%2e%2e/logout'), '/admin');
  assert.equal(safeSetupDestination('/admin/channels?next=/logout'), '/admin');
  assert.equal(safeSetupDestination('//attacker.example/admin'), '/admin');
  assert.equal(safeSetupDestination('https://attacker.example/admin'), '/admin');
});

test('Slack login accepts only Admin pages or an opaque MCP continuation', () => {
  const continuation = 'A'.repeat(43);
  assert.equal(
    safeSlackLoginDestination(`/auth/mcp/resume/${continuation}`),
    `/auth/mcp/resume/${continuation}`,
  );
  assert.equal(safeSlackLoginDestination('/admin/team'), '/admin/team');
  assert.equal(
    safeSlackLoginDestination('/admin/agents/agent_support/connections/new/gmail/member'),
    '/admin/agents/agent_support/connections/new/gmail/member',
  );
  assert.equal(safeSlackLoginDestination('/auth/mcp/resume/short'), '/admin');
  assert.equal(
    safeSlackLoginDestination(`/auth/mcp/resume/${continuation}?next=https://attacker.example`),
    '/admin',
  );
  assert.equal(safeSlackLoginDestination('/auth/mcp/consent'), '/admin');
});

test('manual setup navigation is same-tab, local, and never persists secrets', () => {
  const script = slackManualSetupClientScript();
  assert.match(script, /data-manual-step-target/);
  assert.match(script, /data-manual-step-panel/);
  assert.match(script, /hidden/);
  assert.match(script, /history\.replaceState/);
  assert.doesNotMatch(script, /localStorage|indexedDB|clientSecret|signingSecret|observedManifest/);
});

test('Slack setup client preserves the private fragment for resumable same-tab requests', () => {
  assert.doesNotMatch(slackSetupClientScript(), /password/i);
  assert.match(slackSetupClientScript(), /chickpea\.slack-setup\.v1/);
  assert.match(slackSetupClientScript(), /history\.replaceState/);
  assert.match(slackSetupClientScript(), /slack-setup-open-form/);
  assert.match(slackSetupClientScript(), /requestSubmit/);
  assert.match(slackSetupClientScript(), /data-slack-setup-auto-resume/);
  assert.match(slackSetupClientScript(), /ambiguous_external_effect/);
  assert.match(slackSetupClientScript(), /Inspect your Slack apps/i);
});

test('Slack setup refresh submits the private resume form exactly once from same-tab storage', () => {
  const fields = [{ value: '' }, { value: '' }];
  const status = { textContent: '' };
  let submissions = 0;
  const openForm = { requestSubmit() { submissions += 1; } };
  const stored = new Map([['chickpea.slack-setup.v1', CAPABILITY]]);
  vm.runInNewContext(slackSetupClientScript(), {
    URLSearchParams,
    document: {
      documentElement: {
        getAttribute(name: string) {
          if (name === 'data-slack-setup-state') return 'capability_required';
          if (name === 'data-slack-setup-auto-resume') return 'true';
          return null;
        },
      },
      querySelectorAll() { return fields; },
      getElementById(id: string) {
        if (id === 'slack-setup-status') return status;
        if (id === 'slack-setup-open-form') return openForm;
        return null;
      },
    },
    history: { replaceState() {} },
    location: { hash: '', pathname: '/admin/setup', search: '?destination=/admin/channels' },
    sessionStorage: {
      getItem(key: string) { return stored.get(key) ?? null; },
      setItem(key: string, value: string) { stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  });
  assert.deepEqual(fields.map((field) => field.value), [CAPABILITY, CAPABILITY]);
  assert.equal(submissions, 1);
  assert.match(status.textContent, /Resuming your saved Slack setup/i);
});
