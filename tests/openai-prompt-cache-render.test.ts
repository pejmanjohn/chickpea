import {
  blockedNetworkCalls,
  chargedSharedPrefix,
  renderSlackRequest,
  type RenderedRequest,
  type SlackRequestVariant,
} from './helpers/render-slack-request.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import { promptCacheKey } from '../src/agents/openai-prompt-cache.ts';
import { sharedSystemBlock } from '../src/agents/shared-prefix.ts';

const ALPHA: SlackRequestVariant = {
  workspace: 'T0ALPHA0001', channel: 'C0GENERAL01', thread: '1787000000.000100', user: 'U0ALICE0001',
  text: 'What can you help me with?', provider: 'openai',
};
const ALPHA_OTHER_CHANNEL = { ...ALPHA, channel: 'C0SALES0001', thread: '1787000900.000100' };
const ALPHA_DM: SlackRequestVariant = { ...ALPHA, conversationKind: 'im', channel: 'D0ALICE0001', thread: '1787001800.000100' };
const BRAVO = { ...ALPHA, workspace: 'T0BRAVO0001', channel: 'C0GENERAL02', user: 'U0CAROL0001' };
const TENANT_IDS = [ALPHA.workspace, ALPHA.channel, ALPHA_OTHER_CHANNEL.channel, ALPHA_DM.channel, BRAVO.workspace];

/** Everything OpenAI reads before the breakpoint: the tools, then the developer message's first part. */
function throughBreakpoint(request: RenderedRequest): string {
  return JSON.stringify({ tools: request.tools, developer: request.input[0].content[0] });
}

function developerText(request: RenderedRequest): string {
  const { content } = request.input[0];
  return typeof content === 'string' ? content : content.map((part: { text: string }) => part.text).join('');
}

for (const funding of ['customer', 'platform'] as const) {
  for (const agentKind of ['system', 'user'] as const) {
    test(`${funding}-funded, ${agentKind} Agent: gpt-5.6-terra turns in any channel or DM of one installation send one key and the same bytes through the breakpoint`, async () => {
      const alpha = await renderSlackRequest({ ...ALPHA, funding, agentKind });
      const key = await promptCacheKey({ installationId: `inst_${ALPHA.workspace}` });
      assert.equal(alpha.input[0].role, 'developer');
      assert.deepEqual(alpha.input[0].content[0], {
        type: 'input_text', text: `${sharedSystemBlock(agentKind)}\n\n`, prompt_cache_breakpoint: { mode: 'explicit' },
      });
      assert.equal(alpha.input[0].content.length, 2, 'one breakpoint, after the constant block');
      assert.equal(alpha.prompt_cache_key, key);
      assert.equal(alpha.prompt_cache_options, undefined, 'the implicit write stays on');
      assert.equal(alpha.service_tier, funding === 'platform' ? 'default' : undefined);
      if (funding === 'platform') assert.equal(chargedSharedPrefix(alpha), null, 'the charge names no shared prefix');

      for (const variant of [ALPHA_OTHER_CHANNEL, ALPHA_DM]) {
        const other = await renderSlackRequest({ ...variant, funding, agentKind });
        assert.equal(other.prompt_cache_key, key, `${variant.channel} sends its installation's key`);
        assert.equal(throughBreakpoint(other), throughBreakpoint(alpha), `${variant.channel} sends the same bytes through the breakpoint`);
        assert.notEqual(other.input[0].content[1].text, alpha.input[0].content[1].text, 'the tail names the channel');
      }
      const prefix = throughBreakpoint(alpha);
      for (const id of TENANT_IDS) assert.ok(!prefix.includes(id), `${id} is not before the breakpoint`);
      assert.doesNotMatch(prefix, /Date: |You are assigned to Slack workspace|Your Agent ID is/);

      const bravo = await renderSlackRequest({ ...BRAVO, funding, agentKind });
      assert.equal(bravo.prompt_cache_key, await promptCacheKey({ installationId: `inst_${BRAVO.workspace}` }));
      assert.notEqual(bravo.prompt_cache_key, key, 'another installation never shares the key');
      assert.deepEqual(blockedNetworkCalls(), []);
    });
  }
}

test('the split parts carry exactly the text the turn sends when the breakpoint is off', async () => {
  const shared = await renderSlackRequest({ ...ALPHA, funding: 'customer' });
  const proxied = await renderSlackRequest({ ...ALPHA, funding: 'customer', baseUrl: 'https://llm-proxy.example.com/v1' });

  assert.equal(typeof proxied.input[0].content, 'string', 'a proxy endpoint gets the developer text as pi-ai built it');
  assert.match(proxied.prompt_cache_key, /^aff_/, 'and pi-ai\'s per-thread key');
  assert.equal(developerText(shared), proxied.input[0].content, 'the parts join to the same bytes');
  const rest = ({ prompt_cache_key: _key, input: [_developer, ...input], ...others }: RenderedRequest) => ({ ...others, input });
  assert.deepEqual(rest(shared), rest(proxied), 'nothing else in the request differs');
});

for (const [name, variant] of [
  ['a requester with no membership', { ...ALPHA, member: false }],
  ['a file-delivery check', { ...ALPHA, delivery: 'file_delivery_check' }],
] as const) {
  test(`${name}, whose block is reduced, goes out as pi-ai built it`, async () => {
    const request = await renderSlackRequest(variant);
    assert.equal(typeof request.input[0].content, 'string');
    assert.match(request.prompt_cache_key, /^aff_/);
  });
}
