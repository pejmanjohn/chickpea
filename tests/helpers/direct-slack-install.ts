import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

import { channel as slackChannel } from '../../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../../src/config/state-backend.ts';
import { WORKSPACE_SLACK_INSTALLATION_ID } from '../../src/config/types.ts';
import { buildSlackAppManifest, slackManifestFingerprint } from '../../src/slack/app-manifest.ts';
import { loadCredentialKeyring } from '../../src/slack/credential-keyring.ts';
import { invalidateStoredSlackPublicUrl } from '../../src/slack/credentials.ts';
import {
  invalidateSlackInstallationCredentialCache,
  promoteSlackCredentialBundle,
  stageSlackCredentialBundle,
} from '../../src/slack/installation-credentials.ts';
import { stopNodeTurnRelay } from '../../src/slack/node-turn-relay.ts';
import { createSlackOwner } from './slack-owner.ts';

export interface DirectSlackCall {
  method: string;
  body: URLSearchParams;
}

/**
 * A standalone customer-owned (direct) install as setup leaves it, in team T1
 * with app A1 and bot UBOT: isolated in-memory state, the owner U1, the
 * workspace record, the encrypted app and bot credentials, Slack's Web API
 * answered by `answer`, and signed deliveries through Core's Slack routes.
 */
export interface DirectSlackInstall {
  stores: AppStores;
  ownerMembershipId: string;
  /** Every Slack Web API call, in order. */
  calls: DirectSlackCall[];
  /** POST a delivery signed with the install's signing secret, with the env a host would give Core. */
  deliver(kind: 'events' | 'interactions', body: Record<string, unknown>, env?: PlatformEnv): Promise<Response>;
}

export async function withDirectSlackInstall(
  options: {
    origin?: string;
    signingSecret?: string;
    botToken?: string;
    /** Slack's JSON answer to one Web API call; `{ ok: true }` when undefined. */
    answer?: (method: string, body: URLSearchParams) => Record<string, unknown> | undefined;
  },
  run: (install: DirectSlackInstall) => Promise<void>,
): Promise<void> {
  // Another file's relay may still be alive in this process; keep it stopped
  // so no wake runs this install's turns under the caller's assertions.
  await stopNodeTurnRelay();
  const keys = [
    'TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH',
    'CHICKPEA_CREDENTIAL_KEYRING_PATH', 'SLACK_TAG_PUBLIC_URL',
  ] as const;
  const previous = keys.map((key) => process.env[key]);
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-direct-install-'));
  process.env.TAG_DB_PATH = ':memory:';
  process.env.SLACK_STATE_DB_PATH = ':memory:';
  process.env.CHICKPEA_AUTH_DB_PATH = ':memory:';
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = join(directory, 'credential-keyring.json');
  delete process.env.SLACK_TAG_PUBLIC_URL;
  const previousFetch = globalThis.fetch;
  closeNodeStateStores();
  invalidateSlackInstallationCredentialCache();
  invalidateStoredSlackPublicUrl();
  try {
    const stores = resolveStores();
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'direct', appId: 'A1', botUserId: 'UBOT', teamId: 'T1',
    });

    const signingSecret = options.signingSecret ?? 'direct-install-signing-secret';
    const credentials = { state: stores.identity, keyring: loadCredentialKeyring() };
    const manifestFingerprint = slackManifestFingerprint(buildSlackAppManifest({
      kind: 'workspace_app',
      origin: options.origin ?? 'https://chickpea.example',
    }));
    const app = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
      purpose: 'app_credentials', expectedActiveRevision: null, appId: 'A1', manifestFingerprint,
      secrets: { clientId: '123.456', clientSecret: 'client-secret', signingSecret },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: app.revision, expectedActiveRevision: null,
    });
    const connected = await stageSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, identityClass: 'workspace_installation',
      purpose: 'connected_credentials', expectedActiveRevision: app.revision,
      appId: 'A1', teamId: 'T1', botUserId: 'UBOT', grantedScopes: ['chat:write'], validatedAt: Date.now(),
      manifestFingerprint,
      secrets: {
        clientId: '123.456', clientSecret: 'client-secret', signingSecret,
        botToken: options.botToken ?? 'xoxb-direct-install',
      },
    });
    await promoteSlackCredentialBundle(credentials, {
      identityId: WORKSPACE_SLACK_INSTALLATION_ID, candidateRevision: connected.revision,
      expectedActiveRevision: app.revision,
    });

    const calls: DirectSlackCall[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const method = new URL(request.url).pathname.split('/').at(-1)!;
      const body = new URLSearchParams(await request.clone().text().catch(() => ''));
      calls.push({ method, body });
      return Response.json(options.answer?.(method, body) ?? { ok: true }, {
        headers: { 'x-oauth-scopes': 'chat:write,users:read' },
      });
    }) as typeof fetch;

    const ingress = new Hono();
    ingress.route('/channels/slack', slackChannel.route());
    await run({
      stores,
      ownerMembershipId: owner.membership.id,
      calls,
      async deliver(kind, body, env) {
        const raw = kind === 'events'
          ? JSON.stringify(body)
          : new URLSearchParams({ payload: JSON.stringify(body) }).toString();
        const timestamp = String(Math.floor(Date.now() / 1_000));
        const signature = createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex');
        return ingress.request(`/channels/slack/${kind}`, {
          method: 'POST',
          headers: {
            'content-type': kind === 'events' ? 'application/json' : 'application/x-www-form-urlencoded',
            'x-slack-request-timestamp': timestamp,
            'x-slack-signature': `v0=${signature}`,
          },
          body: raw,
        }, env);
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    closeNodeStateStores();
    invalidateSlackInstallationCredentialCache();
    invalidateStoredSlackPublicUrl();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    rmSync(directory, { recursive: true, force: true });
  }
}
