import { SlackListError, object, type JsonObject, type ListCell, type ListColumn, type ListItem, type ListSnapshot } from './types.ts';
import { requireListItemId, slackListItemUrl, verifiedListPermalink } from './urls.ts';

export function readListSnapshot(response: JsonObject, workspaceId: string, listId: string): ListSnapshot {
  const list = object(response.list);
  const metadata = object(list.list_metadata);
  if (list.id !== listId || list.user_team !== workspaceId || typeof list.title !== 'string' || !Array.isArray(metadata.schema)) {
    throw new SlackListError('invalid_response', 'Slack returned mismatched List identity or schema.');
  }
  const columns = metadata.schema.map((raw): ListColumn => {
    const column = object(raw);
    if (typeof column.id !== 'string' || !/^Col[A-Za-z0-9]+$/.test(column.id) ||
        typeof column.name !== 'string' || typeof column.type !== 'string' || typeof column.is_primary_column !== 'boolean') {
      throw new SlackListError('invalid_response', 'Slack returned an invalid List column.');
    }
    return { id: column.id, name: column.name, type: column.type, is_primary_column: column.is_primary_column };
  });
  if (columns.length > 100 || new Set(columns.map(c => c.id)).size !== columns.length) {
    throw new SlackListError('invalid_response', 'Slack returned an invalid List schema.');
  }
  const cursor = response.response_metadata === undefined ? '' : object(response.response_metadata).next_cursor ?? '';
  if (typeof cursor !== 'string' || cursor.length > 2_048) throw new SlackListError('invalid_response', 'Slack returned an invalid page cursor.');
  const rawItems = response.items ?? (response.record ? [response.record] : undefined);
  if (!Array.isArray(rawItems) || rawItems.length > 50) throw new SlackListError('invalid_response', 'Slack returned an invalid item page.');
  return {
    id: listId, name: list.title, url: verifiedListPermalink(list.permalink, workspaceId, listId),
    columns, items: rawItems.map(raw => readListItem(raw, listId)), nextCursor: cursor,
  };
}

export function readListItem(raw: unknown, listId: string, expectedItemId?: string): ListItem {
  const item = object(raw);
  if (typeof item.id !== 'string' || item.list_id !== listId || !Array.isArray(item.fields) || item.fields.length > 100 ||
      (expectedItemId !== undefined && item.id !== expectedItemId)) {
    throw new SlackListError('invalid_response', 'Slack returned a task from an unexpected List or an invalid task.');
  }
  requireListItemId(item.id);
  const fields = item.fields.map(value => {
    const field = object(value);
    if (typeof field.column_id !== 'string') throw new SlackListError('invalid_response', 'Slack returned an invalid task field.');
    return field as ListCell;
  });
  if (new Set(fields.map(f => f.column_id)).size !== fields.length) throw new SlackListError('invalid_response', 'Slack returned duplicate task fields.');
  return { id: item.id, list_id: listId, fields };
}

export function semanticColumn(columns: ListColumn[], field: 'title' | 'assignees' | 'due' | 'completed'): ListColumn {
  const type = { title: 'text', assignees: 'todo_assignee', due: 'todo_due_date', completed: 'todo_completed' }[field];
  const matches = columns.filter(c => c.type === type && (field !== 'title' || c.is_primary_column));
  if (matches.length !== 1) throw new SlackListError('field_unavailable', `This List does not have one unambiguous native ${field} field. Nothing was written.`, { field, columns });
  return matches[0]!;
}

export function detailsColumn(columns: ListColumn[], id?: string): ListColumn {
  const candidates = columns.filter(c => c.type === 'text' && !c.is_primary_column);
  const matches = id === undefined ? candidates : candidates.filter(c => c.id === id);
  if (matches.length !== 1) throw new SlackListError('details_column_required', 'Choose a text column for the task context and exact deadline time. Nothing was written.', { candidates });
  return matches[0]!;
}

/** Preserve link destinations when exposing rich text to the model. */
export function richTextContent(value: unknown): string {
  if (Array.isArray(value)) return value.map(richTextContent).join('');
  if (!value || typeof value !== 'object') return '';
  const node = value as JsonObject;
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (node.type === 'link' && typeof node.url === 'string') return typeof node.text === 'string' && node.text !== node.url ? `${node.text} (${node.url})` : node.url;
  if (node.type === 'user' && typeof node.user_id === 'string') return `<@${node.user_id}>`;
  return richTextContent(node.elements);
}

export function textCell(columnId: string, text: string): ListCell {
  return { column_id: columnId, rich_text: text ? [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }] : [] };
}

export function sameCell(actual: ListCell | undefined, expected: ListCell): boolean {
  if ('rich_text' in expected) return richTextContent(actual?.rich_text) === richTextContent(expected.rich_text);
  for (const key of ['user', 'date', 'timestamp', 'checkbox']) {
    if (!(key in expected)) continue;
    const observed = actual?.[key] ?? (Array.isArray(expected[key]) ? [] : undefined);
    if (JSON.stringify(observed) !== JSON.stringify(expected[key])) return false;
  }
  return true;
}

export function presentItem(item: ListItem, snapshot: ListSnapshot): JsonObject {
  return {
    id: item.id, url: slackListItemUrl(snapshot.url, item.id),
    fields: item.fields.map(field => ({
      columnId: field.column_id,
      ...(field.rich_text ? { text: richTextContent(field.rich_text) } :
        { value: field.user ?? field.date ?? field.checkbox ?? field.value ?? null }),
      ...(field.timestamp ? { timestamp: field.timestamp } : {}),
    })),
  };
}
