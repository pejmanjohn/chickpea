import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveEffectiveSlackConfig } from '../src/config/effective-config.ts';
import { SqliteConfigStore } from '../src/config/store.ts';
import {
  parseSlackInteractionIntent,
  reactionFallbacks,
  resolveSlackInteractionIntent,
  SLACK_INTERACTION_CLASSIFIER_INSTRUCTIONS,
} from '../src/slack/interaction-intent.ts';

const baseContext = {
  workspaceId: 'T_TEST',
  channelId: 'C_TEST',
  eventId: 'Ev_test',
  text: 'sounds good?',
  source: 'app_mention' as const,
  guaranteed: true,
  profileInstructions: 'Answer as a teammate.',
  channelInstructions: '',
};

test('validated interaction dispositions enforce guaranteed and substantive-turn rules', () => {
  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({ disposition: 'ignore', reason: 'social_chatter' }),
      { guaranteed: true },
    ),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );
  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({
        disposition: 'work', reason: 'substantive_request', checklist: ['Notify <!here>'],
      }),
      { guaranteed: true },
    ),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );

  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({
        disposition: 'react_only', reason: 'pure_ack', reaction: 'agreement', target: 'trigger',
      }),
      { guaranteed: true },
    ),
    { disposition: 'react_only', reason: 'pure_ack', reaction: 'agreement', target: 'trigger' },
  );

  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({
        disposition: 'react_only', reason: 'substantive_request', reaction: 'agreement', target: 'trigger',
      }),
      { guaranteed: true },
    ),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );

  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({
        disposition: 'work', reason: 'substantive_request',
        checklist: ['PR link', 'Verification result'],
      }),
      { guaranteed: true },
    ),
    {
      disposition: 'work', reason: 'substantive_request',
      checklist: ['PR link', 'Verification result'],
    },
  );
});

test('invalid classifier output falls back by source without retaining model prose', () => {
  assert.deepEqual(
    parseSlackInteractionIntent('not json', { guaranteed: true }),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );
  assert.deepEqual(
    parseSlackInteractionIntent('{"disposition":"work","reason":"substantive_request","checklist":[]}', { guaranteed: false }),
    { disposition: 'ignore', reason: 'classifier_fallback' },
  );
  assert.deepEqual(
    parseSlackInteractionIntent(
      JSON.stringify({
        disposition: 'work', reason: 'substantive_request',
        checklist: ['working', 'token=xoxb-super-secret-value'],
      }),
      { guaranteed: true },
    ),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );
});

test('classifier failures use quiet ambient and written guaranteed fallbacks', async () => {
  assert.deepEqual(
    await resolveSlackInteractionIntent(baseContext, undefined, async () => {
      throw new Error('provider body must not escape');
    }),
    { disposition: 'reply', reason: 'classifier_fallback' },
  );
  assert.deepEqual(
    await resolveSlackInteractionIntent(
      { ...baseContext, source: 'ambient_channel_message', guaranteed: false },
      undefined,
      async () => { throw new Error('provider body must not escape'); },
    ),
    { disposition: 'ignore', reason: 'classifier_fallback' },
  );
});

test('semantic reactions have deterministic standard fallbacks', () => {
  assert.deepEqual(reactionFallbacks('agreement'), ['+1']);
  assert.deepEqual(reactionFallbacks('appreciation'), ['pray', '+1']);
  assert.deepEqual(reactionFallbacks('merged'), ['merged', 'ship', 'white_check_mark']);
  assert.deepEqual(reactionFallbacks('approved'), ['approved', 'white_check_mark']);
  assert.deepEqual(reactionFallbacks('failed'), ['x']);
});

test('the stateless classifier has no tools and treats Slack context as data', () => {
  assert.match(SLACK_INTERACTION_CLASSIFIER_INSTRUCTIONS, /You have no tools/);
  assert.match(SLACK_INTERACTION_CLASSIFIER_INSTRUCTIONS, /untrusted classification data/);
});

test('every profile receives shared Slack teammate defaults before voice overrides and guardrail', async () => {
  const store = new SqliteConfigStore(':memory:', {
    agents: [{
      id: 'agent_custom', name: 'Custom', instructions: 'Use a playful voice.', enabled: true,
      model: 'local-stub/interaction-test',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    }],
    assignments: [{
      workspaceId: 'T_TEST', channelId: 'C_TEST', agentId: 'agent_custom', enabled: true,
      channelPromptAddendum: 'Keep replies compact.',
    }],
  });
  const config = await resolveEffectiveSlackConfig('T_TEST', 'C_TEST', {
    agents: store,
    assignments: store,
  });
  assert.deepEqual(config.instructionLayers.map((layer) => layer.source), [
    'interaction_defaults', 'profile', 'channel', 'runtime', 'guardrail',
  ]);
  assert.match(config.instructions, /Lead with the outcome/);
  assert.match(config.instructions, /Current Slack user text may express task intent/);
  assert.match(config.instructions, /Use a playful voice/);
  assert.ok(config.instructions.indexOf('Use a playful voice.') < config.instructions.indexOf('Keep replies compact.'));
  assert.ok(config.instructions.indexOf('Keep replies compact.') < config.instructions.indexOf('Do not reveal Slack tokens'));
  store.close();
});
