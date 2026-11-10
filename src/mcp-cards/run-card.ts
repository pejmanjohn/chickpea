import { applyHostContext, HostBridge, type CallToolResult } from './bridge.ts';
import type { CardEvent, CardState, Effect, Presentation, Step } from './card-model.ts';
import { mountCard } from './render.ts';

/**
 * A card in a host's iframe: host messages and presses become model events,
 * and the model's effects run here. What the card has done is kept in
 * ChatGPT's widget state, as private content its model never reads, so a
 * card that mounts again (a reopened chat) resumes where it was instead of
 * offering its first buttons again.
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
  const kept = keptView<V>();
  let state: CardState<V> = kept ? { view: kept.view, busy: false, seq: kept.seq } : model.initial;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastReread = 0;

  const card = mountCard(document.getElementById('card')!, (action) => dispatch({ type: 'press', action: action as A, now: Date.now() }));

  function dispatch(event: CardEvent<A>): void {
    const next = model.step(state, event);
    const moved = next.state.view !== state.view;
    state = next.state;
    if (moved) keep(state);
    card.render(model.present(state));
    for (const effect of next.effects) run(effect);
  }

  function run(effect: Effect): void {
    switch (effect.type) {
      case 'call': {
        const replied = (result: CallToolResult) => dispatch({ type: 'reply', call: effect.call, result, now: Date.now() });
        bridge.callTool(effect.call.tool, effect.call.args, replied).then(
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

  bridge.on('ui/notifications/tool-result', (result) => {
    // A card that kept its state has moved past this result already.
    if (kept || state.view.kind !== 'waiting') return;
    dispatch({ type: 'result', result: result as CallToolResult, now: Date.now() });
    // A result can be old: a reopened chat mounts the card with the one it had then.
    reread();
  });
  bridge.on('ui/notifications/tool-cancelled', () => dispatch({ type: 'no_result', now: Date.now() }));
  bridge.on('ui/notifications/host-context-changed', () => applyHostContext(bridge.hostContext));
  window.addEventListener('focus', reread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reread();
  });

  card.render(model.present(state));
  bridge.connect().then(() => {
    applyHostContext(bridge.hostContext);
    if (kept) reread();
  }, () => dispatch({ type: 'no_result', now: Date.now() }));
}

function keptView<V extends { kind: string }>(): { view: V; seq: number } | undefined {
  const saved = window.openai?.widgetState as { privateContent?: { card?: { version?: unknown; view?: V; seq?: number } } } | undefined;
  const card = saved?.privateContent?.card;
  const view = card?.view;
  return card?.version === CARD_VERSION && view && typeof view.kind === 'string'
    ? { view, seq: card.seq ?? 0 }
    : undefined;
}

function keep<V extends { kind: string }>({ view, seq }: CardState<V>): void {
  if (view.kind === 'waiting') return;
  const card = { version: CARD_VERSION, view, seq };
  void Promise.resolve(window.openai?.setWidgetState?.({ privateContent: { card } })).catch(() => undefined);
}
