import type {
  CardSpec,
  PresentCardsSpec,
  PresentChartSpec,
  PresentDetailsSpec,
} from './presentation-tools.ts';
import { markdownToSlackMrkdwn } from '../message-format.ts';
import { uiActionId, uiBlockId, uiValue } from './surface.ts';

/**
 * Host-compiled display components that ride in the answer message after the
 * text and before the footer. Model text appears only as plain_text or as
 * escaped mrkdwn; ids and values are structural. Shapes follow docs.slack.dev
 * (card, carousel, data_visualization, container; read 2026-09-26).
 */

type Block = Record<string, unknown>;

export interface RenderedDisplay {
  blocks: Block[];
  /**
   * Fallback appended to the message `text` (notifications, screen readers).
   * Raw, like a table's: the message renderer escapes `&`, `<` and `>` once.
   */
  fallbackText: string;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clamp(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function plain(text: string, max: number) {
  return { type: 'plain_text', text: clamp(text, max), emoji: true };
}

// ── cards ────────────────────────────────────────────────────────────────

/** Card button slots: each card owns three (the link, then its actions), so a value names its card and button. */
export function cardButtonIndex(card: number, button: number): number {
  return card * 3 + button;
}

/** The request button a slot names; the link and url buttons never start a turn. */
export function cardRequestButtonAt(
  spec: PresentCardsSpec,
  slot: number,
): { card: CardSpec; label: string } | undefined {
  const card = spec.cards[Math.floor(slot / 3)];
  const action = card?.actions?.[(slot % 3) - 1];
  return card && action && !action.url ? { card, label: action.label } : undefined;
}

function cardBlock(card: CardSpec, index: number, surfaceId: string | undefined): Block {
  const buttons: Block[] = [];
  if (card.link) {
    buttons.push({ type: 'button', action_id: uiActionId('ui', 'link', cardButtonIndex(index, 0)), text: plain('Open', 75), url: card.link });
  }
  (card.actions ?? []).forEach((action, actionIndex) => {
    const slot = cardButtonIndex(index, actionIndex + 1);
    if (action.url) {
      buttons.push({ type: 'button', action_id: uiActionId('ui', 'link', slot), text: plain(action.label, 75), url: action.url });
    } else if (surfaceId) {
      buttons.push({ type: 'button', action_id: uiActionId('ui', 'cards', slot), text: plain(action.label, 75), value: uiValue(surfaceId, slot) });
    }
  });
  return {
    type: 'card',
    title: plain(card.title, 150),
    ...(card.subtitle ? { subtitle: plain(card.subtitle, 150) } : {}),
    ...(card.body ? { body: plain(card.body, 200) } : {}),
    ...(card.footnote ? { subtext: plain(card.footnote, 200) } : {}),
    ...(card.imageUrl ? { hero_image: { type: 'image', image_url: card.imageUrl, alt_text: clamp(card.title, 2_000) } } : {}),
    ...(buttons.length ? { actions: buttons.slice(0, 3) } : {}),
  };
}

export function renderCards(spec: PresentCardsSpec, surfaceId?: string): RenderedDisplay {
  // A click reports the block id of the card it sits in (Slack's carousel
  // example ids each card), so every card names the surface, not only the
  // carousel: index 1 is the carousel or the lone card, cards follow.
  const blockId = (index: number) => (surfaceId ? { block_id: uiBlockId('ui', surfaceId, index) } : {});
  const cards = spec.cards.map((card, index) => cardBlock(card, index, surfaceId));
  const blocks: Block[] = [];
  if (spec.caption) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${escape(spec.caption)}*` } });
  blocks.push(cards.length === 1
    ? { ...cards[0]!, ...blockId(1) }
    : { type: 'carousel', ...blockId(1), elements: cards.map((card, index) => ({ ...card, ...blockId(index + 2) })) });
  const lines = spec.cards.map((card) => {
    const detail = card.subtitle ? ` — ${card.subtitle}` : '';
    return `• ${card.title}${detail}${card.link ? ` (${card.link})` : ''}`;
  });
  return { blocks, fallbackText: [spec.caption, ...lines].filter(Boolean).join('\n') };
}

// ── charts ───────────────────────────────────────────────────────────────

export function renderChart(spec: PresentChartSpec): RenderedDisplay {
  const chart = spec.type === 'pie'
    ? {
        type: 'pie',
        segments: spec.categories.map((label, index) => ({ label, value: spec.series[0]!.values[index]! })),
      }
    : {
        type: spec.type,
        series: spec.series.map((series) => ({
          name: series.name,
          data: spec.categories.map((label, index) => ({ label, value: series.values[index]! })),
        })),
        axis_config: {
          categories: spec.categories,
          ...(spec.xLabel ? { x_label: spec.xLabel } : {}),
          ...(spec.yLabel ? { y_label: spec.yLabel } : {}),
        },
      };
  const rows = spec.series.map((series) =>
    `${spec.series.length > 1 ? `${series.name}: ` : ''}${spec.categories.map((label, index) => `${label} ${series.values[index]}`).join(', ')}`);
  return {
    blocks: [{ type: 'data_visualization', title: spec.title, chart }],
    fallbackText: `${spec.title}\n${rows.join('\n')}`,
  };
}

// ── details ──────────────────────────────────────────────────────────────

const MAX_SECTION = 3_000;
const MAX_CHILDREN = 10;

/** Split escaped mrkdwn at paragraph, then line, boundaries into ≤3,000-character sections. */
function sections(mrkdwn: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const paragraph of mrkdwn.split(/\n{2,}/)) {
    const pieces = paragraph.length <= MAX_SECTION ? [paragraph] : paragraph.match(new RegExp(`[\\s\\S]{1,${MAX_SECTION}}`, 'g')) ?? [];
    for (const piece of pieces) {
      const next = current ? `${current}\n\n${piece}` : piece;
      if (next.length <= MAX_SECTION) {
        current = next;
      } else {
        if (current) out.push(current);
        current = piece;
      }
    }
  }
  if (current) out.push(current);
  return out.slice(0, MAX_CHILDREN);
}

export function renderDetails(spec: PresentDetailsSpec): RenderedDisplay {
  const children = sections(markdownToSlackMrkdwn(spec.markdown)).map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }));
  return {
    blocks: [{
      type: 'container',
      title: plain(spec.title, 150),
      is_collapsible: true,
      default_collapsed: true,
      child_blocks: children,
    }],
    fallbackText: `Details: ${spec.title}`,
  };
}
