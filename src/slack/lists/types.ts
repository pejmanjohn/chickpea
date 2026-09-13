export const SLACK_LIST_OPERATIONS = [
  'slackLists.items.list', 'slackLists.items.info',
  'slackLists.items.create', 'slackLists.items.update',
  'slackLists.create', 'slackLists.access.set',
] as const;
export type SlackListOperation = typeof SLACK_LIST_OPERATIONS[number];
export type JsonObject = Record<string, unknown>;
export type SlackListsCall = (method: SlackListOperation, input: JsonObject) => Promise<JsonObject>;

export interface ListColumn {
  id: string;
  name: string;
  type: string;
  is_primary_column: boolean;
}
export interface ListCell extends JsonObject { column_id: string }
export interface ListItem { id: string; list_id: string; fields: ListCell[] }
export interface ListSnapshot {
  id: string;
  name: string;
  url: string;
  columns: ListColumn[];
  items: ListItem[];
  nextCursor: string;
}
export interface TaskFields {
  title?: string | undefined;
  assignees?: string[] | undefined;
  due?: { date: string; time?: string | undefined; timezone?: string | undefined } | undefined;
  details?: { text: string; columnId?: string | undefined } | undefined;
  sourceUrls?: string[] | undefined;
  completed?: boolean | undefined;
}
export type ClearTaskField = 'assignees' | 'due' | 'details';

/** Expected failures are returned as structured tool results, never raw SDK errors. */
export class SlackListError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: JsonObject = {},
  ) { super(message); this.name = 'SlackListError'; }
}

export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SlackListError('invalid_response', 'Slack returned an unexpected Lists response.');
  }
  return value as JsonObject;
}
