import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as v from 'valibot';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { managementOperationValibotSchema, managementOperationZodSchema } from '../src/management/schemas.ts';
import type { WorkspaceManagementServiceInput } from '../src/management/service.ts';
import type { ManagementOperation } from '../src/management/types.ts';
import { authorityFixture, chickpeaDm, createAgent, type Person } from './helpers/management-authority-fixture.ts';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any> & { error?: Record<string, unknown> };
  isError?: boolean;
};

const THREAD_TS = '1800000000.000100';

/** Slack as a DM schedule made over MCP sees it: what opened, what was posted, what was taken back. */
function fakeSlack(options: { openFails?: boolean } = {}) {
  const calls = {
    opened: [] as string[],
    started: [] as Array<{ conversationId: string; agent: string; text: string }>,
    withdrawn: [] as Array<{ conversationId: string; threadTs: string }>,
  };
  /** What changes between the first message and the save. */
  const hooks: { afterStart?: () => Promise<unknown> } = {};
  const threads: NonNullable<WorkspaceManagementServiceInput['directScheduleThreads']> = {
    async open({ slackUserId }) {
      calls.opened.push(slackUserId);
      if (options.openFails) throw new Error('slack down');
      return `D_${slackUserId}`;
    },
    async start({ conversationId, agent, text }) {
      calls.started.push({ conversationId, agent: agent.name, text });
      await hooks.afterStart?.();
      return THREAD_TS;
    },
    async withdraw({ conversationId, threadTs }) {
      calls.withdrawn.push({ conversationId, threadTs });
    },
  };
  return { calls, hooks, threads };
}

/**
 * One workspace whose routines and config share a state database, as a
 * deployment's do. The member created the Agent, which is in no Channel, so
 * only they may DM it; the Owner may edit it but not DM it.
 */
async function harness(t: TestContext, suffix: string, slack = fakeSlack()) {
  const f = await authorityFixture(suffix, { directScheduleThreads: slack.threads });
  t.after(() => f.close());
  await createAgent(f, f.member, 'agent_research', { name: 'Research' });
  const as = (person: Person, role: 'owner' | 'member') => {
    const principal: McpAuthenticatedPrincipal = {
      betterAuthUserId: person.binding.betterAuthUserId ?? `ba_${role}`,
      userId: person.user.id,
      membershipId: person.membership.id,
      organizationId: person.membership.organizationId,
      role,
      clientId: `client_${suffix}`,
    };
    const handler = createMcpHandler(
      () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
      { legacy: 'stateless' },
    );
    return async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
      const response = await handler.fetch(new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }));
      const body = await response.text();
      assert.equal(response.status, 200, body);
      const json = body.trimStart().startsWith('{')
        ? body
        : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
      return (JSON.parse(json) as { result: ToolResult }).result;
    };
  };
  return { f, slack, member: as(f.member, 'member'), owner: as(f.owner, 'owner'), teamId: f.workspaceId };
}

function structured(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent, JSON.stringify(result));
  return result.structuredContent;
}

function errorOf(result: ToolResult, code: string): Record<string, unknown> {
  assert.equal(result.isError, true, JSON.stringify(result));
  const error = result.structuredContent?.error;
  assert.ok(error, JSON.stringify(result));
  assert.equal(error.code, code, JSON.stringify(error));
  return error;
}

const DM_SCHEDULE = {
  agentId: 'agent_research',
  dm: 'me',
  name: 'Morning check',
  task: 'Summarize what changed overnight.',
  when: { cron: '0 9 * * 1-5' },
  timezone: 'UTC',
  post: 'always',
  requiredConnections: [],
};

test('save_schedule with dm "me" posts in the caller\'s own DM, in a thread its Agent starts and answers in', async (t) => {
  const { f, slack, member, owner, teamId } = await harness(t, 'dm-create');
  const dm = `D_${f.member.user.slackUserId}`;

  const created = structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'dm-create' }));
  assert.equal(created.status, 'done');
  assert.equal(created.summary, 'Created the schedule. Every run posts in one thread in your DM with Research, which it just started.');
  assert.deepEqual(slack.calls.opened.at(-1), f.member.user.slackUserId, 'the DM is the signed-in person\'s own');
  assert.deepEqual(slack.calls.started, [{
    conversationId: dm,
    agent: 'Research',
    text: 'I\'ll post *Morning check* in this thread when it runs.',
  }]);

  const [routine, ...others] = await f.routines.listRoutines(teamId, dm);
  assert.deepEqual(others, []);
  assert.deepEqual(routine?.destination, {
    kind: 'direct_thread',
    conversationId: dm,
    threadTs: THREAD_TS,
    ownerMembershipId: f.member.membership.id,
  });
  assert.equal(routine.state, 'active');
  assert.equal((await f.config.getAgentThreadRoute(teamId, dm, THREAD_TS))?.agentId, 'agent_research',
    'a reply in the thread goes to the Agent');

  const [listed, ...more] = structured(await member('list_schedules', {})).schedules;
  assert.deepEqual(more, []);
  assert.deepEqual(listed.where, { kind: 'dm', label: 'your DM with Research' });
  assert.equal(listed.runsAs.you, true);
  assert.equal(listed.version, created.version);
  assert.deepEqual(structured(await member('list_schedules', { scheduleId: listed.scheduleId })).schedules[0].where,
    { kind: 'dm', label: 'your DM with Research' });
  assert.deepEqual(structured(await owner('list_schedules', {})).schedules, [], 'nobody else sees it, an Owner included');

  const again = structured(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'dm-create' }));
  assert.equal(again.version, created.version);
  assert.equal(slack.calls.started.length, 1, 'a retry starts no second thread');

  const edited = structured(await member('save_schedule', {
    ...DM_SCHEDULE,
    dm: undefined,
    scheduleId: listed.scheduleId,
    version: listed.version,
    task: 'Summarize what changed overnight, newest first.',
    when: { keep: true },
    idempotencyKey: 'dm-edit',
  }));
  assert.equal(edited.summary, 'Saved the schedule.');
  const [after] = await f.routines.listRoutines(teamId, dm);
  assert.equal(after?.taskText, 'Summarize what changed overnight, newest first.');
  assert.deepEqual(after.destination, routine.destination);
  assert.equal(slack.calls.started.length, 1);

  const echoed = structured(await member('save_schedule', {
    ...DM_SCHEDULE, scheduleId: listed.scheduleId, version: edited.version, when: { keep: true }, idempotencyKey: 'dm-echo',
  }));
  assert.equal(echoed.status, 'done', 'dm "me" on a schedule already in that DM changes nothing about where it posts');

  const moved = errorOf(await member('save_schedule', {
    ...DM_SCHEDULE, dm: undefined, channelId: 'C_SUPPORT', scheduleId: listed.scheduleId, version: echoed.version,
    when: { keep: true }, idempotencyKey: 'dm-move',
  }), 'invalid_input');
  assert.equal(moved.message, 'A schedule keeps where it posts, so nothing changed.');
  assert.equal(slack.calls.withdrawn.length, 0);
});

test('save_schedule refuses any DM Slack would not let the caller schedule in, and posts nothing', async (t) => {
  const { f, slack, member, owner, teamId } = await harness(t, 'dm-refuse');

  // The Owner may edit the Agent, but only its creator may DM it while it is in no Channel.
  const notTheirs = errorOf(await owner('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'owner-dm' }), 'not_allowed');
  assert.match(String(notTheirs.message), /not available/);
  assert.equal(slack.calls.started.length, 0);

  const someoneElse = await owner('save_schedule', { ...DM_SCHEDULE, dm: f.member.user.slackUserId, idempotencyKey: 'other-dm' });
  assert.equal(someoneElse.isError, true, 'dm names only "me"');

  const both = errorOf(await member('save_schedule', { ...DM_SCHEDULE, channelId: 'C_SUPPORT', idempotencyKey: 'both' }), 'invalid_input');
  assert.equal(both.message, 'Send channelId or dm, not both: a schedule posts in one place.');
  const neither = errorOf(await member('save_schedule', { ...DM_SCHEDULE, dm: undefined, idempotencyKey: 'neither' }), 'invalid_input');
  assert.equal(neither.message, 'A new schedule needs where it posts, a channelId or dm: "me", and a time: cron, once or inMinutes.');

  errorOf(await member('save_schedule', { ...DM_SCHEDULE, when: { cron: '61 9 * * *' }, idempotencyKey: 'bad-cron' }), 'invalid_input');
  errorOf(await member('save_schedule', { ...DM_SCHEDULE, when: { once: '2020-01-01T09:00' }, idempotencyKey: 'past' }), 'invalid_input');
  assert.equal(slack.calls.started.length, 0, 'a timing the save refuses posts nothing');

  errorOf(await member('save_schedule', {
    ...DM_SCHEDULE, requiredConnections: ['conn_missing'], idempotencyKey: 'missing-connection',
  }), 'invalid_input');
  // The tool takes a longer name than a schedule keeps.
  errorOf(await member('save_schedule', { ...DM_SCHEDULE, name: 'Morning check '.repeat(8), idempotencyKey: 'long-name' }), 'invalid_input');
  assert.equal(slack.calls.started.length, 0, 'a connection or text the save refuses posts nothing');

  // Refused after its first message, here because the Agent was turned off
  // in between: the message goes, and no schedule stays.
  slack.hooks.afterStart = () => f.config.updateAgent('agent_research', { enabled: false });
  assert.equal((await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'turned-off' })).isError, true);
  delete slack.hooks.afterStart;
  await f.config.updateAgent('agent_research', { enabled: true });
  assert.equal(slack.calls.started.length, 1);
  assert.deepEqual(slack.calls.withdrawn, [{ conversationId: `D_${f.member.user.slackUserId}`, threadTs: THREAD_TS }]);
  assert.deepEqual(await f.routines.listRoutines(teamId), []);

  // Only the 5.0 door builds it: the 4.x schemas refuse it, and the service refuses it from Slack.
  const fromSlack: ManagementOperation = {
    itemId: 'save', kind: 'save_routine', agentId: 'agent_research', workspaceId: teamId,
    destination: { kind: 'initiator_dm' }, requiredConnectionAccountIds: [],
    name: 'Morning check', description: '', taskText: 'Summarize.',
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' }, timezone: 'UTC', outputPolicy: 'post',
  };
  assert.equal(managementOperationZodSchema.safeParse(fromSlack).success, false);
  assert.equal(v.safeParse(managementOperationValibotSchema, fromSlack).success, false);
  const slackApply = await f.service.applyWorkspaceChanges({
    context: chickpeaDm(f, f.member), idempotencyKey: 'from-slack', operations: [fromSlack],
  });
  assert.ok('outcomes' in slackApply);
  assert.equal(slackApply.outcomes[0]?.disposition, 'failed', JSON.stringify(slackApply.outcomes));
  assert.equal(slack.calls.started.length, 1);
});

test('when Slack cannot open the DM, nothing is posted or saved', async (t) => {
  const { f, slack, member, teamId } = await harness(t, 'dm-down', fakeSlack({ openFails: true }));
  const down = errorOf(await member('save_schedule', { ...DM_SCHEDULE, idempotencyKey: 'down' }), 'slack_unavailable');
  assert.equal(down.message, 'Slack could not post in your DM, so the schedule was not saved. Try again.');
  assert.equal(slack.calls.started.length, 0);
  assert.deepEqual(await f.routines.listRoutines(teamId), []);
});
