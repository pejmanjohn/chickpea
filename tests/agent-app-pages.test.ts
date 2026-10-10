import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type AgentAppMessageKind, agentAppHomeBlocks, agentAppMessage } from '../src/slack/agent-apps/pages.ts';

const HOSTILE = { name: '<!channel> & <@U123> <https://evil.test|click>', handle: 'support' };
const LINKS = { agentId: 'agent_support', allowUrl: 'https://cloud.test/allow', tokenPageUrl: 'https://core.test/token' };
const KINDS: AgentAppMessageKind[] = [
  'allow', 'ready', 'archived_left', 'handle_release_failed', 'ambiguous_create', 'create_refused', 'slack_busy',
  'urls_refused', 'config_token_needed', 'app_removed',
];

function sectionText(kind: AgentAppMessageKind): string {
  const message = agentAppMessage(kind, HOSTILE, LINKS);
  assert.ok(message, kind);
  const section = message.blocks[0] as { type: string; text: { type: string; text: string } };
  assert.equal(section.type, 'section');
  assert.equal(section.text.type, 'mrkdwn');
  assert.equal(message.text, section.text.text, 'the fallback text is the section text');
  return section.text.text;
}

test("an Agent's name and handle never become mrkdwn markup or a ping", () => {
  for (const kind of KINDS) {
    const text = sectionText(kind);
    assert.equal(text.includes('<!'), false, `${kind}: no special mention`);
    assert.equal(text.includes('<@'), false, `${kind}: no user mention`);
    assert.equal(text.includes('<https://'), false, `${kind}: no link markup`);
    assert.equal(/@support\b/u.test(text), false, `${kind}: @handle does not auto-parse`);
    if (kind === 'allow') assert.equal(text.includes('&lt;!channel&gt; &amp; &lt;@'), true, 'the name is shown, escaped');
  }
});

test('button labels stay plain text and the Allow button carries the Agent name as typed', () => {
  const message = agentAppMessage('allow', HOSTILE, LINKS)!;
  const actions = message.blocks[1] as { elements: Array<{ text: { type: string; text: string }; url?: string }> };
  assert.equal(actions.elements[0]?.text.type, 'plain_text');
  assert.equal(actions.elements[0]?.text.text, `Allow ${HOSTILE.name} in Slack`);
  assert.equal(actions.elements[0]?.url, LINKS.allowUrl);
});

test('a button never carries more text than Slack takes, however long the name or handle', () => {
  const long = { name: 'S'.repeat(80), handle: 'h'.repeat(80) };
  const allowButton = (agentAppMessage('allow', long, LINKS)!.blocks[1] as { elements: Array<{ text: { text: string } }> }).elements[0]!;
  assert.ok(allowButton.text.text.length <= 75, `Allow label is ${allowButton.text.text.length} characters`);
  const offer = agentAppHomeBlocks({ kind: 'offer', tokenPageUrl: undefined }, long, 'agent_support')[0] as { elements: Array<{ text: { text: string } }> };
  assert.ok(offer.elements[0]!.text.text.length <= 75, `offer label is ${offer.elements[0]!.text.text.length} characters`);
});
