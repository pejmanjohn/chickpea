import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { init, instrument, useDataWriter, useModel, useTool, type ConversationStreamChunk } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import {
  observePresentationToolPolicy, presentationToolPolicyInterceptor, replyDisplayHistory,
} from '../src/slack/presentation-tool-policy.ts';
import {
  createDisplayTools, parseDisplayComponents, SLACK_DISPLAY_COMPONENTS_DATA_NAME, SlackDisplayComponentsSchema,
} from '../src/slack/ui/display-tools.ts';
import {
  SLACK_PRESENT_CARDS_TOOL_NAME, SLACK_PRESENT_CHART_TOOL_NAME, SLACK_PRESENT_DETAILS_TOOL_NAME,
} from '../src/slack/ui/presentation-tools.ts';

const CHART = { title: 'Signups', type: 'line', categories: ['W1', 'W2'], series: [{ name: 'Signups', values: [120, 135] }] };
const DETAILS = { title: 'Method', markdown: '(135 - 120) / 120' };
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

/**
 * Flue renders the agent function again before every model turn, so the
 * display tools a turn runs are fresh closures. This drives the real runtime
 * through one reply that records its components in separate turns.
 */
test('actual Flue hook keeps display components recorded in earlier turns', { timeout: 30_000 }, async (t) => {
  const faux = fauxProvider({ models: [{ id: 'display-proof', reasoning: false }], tokensPerSecond: 10_000 });
  let closures = 0;
  let withHistory = true;
  /** The history the details tool saw when it ran, by tool call id. */
  let historyAtDetails: string[] | undefined;
  function DisplayProbe() {
    useModel('faux/display-proof');
    const write = useDataWriter(SLACK_DISPLAY_COMPONENTS_DATA_NAME, { schema: SlackDisplayComponentsSchema });
    closures += 1;
    const display = createDisplayTools(write, withHistory ? { history: replyDisplayHistory } : {});
    useTool(display.cards);
    useTool(display.chart);
    useTool({ ...display.details, run: (context) => {
      historyAtDetails = replyDisplayHistory().map((component) => component.toolCallId);
      return display.details.run(context);
    } });
    return 'Follow the scripted tool calls.';
  }
  const dispose = instrument({
    interceptor: presentationToolPolicyInterceptor, observe: observePresentationToolPolicy, dispose() {},
  });
  const flue = await start({ agents: [{ agent: DisplayProbe, name: CHICKPEA_SLACK_AGENT_NAME }], providers: [faux.provider] });
  let sequence = 0;
  async function run(responses: Parameters<typeof faux.setResponses>[0]) {
    closures = 0;
    historyAtDetails = undefined;
    faux.setResponses(responses);
    const agent = init(DisplayProbe, { id: `display-proof-${++sequence}` });
    const events: ConversationStreamChunk[] = [];
    const reply = await agent.read(await agent.dispatch('Show the signups.'), { onEvent: (chunk) => { events.push(chunk); } });
    const errors = (toolName: string) => {
      const calls = new Set(events.flatMap((event) => event.type === 'tool-input' && event.toolName === toolName ? [event.toolCallId] : []));
      return events.flatMap((event) => event.type === 'tool-output-error' && calls.has(event.toolCallId) ? [event.errorText] : []);
    };
    const chartCall = events.find((event) => event.type === 'tool-input' && event.toolName === SLACK_PRESENT_CHART_TOOL_NAME);
    return {
      kinds: parseDisplayComponents(reply.data?.[SLACK_DISPLAY_COMPONENTS_DATA_NAME]).map((component) => component.kind),
      errors,
      chartCallId: chartCall?.type === 'tool-input' ? chartCall.toolCallId : undefined,
    };
  }
  try {
    await t.test('a chart, a refused call and details in separate turns leave both components', async () => {
      const { kinds, errors, chartCallId } = await run([
        call(SLACK_PRESENT_CHART_TOOL_NAME, CHART),
        // Refused by the tool's own validation: the transcript records an error, so it never counts.
        call(SLACK_PRESENT_CARDS_TOOL_NAME, { cards: [] }),
        call(SLACK_PRESENT_DETAILS_TOOL_NAME, DETAILS),
        // The two-component budget counts the earlier turns' components.
        call(SLACK_PRESENT_CARDS_TOOL_NAME, { cards: [{ title: 'Ada' }] }),
        fauxAssistantMessage('Signups grew 12.5%.'),
      ]);
      assert.ok(closures > 1, 'Flue rendered fresh display tools for later turns');
      assert.ok(chartCallId);
      assert.deepEqual(historyAtDetails, [chartCallId], 'the details tool read the chart from the transcript');
      assert.deepEqual(kinds, ['chart', 'details']);
      assert.match(errors(SLACK_PRESENT_CARDS_TOOL_NAME)[0] ?? '', /1–10 cards/);
      assert.match(errors(SLACK_PRESENT_CARDS_TOOL_NAME)[1] ?? '', /already has two display components/);
      assert.deepEqual(errors(SLACK_PRESENT_DETAILS_TOOL_NAME), []);
    });

    await t.test('without the transcript, a later turn\'s closure would replace the whole list', async () => {
      withHistory = false;
      try {
        const { kinds } = await run([
          call(SLACK_PRESENT_CHART_TOOL_NAME, CHART),
          call(SLACK_PRESENT_DETAILS_TOOL_NAME, DETAILS),
          fauxAssistantMessage('Signups grew 12.5%.'),
        ]);
        assert.deepEqual(kinds, ['details'], 'the closure-only list is why the transcript history exists');
      } finally {
        withHistory = true;
      }
    });
  } finally {
    await flue.stop();
    await dispose();
  }
});
