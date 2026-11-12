import { applyHostContext, HostBridge, type CallToolResult } from './bridge.ts';
import {
  boundedTold,
  hostFailed,
  keptState,
  refusalOf,
  withResponseMeta,
  type Call,
  type CardEvent,
  type CardState,
  type Effect,
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
/** A sentence ChatGPT kept that is longer than any a card writes is not one. */
const TOLD_SENTENCE_MAX = 1_000;

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
    const remembered = next.state.told !== state.told || next.state.outcome !== state.outcome;
    state = next.state;
    if (event.type === 'press') mounted = undefined;
    if (remembered && event.type !== 'result') keep(state);
    card.render(model.present(state));
    for (const effect of next.effects) run(effect);
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
        bridge.updateModelContext(effect.text).catch(() => undefined);
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
    mount(withResponseMeta(result as CallToolResult, window.openai?.toolResponseMetadata), keptMemory());
  });
  bridge.on('ui/notifications/tool-cancelled', () => dispatch({ type: 'no_result', now: Date.now() }));
  bridge.on('ui/notifications/host-context-changed', () => applyHostContext(bridge.hostContext));
  // Widget state that comes after the result, before any press, mounts the card again with it.
  window.addEventListener('openai:set_globals', () => {
    const kept = mounted && !mounted.kept ? keptMemory() : undefined;
    if (mounted && kept) mount(mounted.result, kept);
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

/** What this version of the card kept in ChatGPT's widget state, read as untrusted. */
function keptMemory(): Memory | undefined {
  const saved = window.openai?.widgetState as { privateContent?: { card?: { version?: unknown; told?: unknown; outcome?: unknown } } } | undefined;
  const card = saved?.privateContent?.card;
  if (card?.version !== CARD_VERSION || !Array.isArray(card.told)) return undefined;
  const told = card.told.filter((line): line is string => typeof line === 'string' && line.length <= TOLD_SENTENCE_MAX);
  return { told: boundedTold(told), ...card.outcome === undefined ? {} : { outcome: card.outcome } };
}

function keep(state: CardState<{ kind: string }>): void {
  void Promise.resolve(window.openai?.setWidgetState?.(keptState(state, CARD_VERSION))).catch(() => undefined);
}
