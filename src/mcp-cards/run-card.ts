import { applyHostContext, HostBridge, type CallToolResult } from './bridge.ts';
import {
  hostFailed,
  hostWrites,
  keptMemory,
  refusalOf,
  withResponseMeta,
  type Call,
  type CardEvent,
  type CardState,
  type Effect,
  type HostWrite,
  type Memory,
  type Presentation,
  type Step,
} from './card-model.ts';
import { mountCard } from './render.ts';

/**
 * A card in a host's iframe: host messages and presses become model events,
 * and the model's effects run here. ChatGPT keeps a card's widget state and
 * shows its model the `modelContent`, which holds only what the card already
 * told the model. Its outcome goes in `privateContent`, which ChatGPT hides
 * from the model beside a `modelContent`; it may hold an ID and the token of a
 * practice run still going, never another token or instructions. A chat that
 * reopens mounts the card with its first result, and the card comes back to
 * its outcome from that, then reads where things stand now.
 */

declare const CARD_VERSION: number;

const REREAD_GAP_MS = 1_000;

export interface CardModel<V extends { kind: string }, A extends string> {
  /** Its view is `{ kind: 'waiting' }` until the tool result comes. */
  initial: CardState<V>;
  step(state: CardState<V>, event: CardEvent<A>): Step<V>;
  present(state: CardState<V>): Presentation<A>;
}

export function runCard<V extends { kind: string }, A extends string>(name: string, model: CardModel<V, A>): void {
  const bridge = new HostBridge({ name, version: String(CARD_VERSION) });
  let state: CardState<V> = model.initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastReread = 0;
  /** The result this card mounted with, and whether it found what it kept; both until the first press. */
  let mounted: { result: CallToolResult; kept: boolean } | undefined;

  const card = mountCard(document.getElementById('card')!, (action) => dispatch({ type: 'press', action: action as A, now: Date.now() }));

  function dispatch(event: CardEvent<A>): void {
    const next = model.step(state, event);
    const writes = hostWrites(state, event, next, { keepsState: keepsState(), version: CARD_VERSION });
    state = next.state;
    if (event.type === 'press') mounted = undefined;
    card.render(model.present(state));
    for (const write of writes) send(write);
    for (const effect of next.effects) run(effect);
  }

  function send(write: HostWrite): void {
    if (write.type === 'state') void Promise.resolve(window.openai?.setWidgetState?.(write.state)).catch(() => undefined);
    else bridge.updateModelContext(write.text).catch(() => undefined);
  }

  function answered(made: Call, result: CallToolResult): void {
    // The host's own failure, with no refusal of Chickpea's in it: as if it never answered.
    if (hostFailed(result)) dispatch({ type: 'unreachable', call: made, now: Date.now() });
    else dispatch({ type: 'reply', call: made, result, now: Date.now() });
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'call': {
        const replied = (result: CallToolResult) => answered(effect.call, result);
        // A late failure with no word of Chickpea's says nothing the timeout did not, and the card may be
        // busy with a press made since. Only a late answer carrying Chickpea's word is news.
        const late = (result: CallToolResult) => { if (!result.isError || refusalOf(result)) replied(result); };
        bridge.callTool(effect.call.tool, effect.call.args, late).then(
          replied,
          () => dispatch({ type: 'unreachable', call: effect.call, now: Date.now() }),
        );
        return;
      }
      case 'timer':
        clearTimeout(timer);
        timer = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), effect.inMs);
        return;
      case 'message':
        bridge.sendMessage(effect).catch(() => dispatch({ type: 'refused', effect, now: Date.now() }));
        return;
      case 'open':
        bridge.openLink(effect.url).catch(() => dispatch({ type: 'refused', effect, now: Date.now() }));
        return;
      case 'context':
        // `hostWrites` sent it, in the widget state or as a model update.
        return;
    }
  }

  function reread(): void {
    const now = Date.now();
    if (now - lastReread < REREAD_GAP_MS || state.view.kind === 'waiting') return;
    lastReread = now;
    dispatch({ type: 'reread', now });
  }

  function mount(result: CallToolResult, kept: Memory | undefined): void {
    mounted = { result, kept: kept !== undefined };
    lastReread = Date.now();
    dispatch({ type: 'result', result, kept, now: Date.now() });
  }

  bridge.on('ui/notifications/tool-result', (result) => {
    if (state.view.kind !== 'waiting') return;
    // ChatGPT keeps the card's _meta, and its widget state, in globals it may set only now.
    mount(withResponseMeta(result as CallToolResult, window.openai?.toolResponseMetadata), kept());
  });
  bridge.on('ui/notifications/tool-cancelled', () => dispatch({ type: 'no_result', now: Date.now() }));
  bridge.on('ui/notifications/host-context-changed', () => applyHostContext(bridge.hostContext));
  // Widget state that comes after the result, before any press, mounts the card again with it.
  window.addEventListener('openai:set_globals', () => {
    const memory = mounted && !mounted.kept ? kept() : undefined;
    if (mounted && memory) mount(mounted.result, memory);
  });
  window.addEventListener('focus', reread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reread();
  });
  // Scrolled back to, past newer cards in the chat: what it shows may have changed since.
  let inView = true;
  new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && !inView) reread();
    inView = entry?.isIntersecting ?? inView;
  }).observe(document.body);

  card.render(model.present(state));
  bridge.connect().then(
    () => applyHostContext(bridge.hostContext),
    () => dispatch({ type: 'no_result', now: Date.now() }),
  );
}

/** ChatGPT keeps a card's widget state; a host without it keeps nothing. */
function keepsState(): boolean {
  return typeof window.openai?.setWidgetState === 'function';
}

/** What this version of the card kept in ChatGPT's widget state. */
function kept(): Memory | undefined {
  return keptMemory(window.openai?.widgetState, CARD_VERSION);
}
