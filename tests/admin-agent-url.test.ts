import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legacyAgentAdminRedirect } from '../src/admin/agent-url.ts';

test('old Configure URLs preserve the named Agent, tab, and unrelated query values', () => {
  assert.equal(legacyAgentAdminRedirect('https://admin.test/admin?agent=agent_other&tab=memory&oauth=success&channel=C1&x=1&x=2'),
    '/admin/agents/agent_other?tab=memory&oauth=success&channel=C1&x=1&x=2');
  assert.equal(legacyAgentAdminRedirect('https://admin.test/admin/?agent=a%2Fb'), '/admin/agents/a%2Fb');
  assert.equal(legacyAgentAdminRedirect('https://admin.test/admin?agent='), undefined);
  assert.equal(legacyAgentAdminRedirect('https://admin.test/admin/agents/agent_right?agent=agent_wrong'), undefined);
  assert.equal(legacyAgentAdminRedirect('https://admin.test/admin/usage?agent=agent_filter'), undefined);
});
