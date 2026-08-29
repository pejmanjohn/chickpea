import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { WorkspaceManagementService } from '../src/management/service.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import { SqliteManagementStore } from '../src/management/store.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const NOW = 1_800_200_000_000;
const CAPABILITY = 'c'.repeat(43);

test('the managed connector link is reusable and completes from the dedicated page', async () => {
  const identity = new SqliteIdentityStore(':memory:', { now: () => NOW });
  const owner = await createSlackOwner(identity, { now: NOW, suffix: 'connector-landing' });
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const management = new SqliteManagementStore(':memory:');
  const settings = new SqliteSettingsStore(':memory:');
  const authorizeInputs: Array<{
    principalRef: string;
    allowedCapabilities: string[];
    returnUrl?: string;
  }> = [];
  let revokeCalls = 0;
  let writeReady = true;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    availability({ accessLane }) {
      return accessLane === 'write' && !writeReady
        ? { status: 'unavailable', missingConfiguration: ['auth_config_missing'] }
        : { status: 'ready', missingConfiguration: [] };
    },
    async authorize(input) {
      authorizeInputs.push({
        principalRef: input.principalRef,
        allowedCapabilities: [...input.allowedCapabilities],
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      });
      return {
        authorizationUrl: new URL(`https://backend.composio.dev/link/${authorizeInputs.length}`),
        authorizationRef: `authorization_hubspot_${authorizeInputs.length}`,
      };
    },
    async pollAuthorization(input) {
      return {
        status: 'active',
        accountRef: input.authorizationRef,
        toolkit: 'hubspot',
      };
    },
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() { revokeCalls += 1; },
  };

  try {
    const agent = await config.createAgent({
      id: 'agent_sprout',
      name: 'Sprout',
      creatorMembershipId: owner.membership.id,
      editPolicy: 'creator_and_admins',
      lifecycle: 'active',
      configurationGeneration: 1,
      instructions: 'Help the team.',
      enabled: true,
      slackPresence: {
        requestedHandle: 'sprout',
        normalizedHandle: 'sprout',
        desiredState: 'active',
        health: 'healthy',
        avatar: {
          kind: 'generated',
          revision: 1,
          seed: 'agent_sprout',
          url: 'https://cdn.example.test/sprout.png',
        },
      },
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: owner.user.slackTeamId,
      transportMode: 'direct',
      defaultAgentId: agent.id,
    });
    const service = new WorkspaceManagementService({
      identity,
      config,
      management,
      setupBaseUrl: 'http://localhost',
      now: () => NOW,
      randomId: () => 'connector_landing',
      randomCapability: () => CAPABILITY,
    });
    const prepared = await service.prepareConnectorSetup({
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      origin: {
        kind: 'slack',
        workspaceId: owner.user.slackTeamId,
        channelId: 'D_CONNECTOR',
        threadTs: '1800200000.000100',
        agentId: agent.id,
      },
    }, {
      agentId: agent.id,
      connector: 'HubSpot',
      ownerKind: 'member',
    });
    const setupUrl = new URL(prepared.handoffUrl);
    const setupId = setupUrl.pathname.split('/').at(-1)!;
    const ownerPrincipal: AuthPrincipal = {
      userId: owner.user.id,
      membershipId: owner.membership.id,
      organizationId: owner.membership.organizationId,
      role: owner.membership.role,
      authenticatorKind: 'better_auth',
      credentialId: 'session_owner',
      correlationId: 'connector_owner',
      machine: false,
    };
    const adminPrincipal: AuthPrincipal = {
      ...ownerPrincipal,
      userId: 'user_second_admin',
      membershipId: 'membership_second_admin',
      role: 'admin',
      credentialId: 'session_second_admin',
      correlationId: 'connector_second_admin',
    };
    let principal = ownerPrincipal;
    const deliveries: string[] = [];
    const app = createManagementSetupRoutes({
      identity,
      config,
      management,
      settings,
      now: () => NOW,
      managedConnectionProviders: createManagedConnectionProviderRegistry([provider]),
      authenticatePrincipal: async () => principal,
      deliverReceipt: async (record) => {
        deliveries.push(record.outboxId);
        return { deliveryRef: 'slack:D_CONNECTOR:receipt.1' };
      },
    });

    const initial = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(initial.status, 200);
    assert.match(await initial.text(), /Checking this secure setup link/);

    const ownerExchange = await exchange(app, setupId);
    assert.equal(ownerExchange.status, 200, await ownerExchange.clone().text());
    const ownerCookie = ownerExchange.headers.get('set-cookie')!.split(';')[0]!;
    assert.match(ownerCookie, new RegExp(CAPABILITY));
    assert.equal((await management.getSetup(setupId))?.status, 'pending');
    assert.ok((await management.getSetup(setupId))?.tokenDigest);

    const setupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie: ownerCookie },
    });
    const setupHtml = await setupPage.text();
    assert.equal(setupPage.status, 200);
    assert.match(setupHtml, /Connect HubSpot to Sprout/);
    assert.match(setupHtml, /<input[^>]+name="ownerKind"[^>]+value="member"/);
    assert.match(setupHtml, /<input[^>]+name="ownerKind"[^>]+value="team"/);
    assert.doesNotMatch(setupHtml, /<input[^>]+name="ownerKind"[^>]+checked/);
    assert.match(setupHtml, /<input[^>]+name="access"[^>]+value="write"/);
    assert.match(setupHtml, /--chickpea-wordmark-image:url\("data:image\/png;base64,/);
    assert.match(setupHtml, new RegExp(`src="http://localhost/assets/agents/${agent.id}/avatar/1"`));

    writeReady = false;
    const readOnlySetupPage = await app.request(`http://localhost/setup/${setupId}`, {
      headers: { cookie: ownerCookie },
    });
    assert.equal(readOnlySetupPage.status, 200);
    assert.match(
      await readOnlySetupPage.text(),
      /<input[^>]+name="access"[^>]+value="write"[^>]+disabled/,
    );
    writeReady = true;

    const ownerAuthorize = await authorize(app, setupId, ownerCookie, {
      ownerKind: 'team',
      access: 'write',
    });
    assert.equal(ownerAuthorize.status, 200, await ownerAuthorize.clone().text());
    assert.equal((await ownerAuthorize.json()).authorizationUrl,
      'https://backend.composio.dev/link/1');

    // A second authorized person can open the same capability and start their
    // own provider flow. The first browser did not claim or lock the link.
    principal = adminPrincipal;
    const adminExchange = await exchange(app, setupId);
    assert.equal(adminExchange.status, 200, await adminExchange.clone().text());
    const adminCookie = adminExchange.headers.get('set-cookie')!.split(';')[0]!;
    const adminAuthorize = await authorize(app, setupId, adminCookie, {
      ownerKind: 'team',
      access: 'read',
    });
    assert.equal(adminAuthorize.status, 200, await adminAuthorize.clone().text());
    assert.equal(authorizeInputs.length, 2);
    assert.equal(authorizeInputs[0]!.principalRef, authorizeInputs[1]!.principalRef);
    assert.match(authorizeInputs[0]!.principalRef, /^chickpea:organization:/);
    assert.match(authorizeInputs[0]!.returnUrl ?? '', new RegExp(`/setup/${setupId}\\?poll=1$`));

    principal = ownerPrincipal;
    const poll = await app.request(`http://localhost/setup/${setupId}/managed/poll`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: ownerCookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(poll.status, 200, await poll.clone().text());
    assert.deepEqual(await poll.json(), { status: 'connected' });

    const completed = await management.getSetup(setupId);
    assert.equal(completed?.status, 'completed');
    assert.equal(completed?.completedByUserId, ownerPrincipal.userId);
    assert.equal(completed?.completedByMembershipId, ownerPrincipal.membershipId);
    assert.ok(completed?.connectionAccountId);
    assert.equal(completed?.receipt && 'kind' in completed.receipt
      ? completed.receipt.ownerKind
      : undefined, 'team');
    assert.equal(completed?.receipt && 'kind' in completed.receipt
      ? completed.receipt.accessLane
      : undefined, 'write');
    assert.equal(deliveries.length, 1);
    assert.equal((await management.getOutboxForOperation(setupId))?.status, 'delivered');
    assert.equal((await config.listConnectionAccounts(owner.user.slackTeamId)).length, 1);

    principal = adminPrincipal;
    const adminReturn = await app.request(`http://localhost/setup/${setupId}?poll=1`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(adminReturn.status, 200);
    const adminReturnHtml = await adminReturn.text();
    assert.match(adminReturnHtml, /Finishing your HubSpot connection/);
    assert.match(adminReturnHtml, new RegExp(`/setup/${setupId}/managed/poll`));
    assert.doesNotMatch(adminReturnHtml, /HubSpot is now connected to Sprout/);

    const staleAuthorize = await authorize(app, setupId, adminCookie, {
      ownerKind: 'member',
      access: 'read',
    });
    assert.equal(staleAuthorize.status, 409, await staleAuthorize.clone().text());
    const staleAuthorizeBody = await staleAuthorize.json() as { error: string };
    assert.equal(staleAuthorizeBody.error, 'managed_authorization_superseded');
    assert.equal(authorizeInputs.length, 2);

    const stalePlainForm = await app.request(`http://localhost/setup/${setupId}/authorize`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: adminCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'ownerKind=not-a-real-owner&access=not-a-real-lane',
    });
    assert.equal(stalePlainForm.status, 303);
    assert.equal(stalePlainForm.headers.get('location'), `/setup/${setupId}`);
    assert.equal(authorizeInputs.length, 2);

    const superseded = await app.request(`http://localhost/setup/${setupId}/managed/poll`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: adminCookie,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(superseded.status, 409);
    const supersededBody = await superseded.json() as { error: string; message: string };
    assert.equal(supersededBody.error, 'managed_authorization_superseded');
    assert.match(supersededBody.message, /Your sign-in was discarded/);
    assert.equal(revokeCalls, 1);

    const success = await app.request(`http://localhost/setup/${setupId}`);
    assert.equal(success.status, 200);
    const successHtml = await success.text();
    assert.match(successHtml, /HubSpot is now connected to Sprout/);
    assert.match(successHtml, /Your team, read and write connection is ready/);
    assert.match(successHtml, /You can close this tab now/);
  } finally {
    identity.close();
    config.close();
    management.close();
    settings.close();
  }
});

async function exchange(app: ReturnType<typeof createManagementSetupRoutes>, setupId: string) {
  return app.request(`http://localhost/setup/${setupId}/exchange`, {
    method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ capability: CAPABILITY }),
  });
}

async function authorize(
  app: ReturnType<typeof createManagementSetupRoutes>,
  setupId: string,
  cookie: string,
  fields: { ownerKind: 'member' | 'team'; access: 'read' | 'write' },
) {
  return app.request(`http://localhost/setup/${setupId}/authorize`, {
    method: 'POST',
    headers: {
      origin: 'http://localhost',
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-requested-with': 'chickpea-setup',
    },
    body: new URLSearchParams(fields).toString(),
  });
}
