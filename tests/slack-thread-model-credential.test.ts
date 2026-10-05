import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import {
  createInstallationModelAccessResolver,
  frozenModelAccessGrant,
  modelAccessInstallationId,
} from '../src/config/installation-model-access.ts';
import {
  ModelCredentialRevisionError,
  revalidateModelCredentialAttribution,
} from '../src/config/model-credential-refs.ts';
import {
  deleteProviderApiKey,
  invalidateProviderKeyCache,
  saveProviderApiKey,
} from '../src/config/provider-keys.ts';
import { closeNodeStateStores, resolveStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import type { TurnJob } from '../src/slack/turn-job-types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const OWNER = {
  id: 'U1', team_id: 'T1', name: 'Owner', deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, is_stranger: false,
};
const MODEL = 'openai/gpt-5.6-sol';

test('a key removed and saved again serves the next turn of an older thread; the turn in flight keeps refusing', async () => {
  const dbKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const envKeys = [...dbKeys, 'OPENAI_API_KEY'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of dbKeys) process.env[key] = ':memory:';
  // The key saved in Admin, not a deployment key, is the credential.
  delete process.env.OPENAI_API_KEY;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const stores = resolveStores();
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.createAgent({
      id: 'agent_support', name: 'support', instructions: '', enabled: true, lifecycle: 'active',
      model: MODEL,
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active',
        health: 'healthy', userGroupId: 'SSUPPORT',
        avatar: { kind: 'generated', revision: 1, seed: 'support' },
      },
    });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1',
    });
    await stores.config.putChannel({
      workspaceId: 'T1', channelId: 'C1', label: 'support', lifecycle: 'active',
    }, 0);
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: 'agent_support', status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'support',
      channelIsPrivate: false,
    }, 0);
    await saveProviderApiKey('openai', 'stored-openai-key', undefined, stores.settings, stores.usage);

    const binding = { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' };
    const channel = {
      id: 'C1', name: 'support', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return binding; },
      async call(operation: string) {
        if (operation === 'users.info') return { user: OWNER };
        if (operation === 'conversations.info') return { channel };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation === 'chat.postMessage') return { ts: '1000.0001', channel: 'C1' };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { userAgent: 'Cloudflare-Workers' },
    });
    const jobs: TurnJob[] = [];
    const mention = (ts: string, threadTs?: string) => processGatewaySlackEnvelope({
      workspaceId: 'T1', eventId: `Ev${ts}`, eventTime: Number(ts.split('.')[0]),
      event: {
        type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: '<!subteam^SSUPPORT|@support> Hello there.',
      },
    }, undefined, gateway, {
      stores,
      enqueueTurn: async (job) => { jobs.push(job); return { ok: true, value: null }; },
    });

    assert.equal(await mention('3000.000100'), 'accepted');
    const inFlight = jobs[0]?.assignment.modelCredential;
    assert.ok(inFlight);
    // An older thread's snapshot still carries its first turn's credential.
    const [root] = await stores.snapshots.listLiveRootsByAgent('agent_support');
    const snapshot = root && await stores.snapshots.get(root.threadKey);
    assert.ok(root && snapshot);
    await stores.snapshots.replace(root.threadKey, { ...snapshot, modelCredential: inFlight });

    await deleteProviderApiKey('openai', undefined, stores.settings, stores.usage);
    await saveProviderApiKey('openai', 'stored-openai-key', undefined, stores.settings, stores.usage);

    assert.equal(await mention('3001.000100', '3000.000100'), 'accepted');
    const next = jobs[1]?.assignment.modelCredential;
    assert.ok(next);
    assert.equal(next.credentialRefId, inFlight.credentialRefId);
    assert.equal(next.version, inFlight.version + 2);

    const resolver = createInstallationModelAccessResolver({ settings: () => stores.settings });
    const grant = (credential: typeof inFlight) =>
      frozenModelAccessGrant(credential, modelAccessInstallationId(undefined), 'run')!;
    assert.deepEqual(await resolver.resolve(grant(next), undefined), { apiKey: 'stored-openai-key' });
    await revalidateModelCredentialAttribution(MODEL, next, undefined, stores.settings, stores.usage);

    // The turn admitted before the change never runs on the newer version.
    const changed = (error: unknown) => error instanceof ModelCredentialRevisionError &&
      error.credentialRefId === inFlight.credentialRefId && error.expectedVersion === inFlight.version;
    await assert.rejects(resolver.resolve(grant(inFlight), undefined), changed);
    await assert.rejects(
      revalidateModelCredentialAttribution(MODEL, inFlight, undefined, stores.settings, stores.usage),
      changed,
    );
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    invalidateProviderKeyCache();
    closeNodeStateStores();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
});
