import type { Block, Inline, Presentation, Row } from './card-model.ts';

/**
 * Draws a presentation. Every value from a tool result goes in as text, never
 * markup; the only markup is the fixed avatar art below. An Agent's picture
 * is an image's source, which the card's CSP limits to Chickpea's origin.
 */

const BEAN = (tile: string, hood: string, face: string) =>
  `<svg viewBox="0 0 44 44" aria-hidden="true" focusable="false"><rect width="44" height="44" rx="12" fill="${tile}"/>` +
  `<path d="M22 6c-9 0-14 8-14 18v14h28V24C36 14 31 6 22 6z" fill="${hood}"/>` +
  `<path d="M22 12c-6 0-9.5 6-9.5 13.5S16 38 22 38s9.5-5 9.5-12.5S28 12 22 12z" fill="${face}"/>` +
  '<circle cx="18.5" cy="26" r="1.3" fill="#3a2a1e"/><circle cx="25.5" cy="26" r="1.3" fill="#3a2a1e"/>' +
  '<path d="M20.5 30.2q1.5 1.2 3 0" stroke="#3a2a1e" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>';

const AVATARS = {
  agent: BEAN('#3a2a1e', '#E8901A', '#f3d9b1'),
  alert: BEAN('#2a1f2e', '#c2453a', '#f1d3b8'),
} as const;

const STEP_WORDS = { done: 'done', now: 'in progress', todo: 'to do', failed: 'failed' } as const;
const ROW_MARKS: Record<Exclude<Row['icon'], 'tile'>, { glyph: string; words: string }> = {
  done: { glyph: '✓', words: 'done' },
  now: { glyph: '', words: 'in progress' },
  failed: { glyph: '!', words: 'needs attention' },
  warning: { glyph: '!', words: 'warning' },
  unknown: { glyph: '?', words: 'unknown' },
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Pictures that did not load: the art stands in, and a redraw does not try again. */
const unloadable = new Set<string>();

function avatar(kind: 'agent' | 'alert', size: 'lg' | 'sm', url: string | undefined): HTMLElement {
  const holder = element('span', `cp-avatar cp-avatar-${size}`);
  const art = () => {
    holder.innerHTML = AVATARS[kind];
  };
  if (!url || unloadable.has(url)) {
    art();
    return holder;
  }
  // The picture hides the alert art, so a ring keeps its warning.
  if (kind === 'alert') holder.classList.add('cp-avatar-alert');
  // Decorative: the name beside it says whose it is.
  const image = element('img');
  image.alt = '';
  image.decoding = 'async';
  image.addEventListener('error', () => {
    unloadable.add(url);
    art();
  }, { once: true });
  image.src = url;
  holder.append(image);
  return holder;
}

function inline(parts: Inline[]): HTMLElement {
  const line = element('p', 'cp-sub');
  for (const part of parts) line.append(part.tone ? element('span', `cp-${part.tone}`, part.text) : part.text);
  return line;
}

function block(item: Block, avatarKind: 'agent' | 'alert', avatarUrl: string | undefined): HTMLElement {
  switch (item.kind) {
    case 'text':
      return element('p', 'cp-text', item.text);
    case 'quote':
      return element('blockquote', 'cp-quote', item.text);
    case 'section':
      return element('h3', 'cp-sect', item.label);
    case 'note':
      return element('p', `cp-note${item.tone ? ` cp-${item.tone}` : ''}`, item.text);
    case 'exchange': {
      const said = (who: string, text: string, lines: 2 | 5) => {
        const body = element('div');
        body.append(element('span', 'sr-only', `${who}: `), element('div', `cp-said ${item.whole ? 'cp-said-whole' : `cp-clamp-${lines}`}`, text));
        return body;
      };
      const initial = element('span', 'cp-init', 'Y');
      initial.setAttribute('aria-hidden', 'true');
      const person = element('div', 'cp-msg');
      person.append(initial, said('You', item.ask, 2));
      const agent = element('div', 'cp-msg');
      agent.append(avatar(avatarKind, 'sm', avatarUrl), said(item.agent, item.answer, 5));
      const thread = element('div', 'cp-thread');
      thread.append(person, agent);
      return thread;
    }
    case 'line': {
      const line = element('p', 'cp-line');
      for (const part of item.parts) {
        line.append('chip' in part ? element('span', 'cp-chip', part.chip) : part.strong ? element('b', undefined, part.text) : part.text);
      }
      return line;
    }
    case 'steps': {
      const list = element('ul', 'cp-steps');
      for (const { label, state } of item.steps) {
        const row = element('li');
        const icon = element('span', `cp-ic cp-ic-${state}`, state === 'done' ? '✓' : state === 'failed' ? '!' : '');
        icon.setAttribute('aria-hidden', 'true');
        row.append(icon, label, element('span', 'sr-only', ` (${STEP_WORDS[state]})`));
        list.append(row);
      }
      return list;
    }
    case 'rows': {
      const list = element('ul', 'cp-rows');
      list.append(...item.rows.map((each) => row(each, avatarKind, avatarUrl)));
      return list;
    }
    case 'panes': {
      const pair = element('div', 'cp-panes');
      for (const { label, text } of item.panes) {
        const pane = element('section', 'cp-pane');
        pane.append(element('h3', 'cp-pane-label', label), element('div', 'cp-pane-text', text));
        pair.append(pane);
      }
      return pair;
    }
  }
}

function row(item: Row, avatarKind: 'agent' | 'alert', avatarUrl: string | undefined): HTMLElement {
  const line = element('li', 'cp-row');
  if (item.icon === 'tile') {
    const tile = element('span', 'cp-tile', item.tile ?? '');
    tile.setAttribute('aria-hidden', 'true');
    line.append(tile);
  } else {
    const mark = ROW_MARKS[item.icon];
    const icon = element('span', `cp-ic cp-ic-${item.icon}`, mark.glyph);
    icon.setAttribute('aria-hidden', 'true');
    line.append(icon);
  }
  const body = element('div', 'cp-row-body');
  const title = element('div', 'cp-row-title', item.title);
  if (item.icon !== 'tile') title.append(element('span', 'sr-only', ` (${ROW_MARKS[item.icon].words})`));
  body.append(title);
  if (item.chip) {
    const detail = element('div', `cp-row-detail${item.tone ? ` cp-${item.tone}` : ''}`);
    detail.append(element('span', 'cp-chip', item.chip), ...item.detail ? [' ', item.detail] : []);
    body.append(detail);
  } else if (item.detail) {
    body.append(element('div', `cp-row-detail${item.tone ? ` cp-${item.tone}` : ''}`, item.detail));
  }
  line.append(body);
  if (item.control) {
    const { label, action, style, expanded } = item.control;
    const node = control(label, action, style === 'link' ? 'cp-link cp-link-go' : style === 'toggle' ? 'cp-link' : `btn btn-sm cp-btn-${style}`);
    if (expanded !== undefined) node.setAttribute('aria-expanded', String(expanded));
    line.append(node);
  }
  if (item.open) {
    const open = element('div', 'cp-row-open');
    open.append(...item.open.map((each) => block(each, avatarKind, avatarUrl)));
    line.append(open);
  }
  return line;
}

function control(label: string, action: string, className: string): HTMLButtonElement {
  const node = element('button', `${className} cursor-interaction`, label);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

export interface CardRoot {
  render(presentation: Presentation): void;
}

/**
 * Buttons, and every part of the card that holds one, stay the same nodes
 * while they stay the same: a press that also focuses the card's frame
 * re-reads it, and a button replaced between mousedown and mouseup never
 * gets its click. When a redraw takes away the node that had focus, focus
 * moves to the button that does the same thing, such as a row's toggle, or
 * else to the title, so a keyboard or screen reader stays on the card.
 */
export function mountCard(root: HTMLElement, onAction: (action: string) => void): CardRoot {
  const status = element('p', 'sr-only');
  status.setAttribute('aria-live', 'polite');
  const card = element('main', 'cp-card');
  const content = element('div', 'cp-content');
  const actions = element('div', 'cp-acts');
  const error = element('p', 'cp-error');
  error.setAttribute('role', 'alert');
  card.append(content, actions, error);
  root.replaceChildren(status, card);
  card.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest('button[data-action]');
    if (button instanceof HTMLButtonElement && !button.disabled) onAction(button.dataset.action!);
  });
  let drawn = '';
  let drawnButtons = '';
  let drawnBlocks = new Map<string, HTMLElement>();

  return {
    render(presentation) {
      const key = JSON.stringify(presentation);
      if (key === drawn) return;
      drawn = key;
      const focused = card.contains(document.activeElement);
      const focusedAction = focused && document.activeElement instanceof HTMLButtonElement ? document.activeElement.dataset.action : undefined;
      const announce = presentation.announce ?? presentation.title;
      if (status.textContent !== announce) status.textContent = announce;

      const header = element('header', 'cp-hdr');
      const avatarKind = presentation.avatar === 'none' ? 'agent' : presentation.avatar;
      const { avatarUrl } = presentation;
      if (presentation.avatar !== 'none') header.append(avatar(presentation.avatar, 'lg', avatarUrl));
      const heading = element('div', 'cp-heading');
      const title = element('h2', 'cp-title');
      title.tabIndex = -1;
      if (presentation.done) {
        const mark = element('span', 'cp-ok', '✓ ');
        mark.setAttribute('aria-hidden', 'true');
        title.append(mark);
      }
      title.append(presentation.title);
      heading.append(title);
      if (presentation.subtitle) heading.append(inline(presentation.subtitle));
      header.append(heading);
      const blocks = new Map<string, HTMLElement>();
      const drawnNow = presentation.blocks.map((item) => {
        const key = JSON.stringify([item, avatarKind, avatarUrl]);
        const node = (!blocks.has(key) && drawnBlocks.get(key)) || block(item, avatarKind, avatarUrl);
        if (!blocks.has(key)) blocks.set(key, node);
        return node;
      });
      drawnBlocks = blocks;
      content.replaceChildren(
        header,
        ...drawnNow,
        ...presentation.foot ? [element('p', 'cp-foot', presentation.foot)] : [],
      );

      const buttons = JSON.stringify(presentation.buttons);
      if (buttons !== drawnButtons) {
        drawnButtons = buttons;
        actions.replaceChildren(...presentation.buttons.map((button) => control(button.label, button.action, `btn cp-btn-${button.tone}`)));
      }
      actions.hidden = presentation.buttons.length === 0;
      for (const node of card.querySelectorAll('button')) {
        node.disabled = presentation.busy;
        node.toggleAttribute('aria-busy', presentation.busy);
      }
      error.textContent = presentation.error ?? '';
      error.hidden = !presentation.error;
      if (focused && !card.contains(document.activeElement)) {
        const same = [...card.querySelectorAll<HTMLButtonElement>('button[data-action]')].find((node) => node.dataset.action === focusedAction);
        (same ?? title).focus({ preventScroll: true });
      }
    },
  };
}
