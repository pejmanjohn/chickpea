import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { McpAuthenticatedPrincipal } from '../../src/auth/mcp-oauth-routes.ts';
import { workspaceManagementMcpFetch } from '../../src/management/mcp.ts';
import type { WorkspaceManagementServiceInput } from '../../src/management/service.ts';
import {
  buttonCount,
  type Call,
  type CardEvent,
  type CardState,
  type Effect,
  type Presentation,
  type Step,
  type ToolResult,
} from '../../src/mcp-cards/card-model.ts';
import { SLACK_SETTING_KEYS } from '../../src/slack/credentials.ts';
import { createManagementAdapterFixture } from './management-adapter-fixture.ts';

export const NOW = 1_800_000_000_000;
export const BASE_URL = 'https://chickpea.example.test';

export type ServerCall = (name: string, args?: Record<string, unknown>) => Promise<ToolResult & { structuredContent?: any }>;

/**
 * A fixture workspace with Core's real MCP server, and a clock the server
 * reads. Setup links are on this deployment's https origin, as in production.
 * With `cards`, the client declares MCP Apps at initialize, as ChatGPT does,
 * and every call goes in that session.
 */
export async function cardServer(
  t: TestContext,
  suffix: string,
  overrides: Partial<WorkspaceManagementServiceInput> = {},
  options: { cards?: boolean } = {},
) {
  const clock = { now: NOW };
  const f = await createManagementAdapterFixture(suffix, ({ settings }) => ({
    settings,
    now: () => clock.now,
    setupBaseUrl: BASE_URL,
    ...overrides,
  }));
  t.after(() => f.close());
  await f.settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme');
  const principal: McpAuthenticatedPrincipal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: `client_${suffix}`,
  };
  const fetch = workspaceManagementMcpFetch({ principal, service: f.service, baseUrl: BASE_URL });
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' };
  const session = options.cards
    ? (await fetch(jsonRequest(headers, {
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } },
          clientInfo: { name: 'openai-mcp', version: '1.0.0' },
        },
      }))).headers.get('mcp-session-id')
    : null;
  assert.equal(Boolean(session), Boolean(options.cards), 'a client that draws cards gets a session');
  const call: ServerCall = async (name, args = {}) => {
    const response = await fetch(jsonRequest(
      { ...headers, ...session ? { 'mcp-session-id': session } : {} },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    ));
    const body = await response.text();
    const json = body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
    return (JSON.parse(json) as { result: ToolResult }).result;
  };
  return { f, clock, call, teamId: f.owner.binding.slackTeamId };
}

/** A JSON-RPC POST as an HTTP client sends one, its length included. */
export function jsonRequest(headers: Record<string, string>, message: Record<string, unknown>): Request {
  const body = JSON.stringify(message);
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { ...headers, 'content-length': String(new TextEncoder().encode(body).byteLength) },
    body,
  });
}

export interface CardModelUnderTest<V extends { kind: string }, A extends string> {
  initial: CardState<V>;
  step(state: CardState<V>, event: CardEvent<A>): Step<V>;
  present(state: CardState<V>): Presentation<A>;
  /**
   * The calls the card may make by itself, kept apart from the model's own
   * list so a model edit cannot widen it. Every other call needs a press.
   */
  reads: ReadonlySet<string>;
  /**
   * A state that follows up what a press started, such as a creation the
   * person pressed Create for: its reads' answers may tell the host's model
   * how it ended. Absent, only a press and its own call's answer may.
   */
  followsPress?: (state: CardState<V>) => boolean;
  /**
   * Writes a timer may send again while the card still carries the press
   * that made them, with exactly its arguments, so a retry replays that
   * press. Absent, a timer sends no write.
   */
  replays?: ReadonlySet<string>;
}

/**
 * The ruling on what a card shows: no status code, no service's own words,
 * no connection ID. The tool's own result keeps them for the model.
 */
export function assertPlain(shown: Presentation, connectionIds: readonly string[]): void {
  const drawn = JSON.stringify(shown);
  assert.doesNotMatch(drawn, /HTTP \d{3}|\b[1-5]\d\d\b|Unauthorized|timed out/, drawn);
  for (const id of connectionIds) assert.equal(drawn.includes(id), false, `${id} drawn: ${drawn}`);
}

/** The setup link in a result, which a press that made it may then open. */
function setupUrlOf(result: ToolResult): unknown {
  const content = result.structuredContent as { setup?: { url?: unknown } } | undefined;
  return content?.setup?.url;
}

/**
 * A card's one rule: an event that is not a press (a mount, a re-read, a
 * timer, a reply, a failure) makes only reads and timers. It never writes,
 * sends a message, opens a link or tells the host's model anything, with two
 * exceptions. The reply to a call a press made carries on that press. It may
 * tell the model what the press did, open the setup link it carries,
 * because that press asked for the link to open, or, when the card will not
 * open that link, ask the chat for the fix instead. And while the card is
 * still busy with a press, a timer may send that press's call again, with
 * exactly its arguments, for a write the card `replays`. A state that follows
 * up a press may also tell the model how it ended.
 */
function onlyReads<V extends { kind: string }>(
  from: CardState<V>,
  event: CardEvent<string>,
  effects: readonly Effect[],
  model: Pick<CardModelUnderTest<V, string>, 'reads' | 'followsPress' | 'replays'>,
  pressed: WeakSet<Call>,
  pressedCalls: ReadonlySet<string>,
): void {
  if (event.type === 'press') return;
  const pressReply = event.type === 'reply' && pressed.has(event.call);
  for (const effect of effects) {
    if (effect.type === 'timer' || (effect.type === 'call' && model.reads.has(effect.call.tool))) continue;
    if (effect.type === 'call' && event.type === 'tick' && from.busy && model.replays?.has(effect.call.tool) === true &&
      pressedCalls.has(callKey(effect.call))) continue;
    if (effect.type === 'context' && (pressReply || model.followsPress?.(from) === true)) continue;
    if (event.type === 'reply' && pressReply &&
      ((effect.type === 'open' && effect.url === setupUrlOf(event.result)) || effect.type === 'message')) continue;
    assert.fail(`${event.type} made ${effect.type === 'call' ? `the write ${effect.call.tool}` : `a ${effect.type}`}`);
  }
}

/** A call by what it sends: its tool and arguments. */
function callKey(made: Call): string {
  return JSON.stringify([made.tool, made.args]);
}

type Refused = Extract<CardEvent<string>, { type: 'refused' }>['effect'];

/**
 * A host for a card's model: it runs calls on the server, records every
 * effect, and checks every presentation. After every step it also tries a
 * re-read, a tick, a refusal of the last link or message and a lost result on
 * a copy, as if the card came back into view, its timer fired or the host
 * answered just then, and follows their reads one reply or failure deep.
 */
export function cardHost<V extends { kind: string }, A extends string>(
  model: CardModelUnderTest<V, A>,
  server: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>,
  clock: { now: number },
) {
  let state = model.initial;
  const effects: Effect[] = [];
  const held: Array<{ call: Call; result: ToolResult }> = [];
  const pressed = new WeakSet<Call>();
  const pressedCalls = new Set<string>();

  async function follow(from: CardState<V>, event: CardEvent<A>, deep: boolean): Promise<void> {
    const next = model.step(from, event);
    onlyReads(from, event, next.effects, model, pressed, pressedCalls);
    if (!deep) return;
    for (const effect of next.effects) {
      if (effect.type !== 'call') continue;
      await follow(next.state, { type: 'unreachable', call: effect.call, now: clock.now }, false);
      await follow(next.state, { type: 'reply', call: effect.call, result: await server(effect.call.tool, effect.call.args), now: clock.now }, false);
    }
  }

  const self = {
    get state() { return state; },
    get shown(): Presentation<A> { return model.present(state); },
    effects,
    /** Calls made, by tool name. */
    calls: (tool?: string) => effects.flatMap((effect) => effect.type === 'call' && (!tool || effect.call.tool === tool) ? [effect.call] : []),
    /** A call `hold` matches runs on the server, and its answer waits in `held` for `answer`. */
    hold: (_call: Call): boolean => false,
    held,
    async dispatch(event: CardEvent<A>): Promise<void> {
      const next = model.step(state, event);
      onlyReads(state, event, next.effects, model, pressed, pressedCalls);
      if (event.type === 'press') {
        const made = next.effects.flatMap((effect) => effect.type === 'call' ? [effect.call] : []);
        // Only the latest press that called is one the card can still carry; a press that calls nothing keeps it.
        if (made.length > 0) pressedCalls.clear();
        for (const call of made) {
          pressed.add(call);
          pressedCalls.add(callKey(call));
        }
      }
      state = next.state;
      const shown = model.present(state);
      assert.ok(buttonCount(shown) <= 2, `at most two buttons: ${JSON.stringify(shown)}`);
      const refused = effects.findLast((effect): effect is Refused => effect.type === 'open' || effect.type === 'message') ??
        { type: 'open', url: 'https://refused.example/' };
      for (const idle of [
        { type: 'reread', now: clock.now }, { type: 'tick', now: clock.now },
        { type: 'refused', effect: refused, now: clock.now }, { type: 'no_result', now: clock.now },
      ] as const) await follow(state, idle, true);
      for (const effect of next.effects) {
        effects.push(effect);
        if (effect.type !== 'call') continue;
        const result = await server(effect.call.tool, effect.call.args);
        if (self.hold(effect.call)) held.push({ call: effect.call, result });
        else await self.dispatch({ type: 'reply', call: effect.call, result, now: clock.now });
      }
    },
    /** The oldest held call's answer arrives: its reply, or the host giving up on it. */
    async answer(how: 'reply' | 'unreachable' = 'reply'): Promise<void> {
      const { call, result } = held.shift()!;
      await self.dispatch(how === 'reply' ? { type: 'reply', call, result, now: clock.now } : { type: 'unreachable', call, now: clock.now });
    },
    result: (result: ToolResult) => self.dispatch({ type: 'result', result, now: clock.now }),
    press: (action: A) => self.dispatch({ type: 'press', action, now: clock.now }),
    labels: () => model.present(state).buttons.map(({ label, tone }) => `${label} (${tone})`),
  };
  return self;
}
