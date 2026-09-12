import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { defineTool, init, instrument, useDelivery, useInstruction, useModel, useTool } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { memoryToolPolicyInterceptor, observeMemoryToolPolicy, serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';

test('image inventory changes preserve current-request delivery authority through real Flue narration', async () => {
  const model = 'faux/current-request-narration';
  let delivered = 0;
  const newestUsers: string[] = [];
  const registration = instrument({
    key: Symbol('current-request-narration'),
    interceptor: memoryToolPolicyInterceptor,
    observe(event, context) {
      if (event.type === 'turn_request' && event.purpose === 'agent') {
        const latest = event.request.input.messages.findLast(message => message.role === 'user');
        newestUsers.push(JSON.stringify(latest?.content));
      }
      observeMemoryToolPolicy(event, context);
    },
    dispose() {},
  });
  function ImageInventoryProbe() {
    useModel(model);
    const delivery = useDelivery();
    useInstruction(`Images available: ${delivery.kind === 'signal' ? delivery.attributes?.inventory : 'none'}`);
    useTool(defineTool({ name: 'recover_image', description: 'Deliver retained fixture bytes.',
      input: v.object({}), output: v.object({ attached: v.boolean() }),
      async run() { delivered += 1; return { output: { attached: true } }; } }));
    return 'Use recover_image once, then finish.';
  }
  const faux = fauxProvider({ models: [{ id: 'current-request-narration' }] });
  faux.setResponses(Array.from({ length: 3 }, () => [
    fauxAssistantMessage([fauxToolCall('recover_image', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
  ]).flat());
  const flue = await start({ agents: [{ agent: ImageInventoryProbe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider] });
  try {
    const handle = init(ImageInventoryProbe, { id: 'current-request-narration-fixture' });
    for (let turn = 1; turn <= 3; turn += 1) {
      const ts = `1788000000.00000${turn}`;
      const receipt = await handle.dispatch({ message: { kind: 'signal', type: 'slack.message', tagName: 'slack_message',
        body: turn === 3 ? 'Missing current request envelope.' : serializeCurrentRequestEnvelope('Resend the image.', false, 'U_FIXTURE', ts),
        attributes: { slackUserId: 'U_FIXTURE', messageTs: ts, inventory: `img:${turn}` } } });
      await handle.read(receipt);
      assert.equal(delivered, Math.min(turn, 2), JSON.stringify(newestUsers));
    }
    assert.ok(newestUsers.some(text => text.includes('System instructions updated.')), 'actual runtime emitted the instruction-change marker');
  } finally {
    await flue.stop();
    await registration();
  }
});
