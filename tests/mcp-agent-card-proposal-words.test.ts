import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import * as agentCard from '../src/mcp-cards/agent-card/model.ts';
import { createFixtureAgent } from './helpers/management-adapter-fixture.ts';
import { cardHost, cardServer, type CardModelUnderTest } from './helpers/mcp-card-host.ts';

/**
 * What the Agent card says before and after a press, for a person who can't
 * see the model's reasoning: the workspace a proposal joins, why a change is
 * proposed, and on a free Slack plan, what an Agent with no handle can still
 * do, said first.
 */

const AGENT_CARD: CardModelUnderTest<agentCard.View, agentCard.Action> = {
  ...agentCard,
  initial: agentCard.INITIAL,
  reads: new Set(['get_creation_status', 'get_agent', 'get_confirmation']),
  followsPress: ({ view }) => view.kind === 'creating' && view.byPress === true,
};

const PROPOSAL = {
  name: 'Release Scout', handle: 'scout', job: 'Watches releases.', instructions: '# Job\nWatch releases.',
  sampleAsk: 'what shipped?', promisedAnswer: 'Two releases shipped.',
};

/** Slack refused this Agent a handle: the workspace needs a paid plan. */
const UNHANDLED = {
  requestedHandle: 'canary', normalizedHandle: 'canary', desiredState: 'active', health: 'needs_attention',
  errorCode: 'paid_plan_required', errorDetail: 'paid_plan_required', avatar: { kind: 'generated', revision: 1, seed: 'canary' },
} as const;

async function world(t: TestContext, suffix: string) {
  const server = await cardServer(t, suffix, {}, { cards: true });
  return { ...server, card: () => cardHost(AGENT_CARD, server.call, server.clock) };
}

test('a proposal names the workspace it joins before the press', async (t) => {
  const { call, card } = await world(t, 'words-workspace');
  const proposal = await call('propose_agent', PROPOSAL);
  assert.equal(proposal.structuredContent!.proposal.workspaceName, 'Acme');
  const drawn = card();
  await drawn.result(proposal);
  assert.deepEqual(drawn.shown.subtitle, [{ text: 'In Acme\'s Slack' }, { text: ' · ' }, { text: '@scout' }]);
});

test('a change card says why it is proposed, in one line above the change', async (t) => {
  const { f, call, card } = await world(t, 'words-reason');
  await createFixtureAgent(f, 'agent_research');
  const version = (await call('get_agent', { agentId: 'agent_research' })).structuredContent!.version as string;
  const preview = await call('propose_agent_change', {
    agentId: 'agent_research', version, change: { description: 'Short answers.' }, reason: '4 of 5 answers ran past ten lines',
  });
  assert.equal(preview.structuredContent!.reason, '4 of 5 answers ran past ten lines');
  const drawn = card();
  await drawn.result(preview);
  assert.deepEqual(drawn.shown.blocks[0], { kind: 'note', text: 'Why: 4 of 5 answers ran past ten lines' });
  const prefixed = card();
  await prefixed.result({ ...preview, structuredContent: { ...preview.structuredContent, reason: 'Why: too long' } });
  assert.deepEqual(prefixed.shown.blocks[0], { kind: 'note', text: 'Why: too long' }, 'one Why, however the model wrote it');

  const none = card();
  await none.result(await call('propose_agent_change', { agentId: 'agent_research', version, change: { description: 'Short answers.' } }));
  assert.deepEqual(none.shown.blocks[0], { kind: 'section', label: 'Description' }, 'no reason, no line');
  const tooLong = await call('propose_agent_change', { agentId: 'agent_research', version, change: { description: 'x' }, reason: 'y'.repeat(161) });
  assert.equal(tooLong.structuredContent!.error.code, 'invalid_input');
});

test('a proposal warns when Slack already refused an Agent a handle for want of a paid plan', async (t) => {
  const { f, call } = await world(t, 'words-paid-plan-issue');
  assert.deepEqual((await call('propose_agent', PROPOSAL)).structuredContent!.issues, [], 'nothing known yet');
  await createFixtureAgent(f, 'agent_canary', { name: 'Canary', slackPresence: { ...UNHANDLED } as never });
  assert.deepEqual((await call('propose_agent', PROPOSAL)).structuredContent!.issues, [
    'Slack gave Canary no handle because this workspace needs a paid Slack plan, so @scout likely won\'t work either. It would still answer you in your DMs.',
  ]);
  await f.config.updateAgent('agent_canary', { lifecycle: 'archived' }, (await f.config.getAgent('agent_canary'))!.revision);
  assert.deepEqual((await call('propose_agent', PROPOSAL)).structuredContent!.issues, [], 'an archived Agent says nothing of today');
});

test('on a free Slack plan the created card says what works first: it answers in DMs', async (t) => {
  const { f, call, card } = await world(t, 'words-paid-plan-card');
  await createFixtureAgent(f, 'agent_canary', { name: 'Canary', slackPresence: { ...UNHANDLED } as never });
  const status = await call('get_creation_status', { agentId: 'agent_canary' });
  assert.equal(status.structuredContent!.stage, 'needs_attention');
  assert.equal(status.structuredContent!.paidPlanNeeded, true);
  assert.equal(status.structuredContent!.problem, 'Slack needs a paid plan before an Agent can have its own handle.');

  const drawn = card();
  const admin = 'https://chickpea.example.test/admin/agents/agent_canary';
  await drawn.result({ structuredContent: { status: 'done', summary: 'Created Canary.', agent: { agentId: 'agent_canary', name: 'Canary', handle: 'canary', links: { admin } } }, _meta: { 'chickpea/tool': 'create_agent' } });
  assert.equal(drawn.state.view.kind, 'ready', JSON.stringify(drawn.state.view));
  assert.equal(drawn.shown.title, 'Canary is ready in your DMs');
  assert.equal(drawn.shown.avatar, 'agent', 'not the alert');
  assert.deepEqual(drawn.shown.subtitle, [{ text: 'Its handle needs a paid Slack plan', tone: 'warn' }]);
  assert.deepEqual(drawn.shown.blocks, [{
    kind: 'text',
    text: 'Message it from Chickpea\'s Home tab in Slack. Until the workspace is on a paid Slack plan, no one can mention @canary in a Channel.',
  }]);
  assert.deepEqual(drawn.labels(), ['Open in Admin (secondary)'], 'with nothing else to do, Admin, where Retry is');

  // Any other handle problem keeps today's card.
  await f.config.updateAgent('agent_canary', { slackPresence: { ...UNHANDLED, errorCode: 'two_factor_required' } as never }, (await f.config.getAgent('agent_canary'))!.revision);
  const other = card();
  await other.result({ structuredContent: { status: 'done', summary: 'Created Canary.', agent: { agentId: 'agent_canary', name: 'Canary', handle: 'canary' } }, _meta: { 'chickpea/tool': 'create_agent' } });
  assert.equal(other.shown.title, 'Canary needs attention in Slack');
  assert.equal((await call('get_creation_status', { agentId: 'agent_canary' })).structuredContent!.paidPlanNeeded, undefined);
});
