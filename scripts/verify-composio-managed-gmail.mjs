import assert from 'node:assert/strict';

import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  createManagedConnectionProviderRegistry,
  invokeManagedConnectionCapability,
} from '../src/connections/managed.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { ConnectionAccountService } from '../src/connections/store.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { MANAGED_CONNECTOR_CANARY_MANIFESTS } from '../src/connections/canary-manifests.ts';

const apiKey = requiredEnvironmentValue('COMPOSIO_API_KEY');
const accountRef = requiredEnvironmentValue('COMPOSIO_CONNECTED_ACCOUNT_ID');
const principalRef = requiredEnvironmentValue('COMPOSIO_USER_ID');
const connectorInput = process.env.COMPOSIO_CONNECTOR?.trim().toLowerCase() || 'gmail';
const accessLane = parseAccessLane(process.env.COMPOSIO_ACCESS_LANE);
const connector = MANAGED_CONNECTOR_CATALOG.list().find(
  ({ id, toolkit }) => id === connectorInput || toolkit === connectorInput,
);
if (!connector) throw new Error(`Unknown COMPOSIO_CONNECTOR ${JSON.stringify(connectorInput)}`);
const manifest = MANAGED_CONNECTOR_CANARY_MANIFESTS[connector.toolkit];
if (!manifest) throw new Error(`No safe canary manifest exists for ${connector.toolkit}`);

const laneCapabilities = connector.capabilities.filter(({ accessLane: capabilityLane }) =>
  accessLane === 'read' ? capabilityLane === 'read' : capabilityLane === 'write');
const configuredCapability = process.env.COMPOSIO_CAPABILITY?.trim();
if (accessLane === 'write' && !configuredCapability) {
  throw new Error('COMPOSIO_CAPABILITY is required for a write canary');
}
const capabilityId = configuredCapability || manifest.capability || laneCapabilities[0]?.id;
const capability = capabilityId && MANAGED_CONNECTOR_CATALOG.capability(capabilityId);
if (!capability || capability.connectorToolkit !== connector.toolkit ||
    (accessLane === 'read' && capability.accessLane !== 'read')) {
  throw new Error('COMPOSIO_CAPABILITY is not available for the selected connector/access lane');
}
const arguments_ = parseJsonObject('COMPOSIO_ARGUMENTS_JSON', manifest.arguments);
const resourceConstraints = parseJsonObject('COMPOSIO_RESOURCE_CONSTRAINTS_JSON', {});
if (!configuredCapability || capability.id === manifest.capability) {
  requireManifestInputs(manifest, arguments_, resourceConstraints);
}
const dataModifying = capability.effect !== 'read';
if (dataModifying && process.env.COMPOSIO_ALLOW_WRITE_CANARY !== '1') {
  throw new Error(
    `Capability ${capability.id} can modify external state. `
      + 'Set COMPOSIO_ALLOW_WRITE_CANARY=1 only after reviewing COMPOSIO_ARGUMENTS_JSON.',
  );
}

const workspaceId = 'T_COMPOSIO_VERIFY';
const agentId = 'agent_composio_verify';
const membershipId = 'membership_composio_verify';
const config = new SqliteConfigStore(':memory:', { agents: [] });
const settings = new SqliteSettingsStore(':memory:');
const usage = new SqliteUsageStore(':memory:');
const provider = new ComposioManagedConnectionProvider({ apiKey });
const providers = createManagedConnectionProviderRegistry([provider]);
const service = new ConnectionAccountService({ config, settings, managedProviders: providers });

const principal = {
  userId: 'user_composio_verify',
  membershipId,
  organizationId: 'organization_composio_verify',
  role: 'owner',
  authenticatorKind: 'test',
  credentialId: 'credential_composio_verify',
  correlationId: crypto.randomUUID(),
  machine: false,
};

const identity = activeIdentity({ workspaceId, membershipId, principal });

try {
  await config.createAgent({
    id: agentId,
    name: 'Composio verifier',
    instructions: `Verify the managed ${connector.label} connection.`,
    enabled: true,
    creatorMembershipId: membershipId,
    editPolicy: 'creator_and_admins',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
  await config.ensureWorkspaceInstallation({
    workspaceId,
    transportMode: 'direct',
    defaultAgentId: agentId,
  });
  const account = await service.create({
    principal,
    workspaceId,
    ownerKind: 'member',
    providerId: connector.providerId,
    label: `Live Composio ${connector.label}`,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: connector.toolkit,
      principalRef,
      accountRef,
      allowedCapabilities: [capability.id],
      resourceConstraints,
    },
  });
  await service.attach({
    principal,
    agentId,
    connectionAccountId: account.id,
    allowedCapabilities: [capability.id],
    resourceConstraints: Object.fromEntries(
      Object.entries(resourceConstraints).map(([key, selections]) => [
        key,
        Array.isArray(selections) ? selections.map(({ handle }) => handle) : [],
      ]),
    ),
  });

  if (dataModifying) {
    console.error(JSON.stringify({
      event: 'chickpea.composio_live_verifier.data_modifying_canary',
      connector: connector.id,
      capability: capability.id,
      effectClass: capability.effect,
    }));
  }

  const operationId = `composio-canary:${crypto.randomUUID()}`;
  const result = await invokeManagedConnectionCapability({
    config,
    identity,
    providers,
    workspaceId,
    agentId,
    actorMembershipId: membershipId,
    connectionAccountId: account.id,
    capability: capability.id,
    arguments: arguments_,
    usage,
    correlation: { operationId },
  });
  const summary = await usage.summarizeConnectorUsage({
    from: 0,
    to: Date.now() + 1,
    workspaceId,
    toolkit: connector.toolkit,
  });
  assert.equal(account.lifecycle, 'ready');
  assert.equal(summary.attemptCount, 1);
  assert.equal(summary.groups[0]?.outcome, 'success');

  console.log(JSON.stringify({
    ok: true,
    connector: connector.id,
    toolkit: connector.toolkit,
    accessLane,
    capability: capability.id,
    effectClass: capability.effect,
    dataModifyingCanary: dataModifying,
    accountLifecycle: account.lifecycle,
    providerVersion: result.providerVersion ?? null,
    providerLogId: result.logId ?? null,
    resultKeys: Object.keys(result.data).sort(),
    resultBytes: new TextEncoder().encode(result.serializedData).byteLength,
    measurement: {
      outcome: summary.groups[0]?.outcome ?? null,
      providerToolCallCount: summary.providerToolCallCount,
      estimatedCostMicros: summary.estimatedCostMicros,
    },
  }, null, 2));
} finally {
  config.close();
  settings.close();
  usage.close();
}

function requiredEnvironmentValue(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseAccessLane(value) {
  const lane = value?.trim().toLowerCase() || 'read';
  if (lane !== 'read' && lane !== 'write') {
    throw new Error('COMPOSIO_ACCESS_LANE must be read or write');
  }
  return lane;
}

function parseJsonObject(name, fallback) {
  const input = process.env[name]?.trim();
  if (!input) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed;
}

function requireManifestInputs(manifest, arguments_, resourceConstraints) {
  const missingArguments = manifest.requiredArguments.filter((name) => {
    const value = arguments_[name];
    return typeof value !== 'string' || !value.trim();
  });
  const missingResources = manifest.requiredResourceConstraints.filter((name) => {
    const value = resourceConstraints[name];
    return !Array.isArray(value) || value.length === 0;
  });
  if (missingArguments.length || missingResources.length) {
    throw new Error([
      missingArguments.length
        ? `COMPOSIO_ARGUMENTS_JSON must include: ${missingArguments.join(', ')}`
        : '',
      missingResources.length
        ? `COMPOSIO_RESOURCE_CONSTRAINTS_JSON must include: ${missingResources.join(', ')}`
        : '',
    ].filter(Boolean).join('; '));
  }
}

function activeIdentity({ workspaceId: teamId, membershipId: memberId, principal: actor }) {
  const user = {
    id: actor.userId,
    slackTeamId: teamId,
    slackUserId: 'U_COMPOSIO_VERIFY',
    displayName: 'Composio verifier',
    contactEmail: null,
    createdAt: 1,
    updatedAt: 1,
  };
  const membership = {
    id: memberId,
    organizationId: actor.organizationId,
    userId: user.id,
    role: 'owner',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  };
  const binding = {
    id: 'binding_composio_verify',
    provider: 'slack',
    slackTeamId: teamId,
    slackUserId: user.slackUserId,
    userId: user.id,
    organizationId: membership.organizationId,
    membershipId: membership.id,
    betterAuthUserId: null,
    betterAuthMembershipId: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    getOrganization: async () => ({
      id: actor.organizationId,
      displayName: 'Composio verification',
      slackTeamId: teamId,
      authMode: 'slack_active',
      canonicalAdminOrigin: 'https://chickpea.invalid',
      createdAt: 1,
      updatedAt: 1,
    }),
    getMembership: async () => membership,
    getMembershipAccessOverlay: async () => undefined,
    getUser: async () => user,
    resolveSlackIdentity: async () => ({ user, membership, binding }),
  };
}
