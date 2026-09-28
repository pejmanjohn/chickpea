import { preserveSlackRichTextLinks } from './rich-text-links.ts';

/**
 * The readable content of one Slack message for model context.
 *
 * People write in `text` (plus rich_text blocks, whose links are preserved).
 * Apps often do not: an alert from PagerDuty or Sentry may carry an empty or
 * summary-only `text` and put the substance in section blocks or legacy
 * attachments. Those parts are appended once each, bounded, so an alert is
 * visible to the Agent the way it is visible to a person in Slack.
 */

/** Drawn from blocks and attachments per message: an alert with its fields fits. */
export const MAX_SLACK_MESSAGE_EXTRA_CHARS = 4_000;
const MAX_PART_CHARS = 1_500;
const MAX_PARTS = 24;
const MAX_FILES_PER_MESSAGE = 10;

/** Characters a listed filename may keep; everything else folds to `-`. */
const MANIFEST_FILENAME_CHARACTER = /[A-Za-z0-9._ -]/;
/** Long enough to recognize a file, short enough to not carry a sentence. */
const MAX_MANIFEST_FILENAME_CHARS = 64;

export interface SlackMessageContentSource {
  text?: string;
  blocks?: unknown[];
  attachments?: unknown[];
}

export interface SlackFileSummary {
  /** Member-supplied label reduced to the manifest allowlist. */
  name: string;
  /** Slack's short file type (pdf, csv, png) or a MIME type. */
  type?: string;
  sizeBytes?: number;
}

export function slackMessageText(message: SlackMessageContentSource): string {
  const base = preserveSlackRichTextLinks(message.text, message.blocks);
  const parts: string[] = [];
  const seen = (value: string) => base.includes(value) || parts.some((part) => part.includes(value));
  const add = (value: unknown) => {
    if (parts.length >= MAX_PARTS || typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen(trimmed)) return;
    parts.push(trimmed.length > MAX_PART_CHARS ? `${trimmed.slice(0, MAX_PART_CHARS)}…` : trimmed);
  };
  for (const block of Array.isArray(message.blocks) ? message.blocks : []) {
    if (!isRecord(block)) continue;
    if (block.type === 'header' || block.type === 'section') {
      add(textObject(block.text));
      if (Array.isArray(block.fields)) for (const field of block.fields) add(textObject(field));
    } else if (block.type === 'context' && Array.isArray(block.elements)) {
      add(block.elements.map(textObject).filter(Boolean).join(' '));
    }
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const attachment of attachments) {
    if (!isRecord(attachment)) continue;
    const before = parts.length;
    add(attachment.pretext);
    add(attachment.author_name);
    const title = typeof attachment.title === 'string' ? attachment.title.trim() : '';
    const titleLink = typeof attachment.title_link === 'string' ? attachment.title_link.trim() : '';
    add(title && titleLink && !title.includes(titleLink) ? `${title} (${titleLink})` : title);
    add(attachment.text);
    if (Array.isArray(attachment.fields)) {
      for (const field of attachment.fields) {
        if (!isRecord(field)) continue;
        const label = typeof field.title === 'string' ? field.title.trim() : '';
        const value = typeof field.value === 'string' ? field.value.trim() : '';
        add(label && value ? `${label}: ${value}` : label || value);
      }
    }
    add(attachment.footer);
    // Fallback is the notification text; use it only when nothing richer exists.
    if (parts.length === before) add(attachment.fallback);
  }
  // The message's own text is bounded later with the rest of the context;
  // only what is drawn from blocks and attachments is capped here.
  let extra = parts.join('\n');
  if (extra.length > MAX_SLACK_MESSAGE_EXTRA_CHARS) extra = `${extra.slice(0, MAX_SLACK_MESSAGE_EXTRA_CHARS)}…`;
  return [base, extra].filter(Boolean).join('\n');
}

/** Names, types, and sizes of a message's files. Never contents or URLs. */
export function slackFileSummaries(files: unknown): SlackFileSummary[] {
  if (!Array.isArray(files)) return [];
  const summaries: SlackFileSummary[] = [];
  for (const file of files) {
    if (summaries.length >= MAX_FILES_PER_MESSAGE) break;
    if (!isRecord(file) || file.mode === 'tombstone' || file.mode === 'hidden_by_limit') continue;
    const rawName = typeof file.name === 'string' && file.name.trim()
      ? file.name
      : typeof file.title === 'string' ? file.title : '';
    const type = typeof file.filetype === 'string' && /^[a-z0-9_+.-]{1,32}$/i.test(file.filetype)
      ? file.filetype.toLowerCase()
      : typeof file.mimetype === 'string' && /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/i.test(file.mimetype)
        ? file.mimetype.toLowerCase()
        : undefined;
    const size = typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0
      ? file.size
      : undefined;
    summaries.push({
      name: manifestFileLabel(rawName),
      ...(type ? { type } : {}),
      ...(size !== undefined ? { sizeBytes: size } : {}),
    });
  }
  return summaries;
}

/** One file as a short label: `report.pdf (pdf, 120 KB)`. */
export function formatSlackFileSummary(file: SlackFileSummary): string {
  const details = [file.type, file.sizeBytes !== undefined ? formatBytes(file.sizeBytes) : undefined]
    .filter(Boolean);
  return details.length ? `${file.name} (${details.join(', ')})` : file.name;
}

/**
 * A member-supplied filename reduced to the manifest allowlist and bounded,
 * so a listing can name a file without carrying a sentence into the prompt.
 */
export function manifestFileLabel(value: string, fallback = 'file'): string {
  const folded = Array.from(value, (character) =>
    MANIFEST_FILENAME_CHARACTER.test(character) ? character : '-')
    .join('')
    .replace(/[-\s]{2,}/g, '-')
    .slice(0, MAX_MANIFEST_FILENAME_CHARS)
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return folded || fallback;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function textObject(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.text === 'string' ? value.text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
