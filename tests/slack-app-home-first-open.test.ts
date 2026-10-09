import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { processGatewaySlackEnvelope } from '../src/channels/slack.ts';
import { closeNodeStateStores, resolveStores, type AppStores } from '../src/config/state-backend.ts';
import type { GatewayDeploymentClient } from '../src/slack/gateway/client.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { createSlackOwner } from './helpers/slack-owner.ts';

const FIRST_PROMPTS = [
  { title: 'Create my first Agent', message: 'Help me create my first Agent. Ask me what my team works on.' },
  { title: 'Ideas for my team', message: 'What kinds of Agents could help my team?' },
  { title: 'Connect a tool', message: 'Which tools can my Agents connect to?' },
];

interface Harness {
  stores: AppStores;
  calls: Array<{ operation: string; input: Record<string, unknown> }>;
  warnings: unknown[][];
  /** Slack's app_home_opened for `user`, through the shared gateway. */
  open(user: string, tab: string): Promise<void>;
  /** Introductions now due, claimed for delivery. */
  dueIntroductions(): Promise<unknown[]>;
}

async function withGatewayInstallation(
  t: TestContext,
  options: { refusePrompts?: string } = {},
): Promise<Harness> {
  const keys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = ':memory:';
  closeNodeStateStores();
  const warn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  t.after(() => {
    console.warn = warn;
    closeNodeStateStores();
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  });
  const stores = resolveStores();
  await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
  await stores.config.ensureWorkspaceInstallation({
    workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT', gatewayBindingId: 'binding1',
  });
  const calls: Harness['calls'] = [];
  const gateway = {
    workspaceId: 'T1',
    async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
    async call(operation: string, input: Record<string, unknown>) {
      calls.push({ operation, input });
      if (operation === 'users.info') {
        return { user: {
          id: input.user, team_id: 'T1', name: String(input.user), deleted: false, is_bot: false,
          is_app_user: false, is_restricted: input.user === 'UGUEST', is_ultra_restricted: false, is_stranger: false,
        } };
      }
      if (operation === 'assistant.threads.setSuggestedPrompts' && options.refusePrompts) {
        throw new SlackTransportError(operation, options.refusePrompts, { effectOutcome: 'failed' });
      }
      if (operation === 'assistant.threads.setSuggestedPrompts' || operation === 'views.publish') return {};
      if (operation === 'users.conversations') return { channels: [] };
      throw new Error(`Unexpected gateway operation: ${operation}`);
    },
  } as unknown as GatewayDeploymentClient;
  let events = 0;
  return {
    stores,
    calls,
    warnings,
    async open(user, tab) {
      events += 1;
      assert.equal(await processGatewaySlackEnvelope({
        workspaceId: 'T1', eventId: `EvHome${events}`, eventTime: 1_800_000_000 + events,
        event: { type: 'app_home_opened', user, channel: `D_${user}`, tab, event_ts: `1800000000.00000${events}` },
      }, undefined, gateway, { stores }), 'accepted');
    },
    async dueIntroductions() {
      const now = Date.now();
      return (await stores.management.claimDueOutbox(now + 1, 10, now + 30_000))
        .map(({ destination, receipt }) => ({ destination, receipt }));
    },
  };
}

const ofOperation = (h: Harness, operation: string) =>
  h.calls.filter((call) => call.operation === operation).map(({ input }) => input);

test('opening the Messages tab offers the first prompts and greets a member once', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.open('U1', 'messages');
  await h.open('U1', 'messages');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_U1', prompts: FIRST_PROMPTS },
    { channel_id: 'D_U1', prompts: FIRST_PROMPTS },
  ], 'every Messages open sets the prompts for the whole DM, never one thread');
  assert.deepEqual(await h.dueIntroductions(), [{
    destination: { kind: 'slack_dm', workspaceId: 'T1', slackUserId: 'U1' },
    receipt: { kind: 'chickpea_introduction', trigger: 'first_interaction' },
  }]);
  assert.equal(ofOperation(h, 'views.publish').length, 2);
  assert.deepEqual(h.warnings, []);
});

test('opening the Home tab offers no prompts and greets nobody', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.open('U1', 'home');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), []);
  assert.deepEqual(await h.dueIntroductions(), []);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
});

test('a guest opening the Messages tab gets the prompts but no introduction', async (t) => {
  const h = await withGatewayInstallation(t);
  await h.open('UGUEST', 'messages');
  assert.deepEqual(ofOperation(h, 'assistant.threads.setSuggestedPrompts'), [
    { channel_id: 'D_UGUEST', prompts: FIRST_PROMPTS },
  ]);
  assert.deepEqual(await h.dueIntroductions(), []);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
});

test('an app with static prompts refuses them quietly; the App Home and the introduction still go out', async (t) => {
  const h = await withGatewayInstallation(t, { refusePrompts: 'static_prompts_configured' });
  await h.open('U1', 'messages');
  assert.equal(ofOperation(h, 'assistant.threads.setSuggestedPrompts').length, 1);
  assert.equal(ofOperation(h, 'views.publish').length, 1);
  assert.equal((await h.dueIntroductions()).length, 1);
  assert.deepEqual(h.warnings, [], 'every standalone app made with static prompts answers this');
});

test('any other refusal of the prompts is logged by its code alone and blocks nothing', async (t) => {
  const h = await withGatewayInstallation(t, { refusePrompts: 'channel_not_found' });
  await h.open('U1', 'messages');
  assert.equal(ofOperation(h, 'views.publish').length, 1);
  assert.equal((await h.dueIntroductions()).length, 1);
  assert.deepEqual(h.warnings, [['[chickpea] Slack suggested prompts refused:', 'channel_not_found']]);
});
