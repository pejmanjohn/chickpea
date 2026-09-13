import { detailsColumn, richTextContent, semanticColumn, textCell } from './schema.ts';
import { SlackListError, type ClearTaskField, type ListCell, type ListSnapshot, type TaskFields } from './types.ts';

const DEADLINE_LINE = /^Deadline: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([^\n]+\)$/gm;

/** Only fields requested by the caller are written; schema IDs never come from names. */
export function taskCells(snapshot: ListSnapshot, fields: TaskFields, clear: ClearTaskField[], timezone?: string): ListCell[] {
  if (new Set(clear).size !== clear.length || clear.some(field => fields[field] !== undefined)) {
    throw new SlackListError('conflicting_fields', 'A field cannot be both set and cleared. Nothing was written.');
  }
  const cells: ListCell[] = [];
  if (fields.title !== undefined) cells.push(textCell(semanticColumn(snapshot.columns, 'title').id, fields.title));
  if (fields.assignees !== undefined || clear.includes('assignees')) {
    cells.push({ column_id: semanticColumn(snapshot.columns, 'assignees').id, user: fields.assignees ?? [] });
  }
  if (fields.completed !== undefined) cells.push({ column_id: semanticColumn(snapshot.columns, 'completed').id, checkbox: fields.completed });
  let deadline: string | undefined;
  const dueChanged = fields.due !== undefined || clear.includes('due');
  if (dueChanged) {
    const column = semanticColumn(snapshot.columns, 'due');
    if (fields.due) {
      validateDate(fields.due.date);
      const zone = fields.due.timezone ?? timezone;
      let timestamp: number | undefined;
      if (fields.due.time) {
        if (!zone) throw new SlackListError('timezone_required', 'An exact deadline needs a timezone from the request or Slack profile.');
        timestamp = localDeadline(fields.due.date, fields.due.time, zone);
        deadline = `Deadline: ${fields.due.date} ${fields.due.time} (${zone})`;
      }
      cells.push({ column_id: column.id, date: [fields.due.date], timestamp: timestamp === undefined ? [] : [timestamp] });
    } else cells.push({ column_id: column.id, date: [], timestamp: [] });
  }
  const existing = snapshot.items[0];
  const textColumns = snapshot.columns.filter(c => c.type === 'text' && !c.is_primary_column);
  const deadlineColumns = textColumns.filter(c => deadlineNotes(existing?.fields.find(f => f.column_id === c.id)?.rich_text).length);
  if (deadlineColumns.length > 1 && dueChanged) throw new SlackListError('duplicate_deadline_notes', 'Several context columns contain deadline notes. Remove the duplicate deadline notes in Slack before changing or clearing this deadline. Choosing a context column cannot resolve this. Nothing was written.');
  const needsDetails = fields.details !== undefined || fields.sourceUrls?.length || deadline || clear.includes('details') || (dueChanged && deadlineColumns.length);
  if (needsDetails) {
    const column = detailsColumn(snapshot.columns, fields.details?.columnId ?? (dueChanged ? deadlineColumns[0]?.id : undefined));
    if (dueChanged && deadlineColumns[0] && deadlineColumns[0].id !== column.id) {
      throw new SlackListError('details_column_required', 'The existing deadline note is in another context column. Update that column, or clear its deadline before choosing a different context column. Nothing was written.');
    }
    if (clear.includes('details') && (deadline || fields.sourceUrls?.length)) throw new SlackListError('conflicting_fields', 'Task context is required to preserve the source or exact deadline.');
    const prior = existing?.fields.find(f => f.column_id === column.id);
    const priorDeadline = deadlineNotes(prior?.rich_text)[0];
    if (clear.includes('details') && priorDeadline && !dueChanged) {
      throw new SlackListError('conflicting_fields', 'The context contains the visible deadline time. Clear or update the deadline as well before removing that context.');
    }
    // Preserve existing rich text when only changing the deadline or appending
    // sources. Remove only the exact generated deadline-line format.
    let rich = fields.details ? textCell(column.id, fields.details.text).rich_text : structuredClone(prior?.rich_text ?? []);
    if (clear.includes('details')) rich = [];
    if (dueChanged) rich = removeDeadlineLines(rich);
    const note = deadline ?? (fields.details && !dueChanged && priorDeadline && !fields.details.text.includes(priorDeadline) ? priorDeadline : undefined);
    const additions: Record<string, unknown>[] = [];
    for (const url of fields.sourceUrls ?? []) {
      additions.push({ type: 'text', text: `${additions.length || richTextContent(rich).trim() ? '\n' : ''}Source: ` }, { type: 'link', url: validateSourceUrl(url) });
    }
    if (note) additions.push({ type: 'text', text: `${additions.length || richTextContent(rich).trim() ? '\n' : ''}${note}` });
    if (additions.length) {
      rich = [...(Array.isArray(rich) ? rich : []), { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: additions }] }];
    }
    const text = richTextContent(rich);
    if (text.length > 12_000) throw new SlackListError('context_too_large', 'Task context is too large for this operation. Nothing was written.');
    cells.push({ column_id: column.id, rich_text: rich });
  }
  if (cells.length === 0) throw new SlackListError('fields_required', 'Specify at least one task field to change.');
  return cells;
}

function deadlineNotes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deadlineNotes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return node.type === 'text' && typeof node.text === 'string' ? node.text.match(DEADLINE_LINE) ?? [] : deadlineNotes(node.elements);
}

function removeDeadlineLines(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeDeadlineLines);
  if (!value || typeof value !== 'object') return value;
  const node = value as Record<string, unknown>;
  return { ...node, ...(typeof node.text === 'string' && node.type === 'text' ? { text: node.text.replace(DEADLINE_LINE, '').replace(/\n{3,}/g, '\n\n') } : {}), ...(node.elements ? { elements: removeDeadlineLines(node.elements) } : {}) };
}

function validateSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || value.length > 2_048) throw new Error();
    return value;
  } catch { throw new SlackListError('invalid_source_url', 'A task source must be an ordinary web link.'); }
}

function validateDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new SlackListError('invalid_deadline', 'The deadline date must be a valid YYYY-MM-DD date.');
  }
}

/** Resolve a wall time without silently normalizing DST gaps or choosing a fold. */
function localDeadline(date: string, time: string, zone: string): number {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new SlackListError('invalid_deadline', 'Use HH:MM for the deadline time.');
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { throw new SlackListError('invalid_timezone', 'Use a valid IANA timezone for the deadline.'); }
  const center = Date.parse(`${date}T${time}:00Z`);
  const matches: number[] = [];
  // Candidate offsets cover current IANA zones, including quarter-hour zones.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const candidate = center + offset * 60_000;
    const p = Object.fromEntries(formatter.formatToParts(candidate).map(p => [p.type, p.value]));
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` === `${date}T${time}`) matches.push(candidate / 1_000);
  }
  if (matches.length !== 1) throw new SlackListError('ambiguous_deadline', 'That local deadline time is missing or repeats at a daylight-saving change. Choose an unambiguous time.');
  return matches[0]!;
}
