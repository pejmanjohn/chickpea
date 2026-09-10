import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeManagedConnectionCapability, createManagedConnectionProviderRegistry } from '../src/connections/managed.ts';
import { MANAGED_ARTIFACT_ARGUMENT } from '../src/connections/artifacts.ts';
import { ManagedAuthorityDeniedError, ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import type { ConfigStore } from '../src/config/store.ts';
import type { IdentityStore } from '../src/identity/types.ts';
import type { UsageStore } from '../src/usage/types.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const boundary of ['quota', 'client', 'preflight', 'session'] as const) {
  for (const revocation of ['actor', 'binding', 'capability', 'account', 'resource'] as const) {
    test(`managed dispatch stops ${revocation} revocation during ${boundary}`, async () => {
      let active = true;
      let enabled = true;
      const policy = {
        kind: 'managed' as const, adapterId: 'composio', toolkit: 'youtube',
        allowedCapabilities: ['youtube.playlists.create'],
        resourceConstraints: { channelIds: [{ handle: 'ch', label: 'Channel', providerRef: 'UCfake' }] },
        principalRef: 'u', accountRef: 'a',
      };
      const account = { id: 'a', workspaceId: 'T', providerId: 'google', ownerKind: 'team', lifecycle: 'ready', policy };
      const config = {
        async listConnectionAccounts() { return [account]; },
        async listAgentConnectionBindings() {
          return [{ agentId: 'agent', connectionAccountId: 'a', providerId: 'google', enabled,
            allowedCapabilities: ['youtube.playlists.create'], resourceConstraints: { channelIds: ['ch'] } }];
        },
      } as unknown as ConfigStore;
      const identity = {
        async getOrganization() { return { id: 'o', slackTeamId: 'T' }; },
        async getMembership() { return { id: 'm', userId: 'u', organizationId: 'o', status: active ? 'active' : 'suspended' }; },
        async getMembershipAccessOverlay() { return null; },
        async getUser() { return { id: 'u', slackTeamId: 'T', slackUserId: 'U' }; },
        async resolveSlackIdentity() { return { user: { id: 'u' }, membership: { id: 'm' }, binding: { membershipId: 'm' } }; },
      } as unknown as IdentityStore;
      const entered = deferred();
      const resume = deferred();
      const pause = async () => { entered.resolve(); await resume.promise; };
      const tools: string[] = [];
      const execute = async (tool: string) => {
        tools.push(tool);
        if (tool === 'YOUTUBE_LIST_CHANNELS') {
          if (boundary === 'preflight') await pause();
          return { data: { items: [{ id: 'UCfake', snippet: { title: 'Channel' } }] } };
        }
        throw new Error(`Unexpected capability dispatch: ${tool}`);
      };
      const provider = new ComposioManagedConnectionProvider({
        apiKey: 'test-key',
        createClient: async () => {
          if (boundary === 'client') await pause();
          return {
            ...(boundary === 'session' ? {} : { tools: { execute } }),
            sessions: { async create() { await pause(); return { execute }; } },
          };
        },
      });
      const records: Array<Record<string, unknown>> = [];
      const releases: string[] = [];
      const usage = {
        async reserveConnectorQuota() {
          if (boundary === 'quota') await pause();
          return { remaining: 9999 };
        },
        async recordConnectorUsage(record: Record<string, unknown>) { records.push(record); },
        async releaseConnectorQuota(reservation: { bucket: string }) { releases.push(reservation.bucket); },
      } as unknown as UsageStore;
      const invocation = invokeManagedConnectionCapability({ config, identity,
        providers: createManagedConnectionProviderRegistry([provider]), usage,
        workspaceId: 'T', agentId: 'agent', actorMembershipId: 'm', connectionAccountId: 'a',
        capability: 'youtube.playlists.create', arguments: { channelHandle: 'ch', title: 'Test', privacyStatus: 'private' },
      });
      const rejected = assert.rejects(invocation, (error: unknown) => {
        assert.ok(error instanceof ManagedProviderRequestError);
        assert.equal(error.code, 'validation_failed');
        assert.equal(error.metadata.capabilityToolDispatched, false);
        assert.equal(error.metadata.definiteFailure, true);
        assert.equal(error.metadata.remoteCallCount, ['preflight', 'session'].includes(boundary) ? 1 : 0);
        assert.equal(error.metadata.providerToolCallCount, boundary === 'preflight' ? 1 : 0);
        return true;
      });
      await entered.promise;
      if (revocation === 'actor') active = false;
      if (revocation === 'binding') enabled = false;
      if (revocation === 'capability') policy.allowedCapabilities = [];
      if (revocation === 'account') policy.accountRef = 'replacement';
      if (revocation === 'resource') policy.resourceConstraints.channelIds[0]!.providerRef = 'replacement';
      resume.resolve();
      await rejected;
      assert.deepEqual(tools, boundary === 'preflight' ? ['YOUTUBE_LIST_CHANNELS'] : []);
      assert.equal(records[0]?.outcome, 'validation_failed');
      assert.equal(releases.includes('general_units'), boundary === 'quota' || boundary === 'client');
    });
  }
}

for (const boundary of ['staging-request', 'upload', 'write'] as const) {
  test(`YouTube rechecks staging boundaries and preserves readback after ${boundary}`, async (t) => {
    const entered = deferred();
    const resume = deferred();
    let active = true;
    const calls: string[] = [];
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      const stage = init?.method === 'POST' ? 'staging-request' : 'upload';
      requests.push(stage);
      if (boundary === stage) { entered.resolve(); await resume.promise; }
      return stage === 'staging-request' ? Response.json({
        key: 'projects/test/tiny.mp4',
        new_presigned_url: 'https://storage.composio.dev/upload/tiny.mp4?signature=test',
        metadata: { storage_backend: 's3' },
      }) : new Response(null, { status: 200 });
    });
    const provider = new ComposioManagedConnectionProvider({ apiKey: 'test-key',
      createClient: async () => ({
        sessions: { async create() { throw new Error('unexpected session'); } },
        tools: { async execute(tool) {
          calls.push(tool);
          if (tool === 'YOUTUBE_LIST_CHANNELS') return { data: { items: [{ id: 'UCfake' }] } };
          if (tool === 'YOUTUBE_UPLOAD_VIDEO') {
            entered.resolve(); await resume.promise;
            return { data: { id: 'video_new' } };
          }
          if (tool === 'YOUTUBE_GET_VIDEO_DETAILS_BATCH') return { data: { items: [{
            id: 'video_new', snippet: { channelId: 'UCfake' }, status: { privacyStatus: 'private' },
          }] } };
          throw new Error(tool);
        } },
      }),
    });
    const bytes = new Uint8Array(16);
    bytes.set([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70]);
    const invocation = provider.execute({
      policy: { kind: 'managed', adapterId: 'composio', toolkit: 'youtube', principalRef: 'u', accountRef: 'a',
        allowedCapabilities: ['youtube.videos.upload'], resourceConstraints: {
          channelIds: [{ handle: 'ch', label: 'Channel', providerRef: 'UCfake' }],
        } },
      capability: 'youtube.videos.upload',
      arguments: { channelHandle: 'ch', title: 'Test', privacyStatus: 'private',
        [MANAGED_ARTIFACT_ARGUMENT]: { name: 'tiny.mp4', mimeType: 'video/mp4', bytes,
          workspaceId: 'T', agentId: 'agent', retention: 'invocation' } },
      revalidateAuthority: async () => { if (!active) throw new ManagedAuthorityDeniedError('Actor suspended'); },
    });
    const result = invocation.then((value) => ({ value }), (error: unknown) => ({ error }));
    await entered.promise;
    active = false;
    resume.resolve();
    const settled = await result;
    if (boundary === 'write') {
      assert.ok('value' in settled);
      assert.equal(settled.value.remoteCallCount, 5);
      assert.equal(settled.value.providerToolCallCount, 3);
      assert.equal((settled.value.data.verification as { verified: boolean }).verified, true);
    } else {
      assert.ok('error' in settled && settled.error instanceof ManagedProviderRequestError);
      assert.equal(settled.error.code, 'validation_failed');
      assert.equal(settled.error.metadata.capabilityToolDispatched, false);
      assert.equal(settled.error.metadata.remoteCallCount, boundary === 'upload' ? 3 : 2);
      assert.equal(settled.error.metadata.providerToolCallCount, 1);
      assert.deepEqual(calls, ['YOUTUBE_LIST_CHANNELS']);
    }
    assert.deepEqual(requests, boundary === 'staging-request' ? ['staging-request'] : ['staging-request', 'upload']);
  });
}
