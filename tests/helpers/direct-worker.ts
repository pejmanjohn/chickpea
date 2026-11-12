import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { TestContext } from 'node:test';

import { Hono, type ExecutionContext } from 'hono';

import { channel as slackChannel, processDirectSlackEvent } from '../../src/channels/slack.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../../src/config/types.ts';
import type { IdentityStore } from '../../src/identity/types.ts';
import type { SlackCanonicalAdmissionInput, SlackDeliveryNote, SlackDirectDelivery } from '../../src/slack/claim-store.ts';
import { generateCredentialKeyring, workerCredentialKeySlot } from '../../src/slack/credential-keyring.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  resolveSlackInstallationCredentials,
  stageSlackCredentialBundle,
} from '../../src/slack/installation-credentials.ts';
import { withSlackArrival } from '../../src/slack/slack-arrival.ts';
import type { TurnJob } from '../../src/slack/turn-job-types.ts';
import type { SlackEventFixture } from '../../src/slack/types.ts';
import { DoSqlStateDb } from '../../src/state/do-state-db.ts';
import { buildTagStateStores, localGatewayAppStores, localTurnEnqueue } from '../../src/state/tag-state-stores.ts';
import { directStore, type DirectStore } from './direct-store-probe.ts';
import { withCloudflareUserAgent } from './cloudflare-target.ts';
import { FakeObjectStorage } from './installation-objects.ts';
import { createSlackOwner } from './slack-owner.ts';

/**
 * A standalone direct installation on the Cloudflare target, whose Worker
 * admits Slack's deliveries over its state store's RPCs.
 */

/** Resolves once `until` holds, polling for up to two seconds. */
export async function settled(until: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (until()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the detached work did not settle');
}

export const SIGNING_SECRET = 'direct-wake-signing-secret';

export interface DirectWorker {
  /** Every state RPC and Slack call, in order: `rpc:<method>` and `slack:<method>`. */
  log: string[];
  /** What the Worker told the state store of, in order. */
  notes: SlackDeliveryNote[];
  /** The failures the Worker logged. */
  failures: string[];
  stores: ReturnType<typeof buildTagStateStores>;
  db: DoSqlStateDb;
  /** `arrivedAt`: the host's arrival time for the request (withSlackArrival). */
  deliver(body: Record<string, unknown>, ctx?: ExecutionContext, arrivedAt?: number): Promise<Response>;
  /**
   * Admit `body` (an `event()`) as the state store would on its own stores:
   * processDirectSlackEvent on local ports and its own queue. A call it
   * makes to the stub is in `log` like any other.
   */
  admitLocally(body: Record<string, unknown>): Promise<void>;
  event(event: Record<string, unknown>): Record<string, unknown>;
  /** The state store's own admission (TagStateStore.admitSlackDelivery) over `stores`. */
  store: DirectStore;
  env: PlatformEnv;
}

/** How the state store answers `admitSlackDelivery`: as this code does, as older code does (workerd rejects the call), or by `answer`. */
export type StoreAdmission =
  | 'current'
  | 'missing'
  | ((delivery: SlackDirectDelivery, store: DirectStore) => Promise<unknown>);

/** workerd's rejection of a call to a method the object's code lacks (tests/store-fallback-workerd.test.ts). */
export function missingMethod(name: string): Promise<never> {
  return Promise.reject(new TypeError(`The RPC receiver does not implement the method "${name}".`));
}

/**
 * A standalone direct installation served by the Worker on the Cloudflare
 * target: its state store is an object the Worker reaches over RPC (here the
 * state store's own logic behind a stub that answers the RPCs the Worker's
 * admission makes), its credentials are encrypted under the deployment's
 * keyring, and Slack's Web API answers from a table. `note` is what the
 * state store answers the note with.
 */
export async function withDirectWorker(
  t: TestContext,
  run: (worker: DirectWorker) => Promise<void>,
  options: {
    note?: () => Promise<unknown>;
    /** Deployment variables, such as CHICKPEA_SLACK_ADMISSION. */
    env?: Record<string, unknown>;
    admission?: StoreAdmission;
    /** Answers a Slack Web API call before the table does; undefined leaves it to the table. */
    slack?: (method: string) => Response | undefined | Promise<Response | undefined>;
    /** `app`: the app's own credentials alone, as before the workspace connected it, so no bot token. */
    credentials?: 'app';
  } = {},
): Promise<void> {
  const keyring = generateCredentialKeyring('key_v1');
  const log: string[] = [];
  const notes: SlackDeliveryNote[] = [];
  const failures: string[] = [];
  const platform: Record<string, unknown> = {
    CHICKPEA_CREDENTIAL_KEY_CURRENT_ID: keyring.currentKeyId,
    [workerCredentialKeySlot(keyring.currentKeyId)]: keyring.keys[keyring.currentKeyId],
    ...options.env,
  };
  const storage = new FakeObjectStorage();
  const db = new DoSqlStateDb(storage.asDurableObjectStorage());
  const stores = buildTagStateStores(db, platform as PlatformEnv, { gatewayLeaseOwner: 'test' });
  const call = <T>(fn: () => T) => {
    try {
      return Promise.resolve({ ok: true as const, value: fn() });
    } catch (error) {
      return Promise.resolve({ ok: false as const, error: { code: 'internal' as const, message: (error as Error).message } });
    }
  };
  // The RPCs as TagStateStore answers them, over the same stores.
  const answers: Record<string, (...args: never[]) => Promise<unknown>> = {
    identityExecute: (request: Parameters<typeof stores.identity.execute>[0]) => call(() => stores.identity.execute(request)),
    settingGet: (key: string) => call(() => stores.settings.getSetting(key) ?? null),
    settingGetMany: (keys: readonly string[]) => call(() => stores.settings.getSettings(keys).map((value) => value ?? null)),
    settingSet: (key: string, value: string) => call(() => { stores.settings.setSetting(key, value); return null; }),
    claim: (key: string) => call(() => stores.slack.claim(key)),
    release: (key: string) => call(() => { stores.slack.release(key); return null; }),
    threadStart: (key: string) => call(() => { stores.slack.start(key); return null; }),
    threadHas: (key: string) => call(() => stores.slack.has(key)),
    threadActiveWorkGet: (key: string) => call(() => stores.slack.isActiveWork(key)),
    snapshotGet: (key: string) => call(() => stores.snapshots.get(key) ?? null),
    snapshotPutIfAbsent: (key: string, snapshot: Parameters<typeof stores.snapshots.putIfAbsent>[1]) =>
      call(() => stores.snapshots.putIfAbsent(key, snapshot)),
    snapshotReplace: (key: string, snapshot: Parameters<typeof stores.snapshots.replace>[1]) =>
      call(() => stores.snapshots.replace(key, snapshot)),
    admitSlackTurn: (input: SlackCanonicalAdmissionInput) =>
      call(() => stores.slack.admitCanonical(input, stores.work, stores.turnJobs, stores.presentations, stores.uiSurfaces)),
    slackTurnAdmitEdit: (edit: Parameters<typeof stores.slack.admitEdit>[0]) =>
      call(() => stores.slack.admitEdit(edit, stores.work, stores.turnJobs, stores.presentations)),
    slackTurnSteer: (request: Parameters<typeof stores.turnJobs.steer>[0], enqueue?: TurnJob) =>
      call(() => stores.turnJobs.steer(request, enqueue)),
    enqueueTurn: (job: TurnJob) => call(() => { stores.turnJobs.enqueue(job); return null; }),
    managementExecute: (request: Parameters<typeof stores.management.execute>[0]) => call(() => stores.management.execute(request)),
    usageExecute: (request: Parameters<typeof stores.usage.execute>[0]) => call(() => stores.usage.execute(request)),
    noteSlackDelivery: (received: SlackDeliveryNote) => {
      notes.push(received);
      return options.note ? options.note() : Promise.resolve({ ok: true, value: null });
    },
    admitSlackDelivery: (delivery: SlackDirectDelivery) => {
      const admission = options.admission ?? 'current';
      if (admission === 'missing') return missingMethod('admitSlackDelivery');
      return admission === 'current' ? store.admitSlackDelivery(delivery) : admission(delivery, store);
    },
  };
  const configRpc = (name: string) => (...args: unknown[]) => call(() => {
    const method = name.slice('config'.length);
    const logic = stores.config as unknown as Record<string, (...input: unknown[]) => unknown>;
    const fn = logic[method[0]!.toLowerCase() + method.slice(1)];
    if (typeof fn !== 'function') throw new Error(`rpc ${name} is not in this test`);
    return fn.apply(stores.config, args) ?? null;
  });
  const stub = new Proxy({}, {
    get: (_target, name) => typeof name !== 'string' ? undefined : (...args: never[]) => {
      log.push(`rpc:${name}`);
      const answer = answers[name] ?? (name.startsWith('config') ? configRpc(name) : undefined);
      return answer
        ? answer(...args)
        : Promise.resolve({ ok: false, error: { code: 'internal', message: `rpc ${name} is not in this test` } });
    },
  });
  platform.TAG_STATE = { getByName: () => stub };
  const env = platform as PlatformEnv;
  const store = directStore(stores, env);

  const identity = stores.identity as unknown as IdentityStore;
  const owner = await createSlackOwner(identity, { teamId: 'T1', userId: 'U1' });
  stores.config.ensureWorkspaceInstallation({ workspaceId: 'T1', transportMode: 'direct', appId: 'A1', botUserId: 'UBOT', teamId: 'T1' });
  stores.config.materializeChickpeaAgent();
  stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
  // The built-in Agent answers with the workspace's model, so admission is canonical (admitSlackTurn).
  stores.config.putWorkspaceModelDefault({
    workspaceId: 'T1', modelId: 'local-stub/chickpea', provenance: 'admin_selected',
    lastChangedByMembershipId: owner.membership.id,
  }, stores.config.getWorkspaceModelDefault('T1')?.revision ?? 0);
  const dependencies = { state: identity, keyring };
  const appOnly = options.credentials === 'app';
  const staged = await stageSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
    purpose: appOnly ? 'app_credentials' : 'connected_credentials', expectedActiveRevision: null,
    appId: 'A1', ...appOnly ? {} : { teamId: 'T1', botUserId: 'UBOT' }, grantedScopes: ['chat:write'], validatedAt: Date.now(),
    secrets: appOnly
      ? { clientId: 'client-1', clientSecret: 'client-secret-1', signingSecret: SIGNING_SECRET }
      : { botToken: 'xoxb-direct-worker', signingSecret: SIGNING_SECRET },
  });
  await promoteSlackCredentialBundle(dependencies, {
    identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: staged.revision, expectedActiveRevision: null,
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const method = url.pathname.split('/').at(-1)!;
    log.push(`slack:${method}`);
    const answered = await options.slack?.(method);
    if (answered) return answered;
    const body = new URLSearchParams(await request.clone().text().catch(() => ''));
    const user = body.get('user') ?? 'U1';
    const answer = method === 'auth.test'
      ? { ok: true, team_id: 'T1', user_id: 'UBOT', bot_id: 'BBOT', app_id: 'A1', team: 'Team' }
      : method === 'users.info'
        ? { ok: true, user: {
            id: user, team_id: 'T1', name: user, deleted: false, is_bot: false, is_app_user: false,
            is_restricted: false, is_ultra_restricted: false, is_stranger: false,
          } }
        : method === 'conversations.info'
          ? { ok: true, channel: body.get('channel')?.startsWith('C')
              ? { id: body.get('channel'), name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false }
              : { id: body.get('channel'), is_im: true, user: 'U1' } }
          : method === 'conversations.members'
            ? { ok: true, members: ['U1', 'UBOT'], response_metadata: { next_cursor: '' } }
            : method.startsWith('chat.')
              ? { ok: true, ts: '1900000000.000100', channel: body.get('channel') ?? 'D1' }
              : { ok: true };
    return Response.json(answer, { headers: { 'x-oauth-scopes': 'chat:write,users:read' } });
  }) as typeof fetch;
  t.mock.method(console, 'error', (...parts: unknown[]) => { failures.push(parts.map(String).join(' ')); });
  invalidateSlackInstallationCredentialCache();
  const ingress = new Hono();
  ingress.route('/channels/slack', slackChannel.route());
  let events = 0;
  try {
    await withCloudflareUserAgent(() => run({
      log,
      notes,
      failures,
      stores,
      db,
      store,
      env,
      async admitLocally(body) {
        const credentials = await resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, env, { state: identity, env });
        const installation = stores.config.getWorkspaceInstallation(String(body.team_id));
        assert.ok(installation, 'the delivery is for this installation');
        await processDirectSlackEvent(body as unknown as SlackEventFixture, env, {
          stores: localGatewayAppStores(stores),
          credentials,
          botUserId: credentials.botUserId ?? installation.botUserId,
          enqueueTurn: localTurnEnqueue(stores),
        }, installation);
      },
      async deliver(body, ctx, arrivedAt) {
        const raw = JSON.stringify(body);
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = createHmac('sha256', SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest('hex');
        return ingress.request('/channels/slack/events', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': `v0=${signature}`,
          },
          body: raw,
        }, arrivedAt === undefined ? env : withSlackArrival(env, arrivedAt), ctx);
      },
      event(event) {
        events += 1;
        return {
          token: '', team_id: 'T1', api_app_id: 'A1', type: 'event_callback',
          event_id: `EvWorker${events}`, event_time: 1_700_000_000 + events,
          authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
          event,
        };
      },
    }));
  } finally {
    globalThis.fetch = previousFetch;
    invalidateSlackInstallationCredentialCache();
  }
}

export const DM = { type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', ts: '6000.000100', text: 'hello' };
export const WORKER_MENTION = { type: 'app_mention', channel: 'C1', user: 'U1', ts: '5000.000100', text: '<@UBOT> what changed?' };
