import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRIVATE_CHANNEL_SETUP_ADD_ACTION,
  PRIVATE_CHANNEL_SETUP_AGENT_ACTION,
  PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK,
} from '../src/slack/private-channel-setup.ts';
import { withDirectSlackInstall, type DirectSlackCall, type DirectSlackInstall } from './helpers/direct-slack-install.ts';

const ORIGIN = 'https://chickpea.example';
const CONFIRMATION = 'Added @ops to this private channel. Mention @ops to start a conversation.';

type Block = { type: string; text?: { type: string; text: string }; elements?: Array<Record<string, any>> };

/** Slack as one private channel C1 sees it, with how the next response_url POST answers. */
interface SlackScene {
  members: string[];
  replace: 'ok' | 'refused' | 'unreachable';
  channelLookupFails: boolean;
}

/**
 * A direct install whose owner U1 invites Chickpea to private channel C1 and
 * gets the setup card, with the given Agents (each the owner's, off Slack).
 */
async function withPrivateSetup(
  agents: ReadonlyArray<{ id: string; name: string; handle: string }>,
  run: (setup: DirectSlackInstall & { scene: SlackScene; setupId: string }) => Promise<void>,
): Promise<void> {
  const scene: SlackScene = { members: ['U1', 'UBOT'], replace: 'ok', channelLookupFails: false };
  const groups: Array<Record<string, unknown>> = [];
  await withDirectSlackInstall({
    answer: (method, body, url) => {
      if (url.startsWith('https://hooks.slack.com/')) {
        if (scene.replace === 'unreachable') throw new TypeError('fetch failed');
        return scene.replace === 'ok' ? { ok: true } : { ok: false, error: 'expired_url' };
      }
      if (method === 'users.info') return { ok: true, user: slackUser(body.get('user') ?? '') };
      if (method === 'conversations.info') {
        if (scene.channelLookupFails) return { ok: false, error: 'fatal_error' };
        return { ok: true, channel: { id: body.get('channel'), name: 'private-lab', is_private: true, is_member: true, is_archived: false } };
      }
      if (method === 'conversations.members') return { ok: true, members: scene.members };
      if (method === 'usergroups.list') return { ok: true, usergroups: groups };
      if (method === 'usergroups.create') {
        const group = { id: `S${groups.length + 1}`, name: body.get('name'), handle: body.get('handle'), date_delete: 0 };
        groups.push(group);
        return { ok: true, usergroup: group };
      }
      if (method === 'usergroups.update') {
        const group = groups.find(({ id }) => id === body.get('usergroup'));
        if (group) Object.assign(group, Object.fromEntries(body));
        return { ok: true, usergroup: group };
      }
      return undefined;
    },
  }, async (install) => {
    process.env.SLACK_TAG_PUBLIC_URL = ORIGIN;
    for (const agent of agents) {
      await install.stores.config.createAgent({
        id: agent.id, name: agent.name, instructions: 'Help.', enabled: true, lifecycle: 'active',
        creatorMembershipId: install.ownerMembershipId, editPolicy: 'creator_and_admins',
        skills: [], mcpServers: [], apiConnections: [], repositories: [],
        slackPresence: { requestedHandle: agent.handle, normalizedHandle: agent.handle, desiredState: 'unpublished',
          health: 'unpublished', avatar: { kind: 'generated', revision: 1, seed: agent.handle } },
      });
    }
    const now = Math.floor(Date.now() / 1_000);
    assert.equal((await install.deliver('events', {
      type: 'event_callback', event_id: 'EvInvite', event_time: now, team_id: 'T1', api_app_id: 'A1',
      authorizations: [{ team_id: 'T1', user_id: 'UBOT', is_bot: true, is_enterprise_install: false }],
      event: { type: 'member_joined_channel', user: 'UBOT', channel: 'C1', channel_type: 'G', team: 'T1',
        inviter: 'U1', event_ts: `${now}.000100` },
    })).status, 200);
    const card = await eventually(() => install.calls.find(({ method }) => method === 'chat.postEphemeral'));
    assert.ok(card, 'the invitation posts the setup card');
    const setupId = buttons(blocksOf(card)).find(({ action_id }) => action_id === PRIVATE_CHANNEL_SETUP_ADD_ACTION)?.value;
    assert.ok(setupId);
    await run({ ...install, scene, setupId });
  });
}

function slackUser(id: string) {
  return {
    id, team_id: 'T1', name: id, deleted: false, is_bot: false, is_app_user: false,
    is_restricted: false, is_ultra_restricted: false, is_stranger: false,
  };
}

let clicks = 0;

/** A signed click on the inviter's ephemeral card, with a fresh response_url unless told otherwise. */
function addClick(setupId: string, agentId: string | null, options: { responseUrl?: string | null } = {}) {
  clicks += 1;
  const responseUrl = options.responseUrl === undefined
    ? `https://hooks.slack.com/actions/T1/18000000${clicks}/click${clicks}`
    : options.responseUrl;
  return {
    responseUrl,
    payload: {
      type: 'block_actions', api_app_id: 'A1', team: { id: 'T1' }, user: { id: 'U1' }, channel: { id: 'C1' },
      container: { type: 'message', channel_id: 'C1', message_ts: '1800000000.000100', is_ephemeral: true },
      ...(responseUrl ? { response_url: responseUrl } : {}),
      actions: [{ type: 'button', action_id: PRIVATE_CHANNEL_SETUP_ADD_ACTION, value: setupId,
        action_ts: `1800000001.00${String(clicks).padStart(4, '0')}` }],
      state: { values: { [PRIVATE_CHANNEL_SETUP_CHOICE_BLOCK]: { [PRIVATE_CHANNEL_SETUP_AGENT_ACTION]: {
        type: 'static_select', selected_option: agentId === null ? null : { value: agentId },
      } } } },
    },
  };
}

function replacements(calls: DirectSlackCall[], responseUrl?: string | null) {
  return calls.filter(({ url }) => url === responseUrl)
    .map(({ raw }) => JSON.parse(raw) as { replace_original?: boolean; text: string; blocks: Block[] });
}

function ephemerals(calls: DirectSlackCall[]) {
  return calls.filter(({ method }) => method === 'chat.postEphemeral');
}

function blocksOf(call: DirectSlackCall): Block[] {
  return JSON.parse(call.body.get('blocks') ?? '[]') as Block[];
}

function buttons(blocks: Block[]): Array<Record<string, any>> {
  return blocks.flatMap(({ elements }) => elements ?? []).filter(({ type }) => type === 'button');
}

async function eventually<T>(read: () => T | undefined): Promise<T | undefined> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

/** Wait until Slack has heard nothing new for a while, so an absence means something. */
async function quiet(calls: DirectSlackCall[]): Promise<void> {
  let seen = -1;
  for (let attempt = 0; attempt < 40 && seen !== calls.length; attempt += 1) {
    seen = calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const OPS = { id: 'agent_ops', name: 'Ops', handle: 'ops' };

test('Add replaces the card in place with the confirmation, through the click\'s own response_url', async () => {
  await withPrivateSetup([OPS], async ({ calls, deliver, stores, setupId }) => {
    const click = addClick(setupId, OPS.id);
    assert.equal((await deliver('interactions', click.payload)).status, 200);
    const [replaced] = await eventually(() => {
      const found = replacements(calls, click.responseUrl);
      return found.length ? found : undefined;
    }) ?? [];
    assert.ok(replaced, 'the card is replaced');
    assert.equal(replaced.replace_original, true);
    assert.equal(replaced.text, CONFIRMATION);
    assert.equal(replaced.blocks[0]?.text?.text, CONFIRMATION);
    assert.deepEqual(buttons(replaced.blocks).map(({ url }) => url), [`${ORIGIN}/admin/agents`]);
    const post = calls.find(({ url }) => url === click.responseUrl)!;
    assert.equal(new URL(post.url).origin, 'https://hooks.slack.com');
    await quiet(calls);
    assert.equal(ephemerals(calls).length, 1, 'only the original card was posted; the result replaced it');
    assert.equal((await stores.config.listAgentChannelGrants('T1', 'C1'))[0]?.status, 'active');
  });
});

test('Add with nothing chosen answers beside the card and leaves it in place', async () => {
  await withPrivateSetup([OPS], async ({ calls, deliver, setupId }) => {
    const click = addClick(setupId, null);
    await deliver('interactions', click.payload);
    const notice = await eventually(() => ephemerals(calls)[1]);
    assert.equal(notice?.body.get('text'), 'Choose an Agent in the setup card, then click Add.');
    assert.equal(notice?.body.get('blocks'), null);
    await quiet(calls);
    assert.deepEqual(replacements(calls, click.responseUrl), [], 'the card stays usable');
  });
});

test('a confirmation Slack will not take falls back to a text-only ephemeral line', async () => {
  for (const failure of ['refused', 'unreachable'] as const) {
    await withPrivateSetup([OPS], async ({ calls, deliver, scene, setupId }) => {
      scene.replace = failure;
      const click = addClick(setupId, OPS.id);
      await deliver('interactions', click.payload);
      const fallback = await eventually(() => ephemerals(calls)[1]);
      assert.equal(replacements(calls, click.responseUrl).length, 1, `${failure}: the replace was tried once`);
      assert.equal(fallback?.body.get('text'), CONFIRMATION, failure);
      assert.equal(fallback?.body.get('blocks'), null, `${failure}: the fallback is text only`);
      assert.equal(fallback?.body.get('user'), 'U1');
    });
  }
});

test('a click without a usable response_url gets today\'s ephemeral line', async () => {
  await withPrivateSetup([OPS], async ({ calls, deliver, setupId }) => {
    const click = addClick(setupId, OPS.id, { responseUrl: 'https://example.com/actions/T1/1/x' });
    await deliver('interactions', click.payload);
    const line = await eventually(() => ephemerals(calls)[1]);
    assert.equal(line?.body.get('text'), CONFIRMATION);
    assert.equal(line?.body.get('blocks'), null);
    assert.equal(calls.some(({ url }) => url === click.responseUrl), false, 'an unvalidated URL is never called');
  });
});

test('an expired card is replaced with the expired text', async () => {
  await withPrivateSetup([OPS], async ({ calls, deliver, setupId }) => {
    const click = addClick(setupId, OPS.id);
    const originalNow = Date.now;
    const later = Date.now() + 31 * 60_000;
    Date.now = () => later;
    try {
      await deliver('interactions', click.payload);
      const [replaced] = await eventually(() => {
        const found = replacements(calls, click.responseUrl);
        return found.length ? found : undefined;
      }) ?? [];
      assert.match(replaced?.text ?? '', /^This setup card has expired\. Open Chickpea to add an Agent to this channel\./);
      assert.equal(replaced?.blocks[0]?.text?.type, 'mrkdwn');
      assert.match(replaced?.blocks[0]?.text?.text ?? '', /<https:\/\/chickpea\.example\/admin\/agents\|Open Chickpea>/);
    } finally {
      Date.now = originalNow;
    }
  });
});

test('an unexpected failure before the claim answers beside the card, which still works afterwards', async () => {
  await withPrivateSetup([OPS], async ({ calls, deliver, scene, stores, setupId }) => {
    scene.channelLookupFails = true;
    const failed = addClick(setupId, OPS.id);
    await deliver('interactions', failed.payload);
    const notice = await eventually(() => ephemerals(calls)[1]);
    assert.match(notice?.body.get('text') ?? '', /^This setup could not finish\./);
    await quiet(calls);
    assert.deepEqual(replacements(calls, failed.responseUrl), [], 'the card is not replaced');
    assert.deepEqual(await stores.config.listAgentChannelGrants('T1', 'C1'), []);

    scene.channelLookupFails = false;
    const retry = addClick(setupId, OPS.id);
    await deliver('interactions', retry.payload);
    const [replaced] = await eventually(() => {
      const found = replacements(calls, retry.responseUrl);
      return found.length ? found : undefined;
    }) ?? [];
    assert.equal(replaced?.text, CONFIRMATION, 'the same card adds the Agent on the next click');
  });
});
