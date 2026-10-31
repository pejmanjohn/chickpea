import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { SlackAgentViewPresentation } from '../src/slack/agent-view-presentation.ts';
import {
  followUpSignalBody, MID_RUN_REPLY_GUIDANCE, SLACK_REPLY_IN_THREAD_TOOL_NAME, type FoldedMessage,
} from '../src/slack/follow-ups.ts';
import {
  capMidRunReplyText, createMidRunReplyHandler, createSlackMidRunReplyTool, MAX_MIDRUN_REPLY_CHARS,
  MIDRUN_REPLY_SPACING_MS,
  type MidRunReadMessage, type MidRunReplyOutcome, type MidRunReplyRequest,
} from '../src/slack/midrun-reply.ts';
import { localSlackPresentationStatePort } from '../src/slack/presentation-state-port.ts';
import {
  SlackPresentationStateError, SlackRunPresentationStoreLogic, type SlackPresentationOwner,
} from '../src/slack/run-presentations.ts';
import { SlackStatusRegistry } from '../src/slack/status-registry.ts';
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const NOW = 1_800_000_000_000;
const ROOT = { workspaceId: 'T_REPLY', channelId: 'C_REPLY', threadTs: '1800000000.000100', requesterUserId: 'U_HEAD' };
const PERSONA = { name: 'Atlas', avatarUrl: 'https://example.test/atlas.png', avatarRevision: 2 };
const FIRST = '1800000010.000200';
const SECOND = '1800000020.000300';
const THIRD = '1800000030.000400';
const FOURTH = '1800000040.000500';

function tool(read: MidRunReadMessage[], outcome: MidRunReplyOutcome = { posted: true }) {
  const posts: MidRunReplyRequest[] = [];
  const reply = createSlackMidRunReplyTool({
    read: () => read,
    post: async (request) => {
      posts.push(request);
      return outcome;
    },
  });
  const run = async (messageTs: string, text: string) => (await reply.run({ data: { message_ts: messageTs, text } })).output;
  return { reply, posts, run };
}

/** A V3 run presentation, its Agent view and a presenter over a fake Slack client, as run-turn builds them. */
function host(owner: SlackPresentationOwner = { kind: 'selected_agent', persona: PERSONA }) {
  let clock = NOW;
  const db = openStateDb(':memory:');
  const presentations = new SlackRunPresentationStoreLogic(db, () => clock);
  presentations.create({
    runId: 'run_reply', turnJobId: 'head', bindingId: 'binding_reply', workBindingGeneration: 1,
    runFencingToken: 0, root: ROOT, schemaVersion: 3, owner, sessionGeneration: 1,
  });
  const posted: Record<string, unknown>[] = [];
  let fail = false;
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        if (fail) throw new Error('channel_not_found');
        posted.push(input);
        return { ok: true, ts: `1800000099.00${posted.length}` };
      },
    },
  } as unknown as WebClient;
  const view = new SlackAgentViewPresentation({
    client,
    state: localSlackPresentationStatePort({ presentations, matchFlueObservation: () => undefined }),
    runId: 'run_reply',
    runFencingToken: 0,
    footer: { agentName: PERSONA.name, agentId: 'agent_atlas' },
  });
  const presenter = new WebClientPresenter(client, {
    channelId: ROOT.channelId, threadTs: ROOT.threadTs, agentName: PERSONA.name,
    visibleOwner: owner, agentId: 'agent_atlas', modelLabel: 'Model', publicUrl: 'https://chickpea.test',
  });
  let counted = 0;
  const handler = createMidRunReplyHandler({
    presentation: view,
    post: (text) => presenter.postMidRunReply(text),
    onPosted: () => { counted += 1; },
    now: () => clock,
  });
  return {
    db, presentations, view, posted, handler,
    reply: (messageTs: string, text = 'The repo is acme/web.') => handler({ messageTs, text }),
    advance(ms: number) { clock += ms; },
    failSlack() { fail = true; },
    counted: () => counted,
    stored: () => {
      const presentation = presentations.get('run_reply');
      assert.ok(presentation?.schemaVersion === 3);
      return presentation.midRunReplies;
    },
  };
}

test('reply_in_thread answers a message this response read mid-run', async (t) => {
  await t.test('it posts the text for that message', async () => {
    const { posts, run } = tool([{ messageTs: FIRST }]);
    const output = await run(FIRST, 'The repo is acme/web.');
    assert.deepEqual(posts, [{ messageTs: FIRST, text: 'The repo is acme/web.' }]);
    assert.match(output, /^Posted in the thread\. Keep working; your final reply still answers the whole request\.$/);
  });

  await t.test('a message it did not read is refused, with the reason', async () => {
    const { posts, run } = tool([{ messageTs: FIRST }]);
    assert.match(await run(SECOND, 'Hi.'), /^Not posted: that ts is not a message that arrived while you worked\./);
    assert.deepEqual(posts, []);
  });

  await t.test('a message read for information only is refused', async () => {
    const { posts, run } = tool([{ messageTs: FIRST, informationOnly: true }]);
    assert.match(await run(FIRST, 'Hi.'), /^Not posted: that message is for information only, so do not answer it\./);
    assert.deepEqual(posts, []);
  });

  await t.test('long text is cut at a word, and the result says so', async () => {
    const { posts, run } = tool([{ messageTs: FIRST }]);
    const output = await run(FIRST, 'word '.repeat(200));
    const text = posts[0]!.text;
    assert.ok(Array.from(text).length <= MAX_MIDRUN_REPLY_CHARS);
    assert.match(text, /^(word )*word…$/, 'whole words, then an ellipsis');
    assert.match(output, /The reply was cut to 600 characters\.$/);
    assert.deepEqual(capMidRunReplyText('  short  '), { text: 'short', truncated: false });
  });

  await t.test('the host\'s refusal reaches the model by name', async () => {
    const { run } = tool([{ messageTs: FIRST }], { posted: false, refusal: 'too_soon' });
    assert.match(await run(FIRST, 'Hi.'), /^Not posted: replies need 20 seconds between them\./);
  });

  assert.equal(tool([]).reply.name, SLACK_REPLY_IN_THREAD_TOOL_NAME);
});

test('the host posts one threaded message as the Agent and records it on the run presentation', async () => {
  const h = host();
  try {
    assert.deepEqual(await h.reply(FIRST, 'The repo is **acme/web**.'), { posted: true });
    assert.equal(h.posted.length, 1);
    const [post] = h.posted;
    assert.equal(post!.channel, ROOT.channelId);
    assert.equal(post!.thread_ts, ROOT.threadTs, 'threaded under the request');
    assert.equal(post!.username, PERSONA.name, 'the final reply\'s sender');
    assert.equal(post!.icon_url, PERSONA.avatarUrl);
    assert.deepEqual(post!.blocks, [{ type: 'markdown', text: 'The repo is **acme/web**.' }], 'no footer, no files');
    assert.equal(post!.unfurl_links, false);
    assert.deepEqual(h.stored(), [{ messageTs: FIRST, at: NOW, posted: true }]);
    assert.equal(h.counted(), 1);
  } finally {
    h.db.close();
  }
});

test('an Agent with its own Slack app replies with no persona override', async () => {
  const h = host({ kind: 'agent_app', agentName: 'Atlas' });
  try {
    await h.reply(FIRST);
    assert.equal(h.posted[0]!.username, undefined);
    assert.equal(h.posted[0]!.icon_url, undefined);
  } finally {
    h.db.close();
  }
});

test('one reply per message, at most three, at least 20 seconds apart', async () => {
  const h = host();
  try {
    assert.deepEqual(await h.reply(FIRST), { posted: true });
    h.advance(MIDRUN_REPLY_SPACING_MS);
    assert.deepEqual(await h.reply(FIRST), { posted: false, refusal: 'answered' });
    assert.deepEqual(await h.reply(SECOND), { posted: true });
    h.advance(MIDRUN_REPLY_SPACING_MS - 1);
    assert.deepEqual(await h.reply(THIRD), { posted: false, refusal: 'too_soon' });
    h.advance(1);
    assert.deepEqual(await h.reply(THIRD), { posted: true });
    h.advance(MIDRUN_REPLY_SPACING_MS);
    assert.deepEqual(await h.reply(FOURTH), { posted: false, refusal: 'limit' });
    assert.equal(h.posted.length, 3);
    assert.equal(h.stored()?.filter((reply) => reply.posted).length, 3);
  } finally {
    h.db.close();
  }
});

test('a reply Slack refuses keeps its place and is not counted as posted', async () => {
  const h = host();
  try {
    h.failSlack();
    assert.deepEqual(await h.reply(FIRST), { posted: false, refusal: 'failed' });
    assert.deepEqual(h.stored(), [{ messageTs: FIRST, at: NOW }]);
    assert.equal(h.counted(), 0);
    h.advance(MIDRUN_REPLY_SPACING_MS);
    assert.deepEqual(await h.reply(FIRST), { posted: false, refusal: 'answered' }, 'never posted twice');
  } finally {
    h.db.close();
  }
});

test('the store refuses a reply once the final is under way, and a second record of one message', async () => {
  const h = host();
  try {
    await h.view.reserveMidRunReply(FIRST);
    await assert.rejects(h.view.reserveMidRunReply(FIRST),
      (error) => error instanceof SlackPresentationStateError && error.code === 'identity_conflict');
    const presentation = h.presentations.get('run_reply')!;
    h.presentations.transition({
      runId: 'run_reply', workBindingGeneration: 1, runFencingToken: 0,
      expectedProjectionVersion: presentation.projectionVersion, expectedStreamState: presentation.stream.state,
      mutation: { kind: 'record_terminal_delivery_intent', operationId: 'final_1', result: 'answer' },
    });
    await assert.rejects(h.view.reserveMidRunReply(SECOND),
      (error) => error instanceof SlackPresentationStateError && error.code === 'terminal_rewrite');
  } finally {
    h.db.close();
  }
});

test('the live turn posts replies until its final starts, and the final waits for one in flight', async () => {
  const registry = new SlackStatusRegistry();
  const order: string[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const turn = registry.registerTurn('instance_reply', { setStatus: async () => true }, {
    generation: 'gen_reply',
    midRunReply: async () => {
      await held;
      order.push('reply');
      return { posted: true };
    },
  });
  const request = { messageTs: FIRST, text: 'Hi.' };
  assert.deepEqual(await registry.midRunReply('instance_reply', 'gen_other', request),
    { posted: false, refusal: 'unavailable' }, 'another turn\'s generation reaches nothing');
  const reply = registry.midRunReply('instance_reply', 'gen_reply', request);
  await new Promise((resolve) => setImmediate(resolve));
  const final = turn.prepareFinal().then(() => { order.push('final'); });
  release!();
  assert.deepEqual(await reply, { posted: true });
  await final;
  assert.deepEqual(order, ['reply', 'final']);
  assert.deepEqual(await registry.midRunReply('instance_reply', 'gen_reply', request),
    { posted: false, refusal: 'final_started' });
  turn.close();

  const bare = registry.registerTurn('instance_bare', { setStatus: async () => true }, { generation: 'gen_bare' });
  assert.deepEqual(await registry.midRunReply('instance_bare', 'gen_bare', request),
    { posted: false, refusal: 'unavailable' }, 'a turn with no presentation posts nothing');
  bare.close();
});

test('a fold read after a tool batch tells the model it may answer now', () => {
  const messages: FoldedMessage[] = [{ turnJobId: 'late', userId: 'U_TEAM', messageTs: FIRST, text: 'Which repo?' }];
  const body = (phase: 'turn' | 'finish', informationOnly?: true) => followUpSignalBody({
    messages: messages.map((message) => ({ ...message, ...(informationOnly ? { informationOnly } : {}) })),
    requesterId: 'U_HEAD', timezone: 'UTC', envelope: '<envelope/>', phase,
  });
  assert.ok(body('turn').split('\n\n').includes(MID_RUN_REPLY_GUIDANCE));
  assert.ok(MID_RUN_REPLY_GUIDANCE.includes(SLACK_REPLY_IN_THREAD_TOOL_NAME));
  assert.match(MID_RUN_REPLY_GUIDANCE, /Do not post progress updates unless someone in this thread asked for one\./);
  assert.ok(!body('turn', true).includes(MID_RUN_REPLY_GUIDANCE), 'nothing to answer in an information-only fold');
  assert.ok(!body('finish').includes(MID_RUN_REPLY_GUIDANCE), 'about to reply: the reply answers it');
});
