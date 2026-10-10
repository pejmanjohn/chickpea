import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InstallationContextError, scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  type AgentSlackAppsHost,
  agentSlackAppHandoffOf,
  agentSlackAppsHost,
  configureAgentSlackApps,
  withAgentSlackAppHandoff,
} from '../src/slack/agent-apps/host.ts';

const HOSTED = { CHICKPEA_TENANCY: 'installation' };
const ENV = scopeInstallationEnv(HOSTED, { installationId: 'inst_tenant_a' });
const DELIVERY = { kind: 'delivery', agentId: 'agent_support', appId: 'A0C8APP', signingSecret: 'secret' } as const;
const OWNER = { kind: 'owner', slackUserId: 'UOWNER' } as const;

test('the port is absent until a host installs it, and gone again when it is removed', () => {
  assert.equal(agentSlackAppsHost(), undefined);
  const host: AgentSlackAppsHost = {
    requestUrls: (installationId, appId) => ({
      events: `https://host/${installationId}/${appId}/events`,
      interactions: `https://host/${installationId}/${appId}/interactions`,
    }),
    redirectUri: 'https://host/slack/agent-apps/callback',
    allowUrl: (agentId) => `https://host/slack/agent-apps/allow/${agentId}`,
  };
  configureAgentSlackApps(host);
  assert.equal(agentSlackAppsHost(), host);
  configureAgentSlackApps(undefined);
  assert.equal(agentSlackAppsHost(), undefined);
});

test('a handoff rides only on an installation env, well formed, once, and never as a variable', () => {
  assert.throws(() => withAgentSlackAppHandoff({}, DELIVERY), (error: unknown) =>
    error instanceof InstallationContextError && error.code === 'installation_context_invalid');
  assert.throws(() => withAgentSlackAppHandoff(HOSTED, { ...DELIVERY, appId: 'not-an-app' }), InstallationContextError);
  assert.throws(() => withAgentSlackAppHandoff(HOSTED, { ...DELIVERY, signingSecret: ' ' }), InstallationContextError);
  assert.throws(() => withAgentSlackAppHandoff(HOSTED, { ...DELIVERY, agentId: '' }), InstallationContextError);
  assert.throws(() => withAgentSlackAppHandoff(HOSTED, { ...OWNER, slackUserId: 'owner' }), InstallationContextError);
  assert.throws(() => withAgentSlackAppHandoff(HOSTED, { kind: 'other' } as never), InstallationContextError);

  const delivery = withAgentSlackAppHandoff(ENV, DELIVERY);
  assert.deepEqual(agentSlackAppHandoffOf(delivery), DELIVERY);
  assert.equal(Object.isFrozen(delivery), true);
  assert.deepEqual(Object.keys(delivery).sort(), Object.keys(ENV).sort(), 'the handoff is no env variable');
  assert.equal(JSON.stringify(delivery).includes('secret'), false, 'the secret never serializes');
  assert.equal(agentSlackAppHandoffOf(ENV), undefined, 'the input is unchanged');
  assert.throws(() => withAgentSlackAppHandoff(delivery, OWNER), (error: unknown) =>
    error instanceof InstallationContextError && error.code === 'installation_context_mismatch');

  const owner = withAgentSlackAppHandoff(ENV, OWNER);
  assert.deepEqual(agentSlackAppHandoffOf(owner), OWNER);
});
