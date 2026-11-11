import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { CHICKPEA_AGENT_ID } from '../src/config/agent-id.ts';
import { DM, WORKER_MENTION, withDirectWorker, type DirectWorker } from './helpers/direct-worker.ts';

/**
 * A direct installation's delivery is admitted by processSlackEvent over the
 * state store's RPCs (the Worker's path), on the store's own ports
 * (processDirectSlackEvent), or by the store itself when the Worker sends it
 * there (CHICKPEA_SLACK_ADMISSION=store, TagStateStore.admitSlackDelivery). Each scenario runs on identical
 * installations, one per way, and must end the same: the same turns, claims,
 * threads and thread record, and the same Slack calls. The local run makes no
 * call over RPC, and the store's run makes only the Worker's one call.
 */

const THREAD_REPLY = { ...DM, ts: '6000.000200', thread_ts: DM.ts, text: 'and since Monday?' };
const MENTION_AS_MESSAGE = { ...WORKER_MENTION, type: 'message', channel_type: 'channel' };
const UNADDRESSED = { type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', ts: '5000.000300', text: 'lunch?' };
const EDITED_DM = {
  type: 'message', subtype: 'message_changed', channel: 'D1', channel_type: 'im',
  message: { type: 'message', user: 'U1', ts: DM.ts, text: 'hello again', edited: { user: 'U1', ts: '6000.000300' } },
  previous_message: { type: 'message', user: 'U1', ts: DM.ts, text: DM.text },
};
const BOT_POST = { ...DM, ts: '6000.000400', text: 'an answer', bot_id: 'BBOT', user: 'UBOT' };
const DELETED_REPLY = {
  type: 'message', subtype: 'message_deleted', channel: 'D1', channel_type: 'im', ts: '6000.000500',
  deleted_ts: THREAD_REPLY.ts,
  previous_message: { type: 'message', user: 'U1', ts: THREAD_REPLY.ts, thread_ts: DM.ts, text: THREAD_REPLY.text },
};

/** The workspace's model cannot resolve: admission asks Slack itself whether the sender may be answered. */
function withoutWorkspaceModel(worker: DirectWorker): void {
  worker.db.run("DELETE FROM config_workspace_model_defaults WHERE workspace_id = 'T1'");
  worker.stores.config.updateWorkspaceInstallation('T1', { runtimeContract: 'chickpea-v1' });
}

/**
 * Each scenario's deliveries in order; `again` repeats the previous delivery
 * as Slack's retry does. A function changes the installation before them.
 */
const SCENARIOS: Array<[string, Array<Record<string, unknown> | 'again' | ((worker: DirectWorker) => void)>]> = [
  ['a DM', [DM]],
  ['a mention of the app in a Channel', [WORKER_MENTION]],
  ['one mention delivered as app_mention and as message', [WORKER_MENTION, MENTION_AS_MESSAGE]],
  ['a DM Slack delivers twice', [DM, 'again']],
  ['a reply in the DM thread', [DM, THREAD_REPLY]],
  ['an unaddressed Channel message', [UNADDRESSED]],
  ["an edit of a DM whose turn is queued", [DM, EDITED_DM]],
  ["the bot's own post", [BOT_POST]],
  ["a DM when the workspace's model cannot resolve", [withoutWorkspaceModel, DM]],
];

type Port = 'rpc' | 'local' | 'store';

/** Chickpea's DM thread with the person, and its first message, in the record. */
function withChickpeaThread(worker: DirectWorker): void {
  const agent = worker.stores.config.getAgent(CHICKPEA_AGENT_ID)!;
  worker.stores.config.putAgentThreadRoute({
    workspaceId: 'T1', channelId: 'D1', threadTs: DM.ts, agentId: agent.id,
    agentGeneration: agent.configurationGeneration ?? agent.revision,
  });
  worker.stores.config.putSlackPublicContext({
    workspaceId: 'T1', channelId: 'D1', rootTs: DM.ts, messageTs: DM.ts, role: 'human', text: DM.text, authorId: 'U1',
  });
}

async function admitted(
  t: TestContext,
  port: Port,
  deliveries: (typeof SCENARIOS)[number][1],
  options: { credentials?: 'app' } = {},
) {
  let result: Record<string, unknown> = {};
  await withDirectWorker(t, async (worker) => {
    let previous: Record<string, unknown> | undefined;
    for (const delivery of deliveries) {
      if (typeof delivery === 'function') {
        delivery(worker);
        continue;
      }
      const body = delivery === 'again' ? previous! : worker.event(delivery);
      previous = body;
      await admit(worker, port, body);
    }
    const rpcs = worker.log.filter((entry) => entry.startsWith('rpc:'));
    if (port === 'local') assert.deepEqual(rpcs, [], 'admission on local ports never calls the store over RPC');
    if (port === 'store') {
      // A standalone Worker reads its credential bundle, and the installation beside it, to check the signature.
      const admission = rpcs.filter((entry) => !['rpc:identityExecute', 'rpc:configGetWorkspaceInstallation'].includes(entry));
      assert.deepEqual(admission, Array(deliveries.filter((delivery) => typeof delivery !== 'function').length)
        .fill('rpc:admitSlackDelivery'), 'past the signature, the Worker makes one call per delivery, and the store none');
    }
    result = outcome(worker);
  }, { ...options, ...port === 'store' ? { env: { CHICKPEA_SLACK_ADMISSION: 'store', SLACK_THREAD_RUNNER: undefined } } : {} });
  return result;
}

async function admit(worker: DirectWorker, port: Port, body: Record<string, unknown>): Promise<void> {
  if (port === 'local') {
    await worker.admitLocally(body);
    return;
  }
  const kept: Array<Promise<unknown>> = [];
  const response = await worker.deliver(body, { waitUntil: (promise) => { kept.push(promise); }, passThroughOnException() {}, props: {} });
  assert.equal(response.status, 200);
  await Promise.all(kept);
}

/** What admission left behind, without the clocks. */
function outcome(worker: DirectWorker) {
  const rows = (sql: string) => worker.db.all(sql);
  return {
    turns: rows('SELECT id, evt_key, msg_key, turn_json, assignment_json, execution_authority, status, thread_key, message_ts FROM turn_jobs ORDER BY id')
      .map((row) => {
        const turn = JSON.parse(String(row.turn_json)) as Record<string, unknown>;
        const assignment = JSON.parse(String(row.assignment_json)) as { agentId?: unknown; model?: unknown };
        return {
          id: row.id, evtKey: row.evt_key, msgKey: row.msg_key, authority: row.execution_authority, status: row.status,
          threadKey: row.thread_key, messageTs: row.message_ts,
          text: turn.text, source: turn.source, channelId: turn.channelId, threadTs: turn.threadTs,
          actorIsMember: typeof turn.actorMembershipId === 'string', agentId: assignment.agentId, model: assignment.model,
        };
      }),
    claims: rows('SELECT key FROM slack_claims ORDER BY key').map((row) => row.key),
    threads: rows('SELECT key FROM slack_threads ORDER BY key').map((row) => row.key),
    activeWork: rows('SELECT key, generation FROM slack_active_work ORDER BY key, generation'),
    record: rows(`SELECT channel_id, root_ts, message_ts, role, text, agent_id, author_kind, author_id
      FROM config_slack_public_context ORDER BY channel_id, root_ts, message_ts`),
    slack: worker.log.filter((entry) => entry.startsWith('slack:')).sort(),
    failures: worker.failures,
  };
}

// Defects caught: a direct execution refused as if it were the gateway's
// (nothing admitted on local ports), a direct execution's credentials dropped
// (admission cannot ask Slack about the sender when the model does not
// resolve), a direct branch that reaches the store over RPC from inside it,
// and any admission outcome that differs between the two ports.
for (const [name, deliveries] of SCENARIOS) {
  test(`${name}: admitted on the state store's own ports and by the store as over its RPCs`, async (t) => {
    const overRpc = await admitted(t, 'rpc', deliveries);
    assert.deepEqual(await admitted(t, 'local', deliveries), overRpc, 'on local ports');
    assert.deepEqual(await admitted(t, 'store', deliveries), overRpc, 'by the store');
  });
}

// Defect caught: the comparison passing because neither port admitted anything.
test('the scenarios admit turns and leave their record', async (t) => {
  const outcome = await admitted(t, 'local', [DM, THREAD_REPLY]) as { turns: unknown[]; record: unknown[]; failures: unknown[] };
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.turns.length, 2, 'the DM and its reply each became a turn');
});

// Defect caught (Fable review, finding 8): with no bot token the store doing
// nothing, where the Worker's chain still keeps the thread record (a reply
// recorded, a delete removed) before it stops for want of a bot.
test('with no bot token, the record follows a reply and a delete in the store as over its RPCs', async (t) => {
  const deliveries = [withChickpeaThread, THREAD_REPLY, DELETED_REPLY, EDITED_DM];
  const overRpc = await admitted(t, 'rpc', deliveries, { credentials: 'app' }) as { turns: unknown[]; record: Array<{ text: unknown }> };
  assert.deepEqual(overRpc.turns, [], 'nothing is admitted without a bot');
  assert.deepEqual(overRpc.record.map(({ text }) => text), ['hello again'], "the reply came and went; the edit changed the first message's text");
  assert.deepEqual(await admitted(t, 'local', deliveries, { credentials: 'app' }), overRpc, 'on local ports');
  assert.deepEqual(await admitted(t, 'store', deliveries, { credentials: 'app' }), overRpc, 'by the store');
});
