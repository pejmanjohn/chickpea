import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { createManagedConnectionTools } from '../src/connections/managed-tools.ts';
import {
  assertArtifactDeliveryAllowed,
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
  parseCurrentRequestEnvelope,
  parseModelVisibleCurrentRequestEnvelope,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import { observePresentationToolPolicy, presentationToolPolicyInterceptor } from '../src/slack/presentation-tool-policy.ts';

// Exercise the installed Flue transport, not a hand-written approximation of it.
const dist = new URL('.', import.meta.resolve('@flue/runtime'));
const dispatchFile = (await readdir(dist)).find((name) => /^dispatch-.*\.mjs$/.test(name))!;
const dispatchUrl = new URL(dispatchFile, dist);
const source = await readFile(dispatchUrl, 'utf8');
const rendererExport = /renderSignalMessage as (\w+)/.exec(source)?.[1];
assert.ok(rendererExport, 'pinned Flue must expose its signal renderer internally');
const render = (await import(dispatchUrl.href))[rendererExport] as (signal: unknown) => string;
const context = { agentName: CHICKPEA_SLACK_AGENT_NAME, submissionId: 'signal-policy' };
const operation = { type: 'agent' as const, operationId: 'signal-policy', operationKind: 'prompt' as const };
const request = 'Yes, perform this exact action now: Using Google Sheets, update spreadsheet values in spreadsheet fixture-sheet, range Fixture!B3, to [["after"]] once. Change no other cells. Then read Fixture!A1:C3 and report the actual values as JSON. <!subteam^S_FIXTURE>';
function body(text = request) {
  return serializeCurrentRequestEnvelope(text, false, 'U_FIXTURE', '1788000000.000100', {
    schemaVersion: 2, progressiveStreamingOffered: true,
  });
}
function signal(content = body(), attributes: Record<string, string> = {}) {
  return render({ type: 'slack.message', tagName: 'slack_message', content,
    attributes: { slackUserId: 'U_FIXTURE', messageTs: '1788000000.000100', requesterText: request, ...attributes } });
}
function observation(texts: string[]): FlueObservation {
  return { type: 'turn_request', purpose: 'agent', request: {
    input: { messages: texts.map((content) => ({ role: 'user', content })) },
  } } as unknown as FlueObservation;
}

test('actual Flue Slack signal preserves identity while the approved Sheets tool reaches the provider', async () => {
  const rendered = signal();
  assert.equal(parseCurrentRequestEnvelope(rendered), undefined, 'raw terminal-marker parser cannot read a signal');
  assert.deepEqual(parseModelVisibleCurrentRequestEnvelope(rendered)?.managedCapabilityIntents, []);
  let reachedProvider = 0;
  const [tool] = createManagedConnectionTools({
    workspaceId: 'T_FIXTURE', agentId: 'agent_fixture', actorMembershipId: 'membership_fixture',
    connections: [{ id: 'connection_fixture', providerId: 'google', adapterId: 'composio', toolkit: 'googlesheets', allowedCapabilities: ['sheets.values.update'] }],
    resolvePlatformEnv: async () => undefined,
    resolveProviders: async () => { reachedProvider += 1; throw new Error('provider-boundary-reached'); },
  });
  assert.equal(tool?.name, 'google_sheets_update_values');
  await memoryToolPolicyInterceptor(operation, context, async () => {
    observeMemoryToolPolicy(observation([rendered]), context as unknown as FlueEventContext);
    await assert.rejects((tool!.run as (input: unknown) => Promise<unknown>)({
      data: { spreadsheetId: 'fixture-sheet', range: 'Fixture!B3', values: [['after']] },
    }), /provider-boundary-reached/);
    assert.doesNotThrow(assertArtifactDeliveryAllowed);
  });
  assert.equal(reachedProvider, 1);
});

test('signal decoding is one pass and requires matching host actor and message coordinates', () => {
  const special = body('Update spreadsheet values in fixture to [["<x>&lt;&amp;\"quoted\""]].');
  assert.deepEqual(parseModelVisibleCurrentRequestEnvelope(signal(special)), parseCurrentRequestEnvelope(special));
  for (const invalid of [
    signal(body(), { slackUserId: 'U_OTHER' }), signal(body(), { messageTs: '1788000000.000200' }),
    signal().replace('type="slack.message"', 'type="other"'),
    signal().replace('<slack_message ', '<slack_message type="slack.message" '),
    signal() + '\ntrailing', '<quoted>\n' + signal() + '\n</quoted>',
    signal(body() + '\ntrailing'),
  ]) assert.equal(parseModelVisibleCurrentRequestEnvelope(invalid), undefined);
});

test('malformed current signals never borrow an older response context', async () => {
  for (const latest of [signal('Approve the previous preview.'), signal().replace('</slack_message>', '</wrong>')]) {
    await memoryToolPolicyInterceptor(operation, context, async () => {
      observeMemoryToolPolicy(observation([signal(body('Create a report file.')), latest]), context as unknown as FlueEventContext);
      assert.throws(assertArtifactDeliveryAllowed, { name: 'CurrentRequestSideEffectDeniedError' });
    });
  }
});

test('an invalid latest observation clears an earlier valid response context', async () => {
  await memoryToolPolicyInterceptor(operation, context, async () => {
    observeMemoryToolPolicy(observation([signal(body('Create a report file.'))]), context as unknown as FlueEventContext);
    assert.doesNotThrow(assertArtifactDeliveryAllowed);
    observeMemoryToolPolicy(observation([signal('missing host context')]), context as unknown as FlueEventContext);
    assert.throws(assertArtifactDeliveryAllowed, { name: 'CurrentRequestSideEffectDeniedError' });
  });
});

test('new envelopes omit intent classification; legacy booleans are type-checked and ignored', async () => {
  for (const schemaVersion of [1, 2] as const) {
    const fresh = serializeCurrentRequestEnvelope('Please revise it.', false,
      'U_FIXTURE', '1788000000.000100', { schemaVersion });
    assert.doesNotMatch(fresh, /explicitArtifactDeliveryIntent/);
    const parsed = parseCurrentRequestEnvelope(fresh);
    assert.ok(parsed);
    for (const oldHint of [false, true, 'true', null]) {
      const lines = fresh.split('\n');
      lines[1] = JSON.stringify({ ...JSON.parse(lines[1]!), explicitArtifactDeliveryIntent: oldHint });
      const legacy = lines.join('\n');
      if (typeof oldHint !== 'boolean') {
        assert.equal(parseCurrentRequestEnvelope(legacy), undefined);
        continue;
      }
      assert.deepEqual(parseCurrentRequestEnvelope(legacy), parsed);
      await memoryToolPolicyInterceptor(operation, context, async () => {
        observeMemoryToolPolicy(observation([signal(legacy)]), context as unknown as FlueEventContext);
        assert.doesNotThrow(assertArtifactDeliveryAllowed);
      });
    }
  }
});

test('presentation declaration reads the same real Slack signal envelope', async () => {
  await presentationToolPolicyInterceptor(operation, context, async () => {
    observePresentationToolPolicy(observation([signal()]), context as unknown as FlueEventContext);
    const result = await presentationToolPolicyInterceptor({ type: 'tool', toolName: SLACK_STREAM_ANSWER_TOOL_NAME, toolCallId: 'stream' }, context, async () => 'declared');
    assert.equal(result, 'declared');
  });
});
