import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { AuthPrincipal } from '../src/auth/types.ts';
import {
  describeProviderKeySources,
  resolveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { storedCredentialMetadata } from '../src/config/model-credential-refs.ts';
import { createManagementSetupRoutes } from '../src/management/setup-routes.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementToolDescription,
} from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  PrepareProviderSetupResult,
} from '../src/management/types.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60_000;
const PROVIDERS_SETTINGS_URL = 'http://localhost/admin/settings/providers';
const TEAM_URL = 'http://localhost/admin/team';

type Fixture = Awaited<ReturnType<typeof createManagementAdapterFixture>>;

function mcpContext(actor: Fixture['owner'] | Fixture['admin']): ManagementActorContext {
  return {
    userId: actor.user.id,
    membershipId: actor.membership.id,
    organizationId: actor.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'claude-code' },
  };
}

function browserPrincipal(actor: Fixture['owner']): AuthPrincipal {
  return {
    userId: actor.user.id,
    membershipId: actor.membership.id,
    organizationId: actor.membership.organizationId,
    role: actor.membership.role,
    authenticatorKind: 'better_auth',
    credentialId: `session_${actor.membership.id}`,
    correlationId: 'provider_handoff_test',
    machine: false,
  };
}

/** Invitations only mint Admins, so a member is an invited Admin the Owner demoted. */
async function createMember(f: Fixture, suffix: string) {
  const locatorHash = createHash('sha256').update(`member:${suffix}`).digest('hex');
  const invitation = await f.identity.createInvitation({
    organizationId: f.owner.membership.organizationId,
    slackTeamId: f.owner.user.slackTeamId,
    slackUserId: 'U11111111',
    displayName: 'Member',
    role: 'admin',
    locatorHash,
    inviterMembershipId: f.owner.membership.id,
    expiresAt: NOW + 60_000,
  });
  const invited = await f.identity.consumeInvitation({
    invitationId: invitation.id,
    locatorHash,
    slackTeamId: f.owner.user.slackTeamId,
    slackUserId: invitation.slackUserId,
    displayName: 'Member',
    betterAuthUserId: `ba_user_${suffix}_member`,
    betterAuthMembershipId: `ba_member_${suffix}_member`,
  });
  await f.identity.updateMembershipAuthority({
    membershipId: invited.membership.id,
    role: 'member',
    actorMembershipId: f.owner.membership.id,
    correlationId: `demote-${suffix}`,
    authenticationSurface: 'better_auth',
    reasonCode: 'provider_handoff_test',
  });
  return invited;
}

/** A fixture whose service reads provider key state from a real settings store, like the deployment does. */
async function providerFixture(suffix: string) {
  const settings = new SqliteSettingsStore(':memory:');
  const usage = new SqliteUsageStore(':memory:');
  const f = await createManagementAdapterFixture(suffix, {
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(undefined, settings))[providerId],
    providerCredentialRevision: async (providerId) =>
      (await storedCredentialMetadata(providerId, settings))?.version ?? 0,
  });
  await f.config.ensureWorkspaceInstallation({
    workspaceId: f.owner.user.slackTeamId,
    transportMode: 'direct',
  });
  return {
    ...f,
    settings,
    usage,
    close() {
      f.close();
      settings.close();
      usage.close();
    },
  };
}

function toolAdapter(f: Fixture, context: ManagementActorContext) {
  return { service: f.service, resolveContext: async () => context };
}

test('an Owner gets a 24-hour provider key handoff over MCP and the key never enters MCP state', async () => {
  const f = await providerFixture('provider-handoff-owner');
  const observed: unknown[] = [];
  const receipts: unknown[] = [];
  try {
    const context = mcpContext(f.owner);
    const adapter = toolAdapter(f, context);
    const prepared = await invokeWorkspaceManagementTool(adapter, 'prepare_provider_setup', {
      providerId: 'openai',
    });
    observed.push(prepared);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const result = prepared.result as PrepareProviderSetupResult;
    assert.deepEqual(result.provider, { id: 'openai', name: 'OpenAI' });
    assert.equal(result.replacement, false);
    assert.equal(result.expiresAt, NOW + DAY_MS);
    assert.deepEqual(result.links, { admin: PROVIDERS_SETTINGS_URL });
    assert.match(result.setupOperationId, /^setup_/);
    const url = new URL(result.handoffUrl);
    assert.equal(url.origin, 'http://localhost');
    assert.equal(url.pathname, `/setup/${result.setupOperationId}`);
    assert.match(url.hash, /^#setup=[A-Za-z0-9_-]{43}$/);
    assert.equal(url.search, '');

    // The record matches what request_setup would have issued: same action,
    // target, scope, and expiry, owned by this MCP principal.
    const record = await f.management.getSetup(result.setupOperationId, NOW);
    assert.ok(record);
    assert.equal(record.action, 'provider_credential');
    assert.equal(record.target.kind, 'provider_credential');
    assert.equal(record.target.replacement, false);
    assert.deepEqual(record.scopes, ['models:openai']);
    assert.equal(record.expiresAt, NOW + DAY_MS);
    assert.equal(record.actorMembershipId, f.owner.membership.id);
    assert.equal(record.origin.kind, 'mcp');
    assert.equal(record.status, 'pending');

    // The person completes it in the browser; the key is typed there only.
    const app = createManagementSetupRoutes({
      management: f.management,
      config: f.config,
      settings: f.settings,
      usage: f.usage,
      identity: f.identity,
      authenticatePrincipal: async () => browserPrincipal(f.owner),
      now: () => NOW,
      randomCapability: () => 'q'.repeat(43),
      validateProviderKey: async (provider, key) => {
        assert.equal(provider, 'openai');
        assert.equal(key, 'sk-typed-in-browser-only');
        return [];
      },
      deliverReceipt: async (receipt) => {
        receipts.push(receipt);
        return { deliveryRef: 'slack:U1:provider.1' };
      },
    });
    const capability = url.hash.slice('#setup='.length);
    const exchanged = await app.request(`http://localhost/setup/${result.setupOperationId}/exchange`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ capability }),
    });
    assert.equal(exchanged.status, 200, await exchanged.text());
    const completed = await app.request(`http://localhost/setup/${result.setupOperationId}/complete`, {
      method: 'POST',
      headers: {
        origin: 'http://localhost',
        cookie: exchanged.headers.get('set-cookie')!,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ apiKey: 'sk-typed-in-browser-only' }).toString(),
    });
    assert.equal(completed.status, 303, await completed.text());
    assert.equal(
      (await resolveProviderApiKey('openai', undefined, f.settings)).apiKey,
      'sk-typed-in-browser-only',
    );
    assert.equal((await f.management.getSetup(result.setupOperationId, NOW))?.status, 'completed');

    // A second link now replaces the stored key and needs the explicit flag.
    const refused = await invokeWorkspaceManagementTool(adapter, 'prepare_provider_setup', {
      providerId: 'openai',
    });
    observed.push(refused);
    assert.ok(!refused.ok);
    assert.equal(refused.error.code, 'invalid_request');
    assert.match(refused.error.message, /already stored/);
    assert.match(refused.error.message, /replaceExisting/);
    assert.deepEqual(refused.error.links, { admin: PROVIDERS_SETTINGS_URL });

    const replacing = await invokeWorkspaceManagementTool(adapter, 'prepare_provider_setup', {
      providerId: 'openai',
      replaceExisting: true,
    });
    observed.push(replacing);
    assert.ok(replacing.ok, JSON.stringify(replacing));
    const replacement = replacing.result as PrepareProviderSetupResult;
    assert.equal(replacement.replacement, true);
    assert.notEqual(replacement.setupOperationId, result.setupOperationId);
    assert.equal(
      (await f.management.getSetup(replacement.setupOperationId, NOW))?.target.replacement,
      true,
    );

    // The same requester can revoke it like any setup link.
    const revoked = await invokeWorkspaceManagementTool(adapter, 'revoke_setup_link', {
      setupOperationId: replacement.setupOperationId,
    });
    observed.push(revoked);
    assert.ok(revoked.ok, JSON.stringify(revoked));
    assert.equal(
      (revoked.result as { revoked: { status: string } }).revoked.status,
      'revoked',
    );

    // Nothing that crossed the MCP door, the setup records, or the receipt
    // carries the key.
    const snapshot = await invokeWorkspaceManagementTool(adapter, 'inspect_workspace', {});
    observed.push(snapshot);
    assert.ok(snapshot.ok, JSON.stringify(snapshot));
    const everything = JSON.stringify({
      observed,
      receipts,
      setups: await Promise.all([result, replacement].map(({ setupOperationId }) =>
        f.management.getSetup(setupOperationId, NOW))),
    });
    assert.doesNotMatch(everything, /sk-typed-in-browser-only/);
    assert.doesNotMatch(everything, /sk-/);
    assert.ok(receipts.length === 1, 'one non-secret receipt was delivered');
    assert.equal(
      (snapshot.result as { providers: Array<{ id: string; source: string }> })
        .providers.find(({ id }) => id === 'openai')?.source,
      'stored',
    );
  } finally {
    f.close();
  }
});

test('a member is refused with the Model providers link and no setup record is created', async () => {
  const f = await providerFixture('provider-handoff-member');
  try {
    const member = await createMember(f, 'provider-handoff-member');
    const result = await invokeWorkspaceManagementTool(
      toolAdapter(f, mcpContext(member)),
      'prepare_provider_setup',
      { providerId: 'anthropic' },
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'forbidden');
    assert.match(result.error.message, /Owner or Admin/);
    assert.match(result.error.message, /Anthropic key/);
    assert.deepEqual(result.error.links, { admin: PROVIDERS_SETTINGS_URL });
    assert.equal(await f.management.getSetup(`${'provider-handoff-member'}_1`, NOW), undefined);

    // An Admin is gated exactly like Admin Settings → Model providers: allowed.
    const admin = await invokeWorkspaceManagementTool(
      toolAdapter(f, mcpContext(f.admin)),
      'prepare_provider_setup',
      { providerId: 'anthropic' },
    );
    assert.ok(admin.ok, JSON.stringify(admin));
    assert.equal((admin.result as PrepareProviderSetupResult).provider.name, 'Anthropic');
  } finally {
    f.close();
  }
});

test('a deployment-provided key is read-only and says so with the Settings link', async () => {
  const f = await createManagementAdapterFixture('provider-handoff-env', {
    providerCredentialSource: async () => 'env',
  });
  try {
    const result = await invokeWorkspaceManagementTool(
      toolAdapter(f, mcpContext(f.owner)),
      'prepare_provider_setup',
      { providerId: 'openrouter', replaceExisting: true },
    );
    assert.ok(!result.ok);
    assert.equal(result.error.code, 'invalid_request');
    assert.match(result.error.message, /read-only/);
    assert.deepEqual(result.error.links, { admin: PROVIDERS_SETTINGS_URL });
  } finally {
    f.close();
  }
});

test('provider and member outcomes from apply_workspace_changes carry Settings links that are never persisted', async () => {
  const f = await providerFixture('provider-handoff-apply');
  try {
    const owner = toolAdapter(f, mcpContext(f.owner));
    const issued = await invokeWorkspaceManagementTool(owner, 'apply_workspace_changes', {
      idempotencyKey: 'add-openai',
      operations: [{
        itemId: 'openai',
        kind: 'request_setup',
        target: { kind: 'provider_credential', providerId: 'openai' },
      }],
    });
    assert.ok(issued.ok, JSON.stringify(issued));
    const applied = issued.result as ManagementApplyResult;
    assert.equal(applied.outcomes[0]?.disposition, 'setup_required');
    assert.deepEqual(applied.outcomes[0]?.links, { admin: PROVIDERS_SETTINGS_URL });
    assert.deepEqual(applied.links, { admin: PROVIDERS_SETTINGS_URL });

    const replay = await invokeWorkspaceManagementTool(owner, 'get_operation', {
      operationId: applied.operationId,
    });
    assert.ok(replay.ok);
    const stored = (replay.result as { operation: { result?: ManagementApplyResult } }).operation;
    assert.equal(stored.result?.links, undefined);
    assert.equal(stored.result?.outcomes[0]?.links, undefined);
    assert.equal(stored.result?.outcomes[0]?.setupUrl, undefined);

    const member = await createMember(f, 'provider-handoff-apply');
    const denied = await invokeWorkspaceManagementTool(
      toolAdapter(f, mcpContext(member)),
      'apply_workspace_changes',
      {
        idempotencyKey: 'member-openai',
        operations: [{
          itemId: 'openai',
          kind: 'request_setup',
          target: { kind: 'provider_credential', providerId: 'openai' },
        }],
      },
    );
    assert.ok(denied.ok, JSON.stringify(denied));
    const deniedResult = denied.result as ManagementApplyResult;
    assert.equal(deniedResult.outcomes[0]?.disposition, 'failed');
    assert.equal(deniedResult.outcomes[0]?.code, 'operational_access_required');
    assert.deepEqual(deniedResult.outcomes[0]?.links, { admin: PROVIDERS_SETTINGS_URL });

    // No stored Anthropic key in this fixture: the removal fails and names Settings.
    const removal = await f.service.applyWorkspaceChanges({
      context: mcpContext(f.owner),
      idempotencyKey: 'remove-anthropic',
      operations: [{
        itemId: 'anthropic',
        kind: 'remove_provider_credential',
        providerId: 'anthropic',
      }],
    });
    assert.ok('outcomes' in removal);
    assert.equal(removal.outcomes[0]?.disposition, 'failed');
    assert.deepEqual(removal.outcomes[0]?.links, { admin: PROVIDERS_SETTINGS_URL });

    // Member authority changes point at the Team page.
    const memberChange = await f.service.applyWorkspaceChanges({
      context: mcpContext(f.owner),
      idempotencyKey: 'suspend-member',
      operations: [{
        itemId: 'member',
        kind: 'update_member',
        membershipId: member.membership.id,
        status: 'suspended',
      }],
    });
    assert.ok('outcomes' in memberChange);
    assert.equal(memberChange.outcomes[0]?.disposition, 'confirmation_required');
    assert.deepEqual(memberChange.outcomes[0]?.links, { admin: TEAM_URL });
  } finally {
    f.close();
  }
});

test('the MCP description tells a coding agent how to hand off a provider key without touching it', () => {
  const mcp = workspaceManagementToolDescription('prepare_provider_setup', 'mcp');
  for (const required of [
    'Owner or Admin', 'replaceExisting', 'links.admin', '24 hours', 'Never ask for, accept, or relay the key',
  ]) assert.ok(mcp.includes(required), `MCP description must mention ${required}`);
  assert.doesNotMatch(mcp, /presentation\.slack|\bDM\b/);
  const slack = workspaceManagementToolDescription('prepare_provider_setup');
  assert.match(slack, /Owner or Admin only/);
  assert.notEqual(slack, mcp);
});
