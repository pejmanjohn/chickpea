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
import { init, observe, useDelivery, useModel, useTool, type AgentProps } from '@flue/runtime';
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

const SIGNALED = { workspaceChangeTools: 'mounted' };

// Defect caught: the host's signal does not mount the tools in the first
// request, mounts them in another position (a third cache shape no prewarm
// shares), or adds them mid-conversation instead.
for (const agentKind of ['system', 'user'] as const) {
  test(`${agentKind} Agent: a signaled turn's first request carries the change tools in the shared management shape`, async () => {
    const [, later] = await renderSlackThread(thread({ agentKind }), [
      { text: 'Create an Agent named Scout.', replies: [ACTIVATE, DONE] },
      { text: 'Rename it Ranger.', replies: [] },
    ]);
    const activatedLater = later![0]!;
    const signaled = await renderSlackRequest(thread({ agentKind, signalAttributes: SIGNALED }));
    const mounted = names(signaled.tools);
    const at = mounted.indexOf(CHANGE_TOOLS[0]!);
    assert.deepEqual(mounted.slice(at - 1, at + CHANGE_TOOLS.length), ['stream_answer', ...CHANGE_TOOLS]);
    assert.equal(JSON.stringify(signaled.tools), JSON.stringify(activatedLater.tools),
      'the same tools, byte for byte, as an activated thread\'s later turn');
    assert.equal(signaled.system[0].text, sharedSystemBlock(agentKind));
    assert.deepEqual(anthropicToolAdditions(signaled), [], 'declared from the start, not added');
    assert.equal(chargedSharedPrefix(signaled), `${agentKind}/interactive_streaming_management`);
    assert.deepEqual(signaled.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  });
}

// Defect caught: a value other than the host's own mounts the tools, or the
// signal on one turn leaks into the thread's next.
test('only the host\'s signal mounts the tools, and only on its own turn', async () => {
  const [first, second] = await renderSlackThread(thread(), [
    { text: 'Create an Agent named Scout.', replies: [DONE], signalAttributes: SIGNALED },
    { text: 'Thanks.', replies: [] },
  ]);
  assert.ok(CHANGE_TOOLS.every((tool) => names(first![0]!.tools).includes(tool)));
  assert.equal(chargedSharedPrefix(second![0]!), 'system/interactive_streaming', 'the next turn is lean again');
  const other = await renderSlackRequest(thread({ signalAttributes: { workspaceChangeTools: 'always' } }));
  assert.ok(CHANGE_TOOLS.every((tool) => !names(other.tools).includes(tool)));
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

/** As ChickpeaSlack reads the host's signal from the delivery. */
function SignaledChangeToolsProbe({ id }: AgentProps) {
  useModel(PROBE_MODEL);
  useAgentAuthoringSkill();
  const delivery = useDelivery();
  const signaled = delivery.kind === 'signal' && delivery.attributes?.workspaceChangeTools === 'mounted';
  if (useWorkspaceChangeToolsMounted(id, signaled)) {
    for (const name of CHANGE_TOOLS) useTool({ name, description: `Stand-in for ${name}.`, input: v.object({}), run: () => 'ok' });
  }
  return 'Answer the request.';
}

// Defect caught: a signaled turn writes the thread's keep flag, so a false
// positive makes every later turn carry the tools; or a signaled turn whose
// model activates loses the flag that keeps them.
test('a signaled turn keeps the tools for the thread only when its model activates agent-authoring', async () => {
  const unobserve = observe((event) => noteAgentAuthoringActivation(event));
  const faux = fauxProvider({ models: [{ id: 'change-tools-probe' }] });
  const contexts: Context[] = [];
  const seen = (reply: ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
    contexts.push(structuredClone(context));
    return reply;
  };
  const flue = await start({ agents: [{ agent: SignaledChangeToolsProbe, name: 'signaled-change-tools-probe' }], providers: [faux.provider] });
  const signal = (body: string, attributes: Record<string, string>) => ({
    message: { kind: 'signal' as const, type: 'slack.message', tagName: 'slack_message', body, attributes },
  });
  try {
    const turn = async (handle: ReturnType<typeof init>, request: Parameters<ReturnType<typeof init>['dispatch']>[0]) => {
      await handle.read(await handle.dispatch(request));
    };
    const mounted = (context: Context) => getCurrentTools(context.messages).map(({ name }) => name)
      .filter((name) => CHANGE_TOOLS.includes(name));

    const answered = init(SignaledChangeToolsProbe, { id: 'signaled-change-tools-answered' });
    faux.setResponses([seen(fauxAssistantMessage('Done.')), seen(fauxAssistantMessage('Done.'))]);
    await turn(answered, signal('Create an Agent named Scout.', SIGNALED));
    await turn(answered, signal('Thanks.', {}));
    const [signaledFirst, nextLean] = contexts.splice(0);
    assert.deepEqual(mounted(signaledFirst!), CHANGE_TOOLS, 'the signaled turn\'s first request has them');
    assert.deepEqual(mounted(nextLean!), [], 'the signal kept nothing');

    const activated = init(SignaledChangeToolsProbe, { id: 'signaled-change-tools-activated' });
    faux.setResponses([
      seen(fauxAssistantMessage([fauxToolCall('activate_skill', { name: 'agent-authoring' })], { stopReason: 'toolUse' })),
      seen(fauxAssistantMessage('Done.')),
      seen(fauxAssistantMessage('Done.')),
    ]);
    await turn(activated, signal('Create an Agent named Scout.', SIGNALED));
    await turn(activated, signal('Rename it Ranger.', {}));
    const [first, afterActivation, kept] = contexts;
    assert.deepEqual(mounted(first!), CHANGE_TOOLS);
    assert.deepEqual(mounted(afterActivation!), CHANGE_TOOLS, 'activating changes nothing mid-turn');
    assert.deepEqual(mounted(kept!), CHANGE_TOOLS, 'activation kept them for the thread');
  } finally {
    await flue.stop();
    unobserve();
  }
});

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
