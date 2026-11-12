import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { McpAuthenticatedPrincipal } from '../src/auth/mcp-oauth-routes.ts';
import type { SkillConfig } from '../src/config/types.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { AGENT_RESULT_BUDGET_CHARS } from '../src/management/mcp-v5/skill-text.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any> & { error?: Record<string, unknown> };
  isError?: boolean;
};

async function harness(t: TestContext, suffix: string, skills: SkillConfig[], instructions?: string) {
  const f = await createManagementAdapterFixture(suffix);
  t.after(() => f.close());
  await createFixtureAgent(f, 'agent_research', { skills, ...(instructions ? { instructions } : {}) });
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://chickpea.example.test' }),
    { legacy: 'stateless' },
  );
  return async (args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_agent', arguments: { agentId: 'agent_research', ...args } },
      }),
    }));
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const json = body.trimStart().startsWith('{')
      ? body
      : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
}

/** The result, after checking it fits: its text blocks and `structuredContent` together. */
function fitted(result: ToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(result.structuredContent);
  const size = result.content.reduce((total, { text }) => total + text.length, 0) +
    JSON.stringify(result.structuredContent).length;
  assert.ok(size <= AGENT_RESULT_BUDGET_CHARS, `${size} characters`);
  return result.structuredContent;
}

const skill = (name: string, instructions: string): SkillConfig =>
  ({ name, description: `The ${name} skill.`, instructions, enabled: true });

test('get_agent without includeSkillText is unchanged; with it, each skill\'s text sits once, in structuredContent', async (t) => {
  const call = await harness(t, 'skill-text', [skill('cite', 'Cite two sources.'), skill('tone', 'Write plainly.')]);

  const plain = await call();
  assert.deepEqual(JSON.parse(plain.content[0]!.text), plain.structuredContent, 'the text block is the JSON, as before');
  assert.deepEqual(plain.structuredContent!.skills, [
    { name: 'cite', description: 'The cite skill.', enabled: true, from: 'custom' },
    { name: 'tone', description: 'The tone skill.', enabled: true, from: 'custom' },
  ]);
  assert.equal(plain.structuredContent!.nextStep, undefined);
  assert.deepEqual((await call({ includeSkillText: false })).structuredContent, plain.structuredContent);

  const withText = await call({ includeSkillText: true });
  const agent = fitted(withText);
  assert.deepEqual(agent.skills.map(({ name, text, size, truncated }: Record<string, unknown>) => ({ name, text, size, truncated })), [
    { name: 'cite', text: 'Cite two sources.', size: 17, truncated: undefined },
    { name: 'tone', text: 'Write plainly.', size: 14, truncated: undefined },
  ]);
  assert.equal(agent.nextStep, undefined);
  assert.equal(agent.instructions, plain.structuredContent!.instructions);
  assert.equal(agent.version, plain.structuredContent!.version);
  assert.equal(withText.content.length, 1);
  assert.equal(withText.content[0]!.text.includes('Cite two sources.'), false, 'the skill text is not repeated in the text block');
  assert.match(withText.content[0]!.text, /cite, tone is in skills\[\]\.text/);
});

test('a skill that does not fit is marked with its size, and a long one reads in parts under the cap', async (t) => {
  const long = Array.from({ length: 4_000 }, (_, line) => `Line ${line}: check the source.`).join('\n');
  const call = await harness(t, 'skill-oversized', [skill('long', long), skill('cite', 'Cite two sources.')]);

  const agent = fitted(await call({ includeSkillText: true }));
  assert.deepEqual(agent.skills[0], {
    name: 'long', description: 'The long skill.', enabled: true, from: 'custom',
    text: null, size: long.length, truncated: true,
  });
  assert.equal(agent.skills[1].text, 'Cite two sources.', 'a later skill that fits still comes');
  assert.match(agent.nextStep, /get_agent \{ agentId, skill, offset: 0 \}/);

  const parts: string[] = [];
  let offset = 0;
  for (let reads = 0; reads < 20; reads += 1) {
    const read = fitted(await call({ skill: 'long', offset }));
    const [row, other] = read.skills;
    assert.equal(other.text, undefined, 'only the named skill carries text');
    parts.push(row.text);
    if (row.nextOffset === undefined) {
      assert.equal(row.truncated, undefined);
      assert.equal(read.nextStep, undefined);
      break;
    }
    assert.ok(row.nextOffset > offset);
    assert.equal(read.nextStep, `More of long follows: call get_agent again with skill "long" and offset ${row.nextOffset}.`);
    offset = row.nextOffset;
  }
  assert.ok(parts.length > 1, 'the skill took more than one read');
  assert.equal(parts.join(''), long);
});

test('the cap holds with many skills, a part never splits a character, and a bad read says why', async (t) => {
  const medium = (seed: string) => `${seed} `.repeat(1_334);
  const emoji = '😀'.repeat(20_000);
  const call = await harness(t, 'skill-cap', [
    skill('one', medium('alpha')), skill('two', medium('bravo')), skill('three', medium('charl')),
    skill('four', medium('delta')), skill('emoji', emoji),
  ]);

  const agent = fitted(await call({ includeSkillText: true }));
  const shown = agent.skills.filter(({ text }: { text: unknown }) => typeof text === 'string').map(({ name }: { name: string }) => name);
  assert.deepEqual(shown, ['one', 'two', 'three']);
  assert.ok(agent.skills.slice(3).every(({ text, truncated }: Record<string, unknown>) => text === null && truncated === true));

  let offset = 0;
  let joined = '';
  while (true) {
    const [row] = fitted(await call({ skill: 'emoji', offset })).skills.filter(({ name }: { name: string }) => name === 'emoji');
    assert.equal(/[\uD800-\uDBFF]$/.test(row.text), false, 'no part ends inside a character');
    joined += row.text;
    if (row.nextOffset === undefined) break;
    offset = row.nextOffset;
  }
  assert.equal(joined, emoji);

  const missing = await call({ skill: 'nope' });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent!.error!.code, 'not_found');
  const loose = await call({ offset: 10 });
  assert.equal(loose.isError, true);
  assert.equal(loose.structuredContent!.error!.code, 'invalid_input');
});

test('an Agent whose own fields fill the result still reads a skill, in parts that move on and keep characters whole', async (t) => {
  // One character ahead of the emoji puts every high surrogate at an odd index.
  const text = `x${'😀'.repeat(3_000)}`;
  const call = await harness(t, 'skill-full', [skill('emoji', text)], 'Answer from the docs. '.repeat(1_400));

  const all = (await call({ includeSkillText: true })).structuredContent!;
  assert.equal(all.skills[0].text, null, 'no room for the whole text');
  let offset = 0;
  let joined = '';
  for (let reads = 0; reads < 10; reads += 1) {
    const [row] = (await call({ skill: 'emoji', offset })).structuredContent!.skills;
    assert.ok(row.text.length > 0, 'each read moves on');
    assert.equal(/[\uD800-\uDBFF]$/.test(row.text), false, 'no part ends inside a character');
    joined += row.text;
    if (row.nextOffset === undefined) break;
    offset = row.nextOffset;
  }
  assert.equal(joined, text);
});
