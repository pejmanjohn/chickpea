import type { Action, Block, Inline, Presentation } from './model.ts';

/**
 * Draws a presentation. Every value from a tool result goes in as text, never
 * markup; the only markup is the fixed avatar art below.
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

function avatar(kind: 'agent' | 'alert', size: 'lg' | 'sm' = 'lg'): HTMLElement {
  const holder = element('span', `cp-avatar cp-avatar-${size}`);
  holder.innerHTML = AVATARS[kind];
  return holder;
}

function inline(parts: Inline[]): HTMLElement {
  const line = element('p', 'cp-sub');
  for (const part of parts) line.append(part.tone ? element('span', `cp-${part.tone}`, part.text) : part.text);
  return line;
}

function block(item: Block, avatarKind: 'agent' | 'alert'): HTMLElement {
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
      const thread = element('div', 'cp-thread');
      const person = element('div', 'cp-msg');
      const who = element('div', 'cp-who', 'You');
      who.append(element('span', 'cp-who-note', 'example'));
      const personBody = element('div');
      personBody.append(who, element('div', undefined, item.ask));
      person.append(element('span', 'cp-init', 'Y'), personBody);
      const agent = element('div', 'cp-msg');
      const agentBody = element('div');
      agentBody.append(element('div', 'cp-who', item.agent), element('div', undefined, item.answer));
      agent.append(avatar(avatarKind, 'sm'), agentBody);
      thread.append(person, agent);
      return thread;
    }
    case 'facts': {
      const list = element('dl', 'cp-facts');
      for (const row of item.rows) {
        const value = element('dd', undefined, row.value);
        for (const chip of row.chips ?? []) value.append(element('span', 'cp-chip', chip), ' ');
        if (row.note) value.append(element('span', 'cp-faint', row.note));
        list.append(element('dt', undefined, row.label), value);
      }
      return list;
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
  }
}

export interface CardRoot {
  render(presentation: Presentation): void;
}

/**
 * Buttons stay the same nodes while the buttons stay the same: a press that
 * also focuses the card's frame re-reads it, and a button replaced between
 * mousedown and mouseup never gets its click.
 */
export function mountCard(root: HTMLElement, onAction: (action: Action) => void): CardRoot {
  const status = element('p', 'sr-only');
  status.setAttribute('aria-live', 'polite');
  const card = element('main', 'cp-card');
  const content = element('div', 'cp-content');
  const actions = element('div', 'cp-acts');
  const error = element('p', 'cp-error');
  error.setAttribute('role', 'alert');
  card.append(content, actions, error);
  root.replaceChildren(status, card);
  actions.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest('button[data-action]');
    if (button instanceof HTMLButtonElement && !button.disabled) onAction(button.dataset.action as Action);
  });
  let drawn = '';
  let drawnButtons = '';

  return {
    render(presentation) {
      const key = JSON.stringify(presentation);
      if (key === drawn) return;
      drawn = key;
      if (status.textContent !== presentation.title) status.textContent = presentation.title;

      const header = element('header', 'cp-hdr');
      const avatarKind = presentation.avatar === 'none' ? 'agent' : presentation.avatar;
      if (presentation.avatar !== 'none') header.append(avatar(presentation.avatar));
      const heading = element('div', 'cp-heading');
      const title = element('h2', 'cp-title');
      if (presentation.done) {
        const mark = element('span', 'cp-ok', '✓ ');
        mark.setAttribute('aria-hidden', 'true');
        title.append(mark);
      }
      title.append(presentation.title);
      heading.append(title);
      if (presentation.subtitle) heading.append(inline(presentation.subtitle));
      header.append(heading);
      content.replaceChildren(
        header,
        ...presentation.blocks.map((item) => block(item, avatarKind)),
        ...presentation.foot ? [element('p', 'cp-foot', presentation.foot)] : [],
      );

      const buttons = JSON.stringify(presentation.buttons);
      if (buttons !== drawnButtons) {
        drawnButtons = buttons;
        actions.replaceChildren(...presentation.buttons.map((button) => {
          const node = element('button', `btn cursor-interaction cp-btn-${button.tone}`, button.label);
          node.type = 'button';
          node.dataset.action = button.action;
          return node;
        }));
      }
      actions.hidden = presentation.buttons.length === 0;
      for (const node of actions.querySelectorAll('button')) {
        node.disabled = presentation.busy;
        node.toggleAttribute('aria-busy', presentation.busy);
      }
      error.textContent = presentation.error ?? '';
      error.hidden = !presentation.error;
    },
  };
}
