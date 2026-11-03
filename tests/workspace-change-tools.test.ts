import {
  chargedSharedPrefix,
  renderSlackRequest,
  renderSlackThread,
  type RenderedRequest,
  type ScriptedReply,
  type SlackRequestVariant,
} from './helpers/render-slack-request.ts';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type Context,
} from '@earendil-works/pi-ai';
import { init, observe, useModel, useTool, type AgentProps } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import * as v from 'valibot';

import { SHARED_PREFIX_LAST_TOOL, sharedSystemBlock } from '../src/agents/shared-prefix-layout.ts';
import { useAgentAuthoringSkill } from '../src/management/agent-authoring/index.ts';
import {
  WORKSPACE_CHANGE_TOOL_NAMES,
  noteAgentAuthoringActivation,
  useWorkspaceChangeToolsMounted,
} from '../src/management/workspace-change-tools.ts';

const CHANGE_TOOLS: readonly string[] = WORKSPACE_CHANGE_TOOL_NAMES;
const ACTIVATE: ScriptedReply = { toolCall: { name: 'activate_skill', input: { name: 'agent-authoring' } } };
const DONE: ScriptedReply = { text: 'Done.' };

let threads = 0;
/** A new thread, so no test reads another's transcript or activation. */
function thread(overrides: Partial<SlackRequestVariant> = {}): SlackRequestVariant {
  threads += 1;
  return {
    workspace: 'T0ALPHA0001', channel: 'C0GENERAL01', thread: `${1_788_000_000 + threads * 900}.000100`,
    user: 'U0ALICE0001', text: 'Create an Agent named Scout that triages support email.', ...overrides,
  };
}

const names = (tools: readonly { name: string }[]): string[] => tools.map(({ name }) => name);
const withoutChangeTools = (tools: readonly { name: string }[]) => tools.filter(({ name }) => !CHANGE_TOOLS.includes(name));

/** The tools each of a request's mid-conversation system messages adds, by name. */
function anthropicToolAdditions(request: RenderedRequest): string[][] {
  return request.messages
    .filter((message: any) => message.role === 'system' && Array.isArray(message.content))
    .map((message: any) => message.content
      .filter((block: any) => block.type === 'tool_addition')
      .map((block: any) => block.tool.definition.name))
    .filter((added: string[]) => added.length > 0);
}

function anthropicToolRemovals(request: RenderedRequest): unknown[] {
  return request.messages.flatMap((message: any) => Array.isArray(message.content)
    ? message.content.filter((block: any) => block.type === 'tool_removal')
    : []);
}

test('a plain Slack turn mounts none of the change tools', async () => {
  const request = await renderSlackRequest(thread({ text: 'What can you help me with?' }));
  const mounted = names(request.tools);
  for (const tool of CHANGE_TOOLS) assert.ok(!mounted.includes(tool), `${tool} is not mounted`);
  assert.ok(mounted.includes('inspect_workspace'), 'the other management tools stay mounted');
  assert.equal(request.system[0].text, sharedSystemBlock('system'), 'the turn keeps the shared system block');
  assert.equal(chargedSharedPrefix(request), 'system/interactive_streaming', 'a lean turn carries a shared prefix');
});

test('activating agent-authoring adds the change tools inline on Anthropic: the tool list and shared prefix hold', async () => {
  const [before, after, ...rest] = (await renderSlackThread(thread(), [{ text: 'Create an Agent named Scout.', replies: [ACTIVATE] }]))[0]!;
  assert.deepEqual(rest, []);
  assert.equal(JSON.stringify(after!.tools), JSON.stringify(before!.tools), 'the request keeps the first request\'s tools, byte for byte');
  assert.deepEqual(after!.system, before!.system);
  for (const tool of CHANGE_TOOLS) assert.ok(!names(after!.tools).includes(tool));
  assert.deepEqual(anthropicToolAdditions(before!), []);
  assert.deepEqual(anthropicToolAdditions(after!), [[...CHANGE_TOOLS]], 'one system message adds the four tools after the transcript');
  assert.ok(after!.betas.includes('inline-tools-2026-09-15'));
  assert.equal(chargedSharedPrefix(before!), 'system/interactive_streaming');
  assert.equal(chargedSharedPrefix(after!), 'system/interactive_streaming', 'the addition rides after the shared prefix');
  const anchor = after!.tools.findIndex((tool: { name: string }) => tool.name === SHARED_PREFIX_LAST_TOOL);
  assert.deepEqual(after!.tools[anchor].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(after!.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('activating agent-authoring adds the change tools on OpenAI as additional tools, and the tool list holds', async () => {
  const [before, after] = (await renderSlackThread(thread({ provider: 'openai' }), [{ text: 'Create an Agent named Scout.', replies: [ACTIVATE] }]))[0]!;
  assert.equal(before!.model, 'gpt-5.6-terra');
  assert.equal(JSON.stringify(after!.tools), JSON.stringify(before!.tools));
  assert.equal(after!.instructions, before!.instructions);
  for (const tool of CHANGE_TOOLS) assert.ok(!names(before!.tools).includes(tool));
  const additions = (request: RenderedRequest) => request.input
    .filter((item: any) => item.type === 'additional_tools')
    .map((item: any) => names(item.tools));
  assert.deepEqual(additions(before!), []);
  assert.deepEqual(additions(after!), [[...CHANGE_TOOLS]]);
});

test('another skill\'s activation mounts nothing', async () => {
  const [first, second] = await renderSlackThread(thread(), [
    { text: 'Use the release checklist.', replies: [{ toolCall: { name: 'activate_skill', input: { name: 'release-checklist' } } }, DONE] },
    { text: 'And now?', replies: [] },
  ]);
  assert.deepEqual(anthropicToolAdditions(first![1]!), []);
  for (const tool of CHANGE_TOOLS) assert.ok(!names(second![0]!.tools).includes(tool));
});

test('a later turn of an activated thread sends the change tools after the shared capability tools, and every other tool unchanged', async () => {
  const plain = await renderSlackRequest(thread({ text: 'What can you help me with?' }));
  const [, second, third] = await renderSlackThread(thread(), [
    { text: 'Create an Agent named Scout.', replies: [ACTIVATE, DONE] },
    { text: 'Rename it Ranger.', replies: [DONE] },
    { text: 'Thanks.', replies: [] },
  ]);
  for (const request of [second![0]!, third![0]!]) {
    const mounted = names(request.tools);
    const at = mounted.indexOf(CHANGE_TOOLS[0]!);
    assert.deepEqual(mounted.slice(at, at + CHANGE_TOOLS.length), CHANGE_TOOLS, 'mounted together, in order');
    assert.deepEqual(mounted.slice(at - 1, at), ['stream_answer'], 'after the streaming tool, the last shared capability tool');
    assert.equal(JSON.stringify(withoutChangeTools(request.tools)), JSON.stringify(plain.tools),
      'every other tool is the plain turn\'s, byte for byte');
    assert.deepEqual(anthropicToolAdditions(request), [], 'nothing is added mid-conversation');
    assert.deepEqual(anthropicToolRemovals(request), [], 'and nothing is withdrawn');
    assert.equal(request.system[0].text, sharedSystemBlock('system'));
    assert.equal(chargedSharedPrefix(request), 'system/interactive_streaming_management', 'a shared shape, cached for an hour');
    assert.deepEqual(request.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  }
});

const PROBE_MODEL = 'faux/change-tools-probe';

/** The hook as a delivered Slack submission runs it, with stand-ins for the four tools. */
function ChangeToolsProbe({ id }: AgentProps) {
  useModel(PROBE_MODEL);
  useAgentAuthoringSkill();
  if (useWorkspaceChangeToolsMounted(id)) {
    for (const name of CHANGE_TOOLS) useTool({ name, description: `Stand-in for ${name}.`, input: v.object({}), run: () => 'ok' });
  }
  return 'Answer the request.';
}

test('the thread keeps the change tools when the response that activated agent-authoring finishes', async () => {
  const unobserve = observe((event) => noteAgentAuthoringActivation(event));
  const faux = fauxProvider({ models: [{ id: 'change-tools-probe' }] });
  const contexts: Context[] = [];
  const seen = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
    contexts.push(structuredClone(context));
    return reply;
  };
  const flue = await start({ agents: [{ agent: ChangeToolsProbe, name: 'change-tools-probe' }], providers: [faux.provider] });
  try {
    const turn = async (handle: ReturnType<typeof init>, message: string) => { await handle.read(await handle.dispatch(message)); };
    const activated = init(ChangeToolsProbe, { id: 'change-tools-probe-activated' });
    faux.setResponses([
      seen(fauxAssistantMessage([fauxToolCall('activate_skill', { name: 'agent-authoring' })], { stopReason: 'toolUse' })),
      seen(fauxAssistantMessage('Done.')),
      seen(fauxAssistantMessage('Done.')),
    ]);
    await turn(activated, 'Create an Agent named Scout.');
    // Only the persisted flag carries the tools into this turn: finishing
    // the activating response retires the in-memory activation.
    await turn(activated, 'Rename it Ranger.');
    const plain = init(ChangeToolsProbe, { id: 'change-tools-probe-plain' });
    faux.setResponses([seen(fauxAssistantMessage('Done.'))]);
    await turn(plain, 'What can you do?');

    const mounted = (context: Context) => getCurrentTools(context.messages).map(({ name }) => name)
      .filter((name) => CHANGE_TOOLS.includes(name));
    const leading = (context: Context) => (context.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded
      ?.map(({ name }) => name).filter((name) => CHANGE_TOOLS.includes(name));
    const [first, afterActivation, nextTurn, other] = contexts;
    assert.deepEqual(mounted(first!), [], 'the first request is lean');
    assert.deepEqual(mounted(afterActivation!), CHANGE_TOOLS, 'activation mounts the tools for the next request');
    assert.deepEqual(leading(afterActivation!), [], 'added after the leading declaration');
    assert.deepEqual(leading(nextTurn!), CHANGE_TOOLS, 'the next turn declares them from its start');
    assert.deepEqual(mounted(other!), [], 'another thread stays lean');
  } finally {
    await flue.stop();
    unobserve();
  }
});
