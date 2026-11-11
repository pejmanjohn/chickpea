import {
  blockedNetworkCalls,
  renderSlackRequest,
  renderSlackThread,
  type RenderedRequest,
  type SlackRequestVariant,
} from './helpers/render-slack-request.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { ANTHROPIC_THINKING_DISPLAY_VARIABLE } from '../src/config/model-access.ts';

const ALPHA: SlackRequestVariant = {
  workspace: 'T0ALPHA0001', channel: 'C0GENERAL01', thread: '1787100000.000100', user: 'U0ALICE0001',
  text: 'Summarize the launch plan.',
};
const BLOCK_BINDING = { prefix_mismatch_behavior: 'drop_block' };
const SUMMARIZED = { type: 'adaptive', display: 'summarized', block_binding: BLOCK_BINDING };
const OMITTED = { type: 'adaptive', display: 'omitted', block_binding: BLOCK_BINDING };

function displayed(value: string | undefined, thread: string, funding: 'platform' | 'customer' = 'platform'): SlackRequestVariant {
  return { ...ALPHA, thread, funding, ...(value === undefined ? {} : { vars: { [ANTHROPIC_THINKING_DISPLAY_VARIABLE]: value } }) };
}

/** The request with its thinking and its thread's timestamps left out. */
function withoutThinkingOrThread({ thinking: _thinking, ...request }: RenderedRequest, thread: string): string {
  return JSON.stringify(request).replaceAll(thread.split('.')[0]!, 'THREAD');
}

// Defect caught: the setting reaches the request when unset or mistyped, so a
// deployment that never set it stops asking for pi-ai's summarized thinking.
test('unset or unrecognized, an Opus 5.5 turn asks for summarized thinking as before', async () => {
  for (const [index, value] of [undefined, '', 'none', 'omit'].entries()) {
    const request = await renderSlackRequest(displayed(value, `17871000${10 + index}.000100`));
    assert.deepEqual(request.thinking, SUMMARIZED, `${value}`);
  }
  assert.deepEqual(blockedNetworkCalls(), []);
});

// Defects caught: omitted is ignored on a customer-funded request, which has
// no list-price payload hook, or on a platform-funded one, whose hook runs
// after it; the rewrite drops or changes any other field of the request.
for (const [base, funding] of [[20, 'platform'], [40, 'customer']] as const) {
  test(`${funding}-funded: omitted changes only the request's thinking display`, async () => {
    const unset = `17871000${base}.000100`;
    const before = withoutThinkingOrThread(await renderSlackRequest(displayed(undefined, unset, funding)), unset);
    for (const [index, value] of ['omitted', ' Omitted '].entries()) {
      const thread = `17871000${base + 1 + index}.000100`;
      const omitted = await renderSlackRequest(displayed(value, thread, funding));
      assert.deepEqual(omitted.thinking, OMITTED, value);
      assert.equal(withoutThinkingOrThread(omitted, thread), before);
    }
    const summarized = await renderSlackRequest(displayed('summarized', `17871000${base + 3}.000100`, funding));
    assert.deepEqual(summarized.thinking, SUMMARIZED);
  });
}

// Defect caught: a thinking block that omitted returns with empty text is
// dropped, emptied of its signature or sent as text on the next request of
// its turn or a later turn, which Anthropic rejects or answers without the
// model's earlier reasoning.
test('omitted: a signed thinking block with empty text goes back unchanged, in its turn and the next', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig_render_omitted' };
  const [first, second] = await renderSlackThread(displayed('omitted', '1787100030.000100'), [
    {
      text: 'Create an Agent named Scout.',
      replies: [
        { thinkingSignature: thinking.signature, toolCall: { name: 'activate_skill', input: { name: 'agent-authoring' } } },
        { text: 'Done.' },
      ],
    },
    { text: 'Rename it Ranger.', replies: [] },
  ]);
  for (const request of [first![1]!, second![0]!]) {
    assert.deepEqual(request.thinking, OMITTED);
    const assistant = request.messages.filter((message: any) => message.role === 'assistant');
    assert.deepEqual(assistant[0].content[0], thinking);
    assert.equal(assistant[0].content[1].type, 'tool_use');
  }
});
