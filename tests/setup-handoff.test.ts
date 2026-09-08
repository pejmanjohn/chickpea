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
    safeSlackLoginDestination('/setup/setup_connector_123'),
    '/setup/setup_connector_123',
  );
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
  assert.doesNotMatch(script, /events: true/);
  assert.match(script, /hidden/);
  assert.match(script, /history\.replaceState/);
  assert.doesNotMatch(script, /localStorage|indexedDB|clientSecret|signingSecret|observedManifest/);
});

test('Slack setup client preserves the private fragment for resumable same-tab requests', () => {
  assert.doesNotMatch(slackSetupClientScript(), /password/i);
  assert.match(slackSetupClientScript(), /chickpea\.slack-setup\.v1/);
  assert.match(slackSetupClientScript(), /history\.replaceState/);
  assert.match(slackSetupClientScript(), /slack-setup-status/);
  assert.match(slackSetupClientScript(), /ambiguous_external_effect/);
  assert.match(slackSetupClientScript(), /Inspect your Slack apps/i);
  // The server now renders the real stage, so nothing auto-submits on arrival.
  assert.doesNotMatch(slackSetupClientScript(), /requestSubmit|data-slack-setup-auto-resume/);
});

test('Slack setup fills every capability field from same-tab storage without submitting', () => {
  const fields = [{ value: '' }, { value: '' }];
  const status = { textContent: '', hidden: true };
  const stored = new Map([['chickpea.slack-setup.v1', CAPABILITY]]);
  vm.runInNewContext(slackSetupClientScript(), {
    URLSearchParams,
    document: {
      documentElement: {
        getAttribute(name: string) {
          if (name === 'data-slack-setup-state') return 'awaiting_app_creation';
          return null;
        },
      },
      querySelectorAll() { return fields; },
      getElementById(id: string) {
        return id === 'slack-setup-status' ? status : null;
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
  assert.equal(status.textContent, '');
  assert.equal(status.hidden, true);
});

test('a missing capability announces the expired link and blocks every empty submission', () => {
  let prevented = 0;
  const submitHandlers: Array<(event: { preventDefault(): void }) => void> = [];
  const button = { disabled: false };
  const form = {
    addEventListener(type: string, handler: (event: { preventDefault(): void }) => void) {
      if (type === 'submit') submitHandlers.push(handler);
    },
    querySelectorAll() { return [button]; },
  };
  const fields = [{ value: 'stale', form }, { value: 'stale', form }];
  const status = { textContent: '', hidden: true };
  vm.runInNewContext(slackSetupClientScript(), {
    URLSearchParams,
    document: {
      documentElement: { getAttribute() { return 'awaiting_app_creation'; } },
      querySelectorAll() { return fields; },
      getElementById(id: string) {
        return id === 'slack-setup-status' ? status : null;
      },
    },
    history: { replaceState() {} },
    location: { hash: '', pathname: '/admin/setup', search: '' },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
  });
  assert.deepEqual(fields.map((field) => field.value), ['', '']);
  assert.match(status.textContent, /missing or expired/i);
  assert.equal(status.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(submitHandlers.length, 1, 'each form is guarded exactly once');
  submitHandlers[0]!({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
});
