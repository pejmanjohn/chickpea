import assert from 'node:assert/strict';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import {
  GATEWAY_BINDING_SETTING,
  GATEWAY_CLAIM_SETTING,
  GatewayDeploymentClient,
} from '../src/slack/gateway/client.ts';
import { GATEWAY_DEPLOYMENT_IDENTITY_SETTING } from '../src/slack/gateway/identity.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';

const gatewayBaseUrl = process.env.CHICKPEA_GATEWAY_BASE_URL
  ?? 'https://chickpea-slack-gateway.pejmanjohn.workers.dev';
const settings = new SqliteSettingsStore(':memory:');
const config = new SqliteConfigStore(':memory:');
const client = new GatewayDeploymentClient({
  settings,
  config,
  keyring: generateCredentialKeyring(`live_gateway_${crypto.randomUUID()}`),
  gatewayBaseUrl,
});

try {
  const health = await fetch(new URL('/', gatewayBaseUrl));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    service: 'chickpea-slack-gateway',
    protocolVersion: 1,
  });

  let claim;
  try {
    claim = await client.beginClaim();
  } catch (error) {
    if (!(error instanceof SlackTransportError) || error.code !== 'gateway_not_configured') {
      throw error;
    }
    assert.equal(await settings.getSetting(GATEWAY_BINDING_SETTING), undefined);
    assert.equal(await settings.getSetting(GATEWAY_CLAIM_SETTING), undefined);
    const storedIdentity = await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING);
    assert.ok(storedIdentity);
    assert.doesNotMatch(storedIdentity, /"d"\s*:/);
    assert.doesNotMatch(storedIdentity, /xox[baprs]-/i);
    console.log(JSON.stringify({
      ok: true,
      gatewayBaseUrl,
      claimState: 'blocked_until_shared_app_configuration',
      deploymentPrivateKeyEncrypted: true,
      slackCredentialsStoredByDeployment: false,
    }));
    process.exitCode = 0;
    claim = undefined;
  }
  if (claim) {
    assert.match(claim.claimId, /^claim_[A-Za-z0-9_-]+$/);
    assert.equal(new URL(claim.authorizationUrl).origin, new URL(gatewayBaseUrl).origin);
    assert.ok(claim.expiresAt > Date.now());

    const status = await client.refreshClaim();
    assert.equal(status.claimId, claim.claimId);
    assert.equal(status.state, 'pending');
    assert.equal(await settings.getSetting(GATEWAY_BINDING_SETTING), undefined);
    assert.ok(await settings.getSetting(GATEWAY_CLAIM_SETTING));

    const storedIdentity = await settings.getSetting(GATEWAY_DEPLOYMENT_IDENTITY_SETTING);
    assert.ok(storedIdentity);
    assert.doesNotMatch(storedIdentity, /"d"\s*:/);
    assert.doesNotMatch(storedIdentity, /xox[baprs]-/i);

    console.log(JSON.stringify({
      ok: true,
      gatewayBaseUrl,
      claimState: status.state,
      deploymentPrivateKeyEncrypted: true,
      slackCredentialsStoredByDeployment: false,
    }));
  }
} finally {
  settings.close();
  config.close();
}
