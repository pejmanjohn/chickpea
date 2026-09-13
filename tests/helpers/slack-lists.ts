import assert from 'node:assert/strict';
import { object, type JsonObject, type ListCell, type ListColumn, type ListItem, type SlackListsCall } from '../../src/slack/lists/types.ts';

export const LIST_URL = 'https://example.slack.com/lists/TWORK/FEXISTING';
export const TASK_COLUMNS: ListColumn[] = [
  { id: 'ColTITLE', name: 'Renamed work', type: 'text', is_primary_column: true },
  { id: 'ColDETAILS', name: 'Renamed context', type: 'text', is_primary_column: false },
  { id: 'ColASSIGNEE', name: 'Responsible person', type: 'todo_assignee', is_primary_column: false },
  { id: 'ColDUE', name: 'Deliver by', type: 'todo_due_date', is_primary_column: false },
  { id: 'ColDONE', name: 'Finished', type: 'todo_completed', is_primary_column: false },
];

/** Reduced from observed Slack responses. Unknown methods never return bare success. */
export class StrictListsFake {
  calls: { method: string; input: JsonObject }[] = [];
  lists = new Map<string, { name: string; columns: ListColumn[]; items: ListItem[] }>([
    ['FEXISTING', { name: 'Client work', columns: structuredClone(TASK_COLUMNS), items: [] }],
  ]);
  grants: JsonObject[] = [];
  before?: (method: string, input: JsonObject) => Promise<void>;
  after?: ((method: string, response: JsonObject) => JsonObject) | undefined;
  failure: string | undefined;
  ignoreColumn: string | undefined;
  private sequence = 0;

  call: SlackListsCall = async (method, input) => {
    this.calls.push({ method, input: structuredClone(input) });
    await this.before?.(method, input);
    if (this.failure) return { ok: false, error: this.failure };
    assert.ok(!('token' in input) && !('team_id' in input));
    let response: JsonObject;
    if (method === 'slackLists.create') {
      assert.equal(input.todo_mode, true);
      assert.ok(Array.isArray(input.schema));
      const id = `FNEW${++this.sequence}`;
      const schema = (input.schema as JsonObject[]).map((c, index) => ({ ...c, id: `ColTEXT${index}` })) as unknown as ListColumn[];
      schema.push(...structuredClone(TASK_COLUMNS.slice(2)));
      this.lists.set(id, { name: String(input.name), columns: schema, items: [] });
      response = { ok: true, list_id: id, list_metadata: { schema } };
    } else {
      const listId = String(input.list_id);
      const data = this.lists.get(listId);
      if (!data) return { ok: false, error: 'list_not_found' };
      const list = { id: listId, title: data.name, user_team: 'TWORK', editable: true, list_metadata: { schema: data.columns }, permalink: `https://example.slack.com/lists/TWORK/${listId}` };
      switch (method) {
        case 'slackLists.items.list': {
          assert.equal(input.include_list, true);
          assert.ok(Number.isInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 50);
          const offset = input.cursor ? Number(String(input.cursor).replace('page:', '')) : 0;
          const end = offset + Number(input.limit);
          response = { ok: true, list, items: data.items.slice(offset, end), response_metadata: { next_cursor: end < data.items.length ? `page:${end}` : '' } };
          break;
        }
        case 'slackLists.items.info': {
          assert.ok(!('item_id' in input));
          const item = data.items.find(i => i.id === input.id);
          response = item ? { ok: true, list, record: item, subtasks: [] } : { ok: false, error: 'record_not_found' };
          break;
        }
        case 'slackLists.items.create': {
          assert.ok(Array.isArray(input.initial_fields));
          for (const cell of input.initial_fields as ListCell[]) this.validateCell(cell, data.columns);
          const item: ListItem = { id: `RecTASK${++this.sequence}`, list_id: listId, fields: structuredClone(input.initial_fields as ListCell[]) };
          data.items.push(item);
          response = { ok: true, item };
          break;
        }
        case 'slackLists.items.update': {
          assert.ok(Array.isArray(input.cells));
          for (const raw of input.cells as JsonObject[]) {
            const item: ListItem | undefined = data.items.find(i => i.id === raw.row_id);
            assert.ok(item, 'exact existing row_id required');
            const { row_id: _row, ...cell } = raw;
            if (cell.column_id === this.ignoreColumn) continue;
            this.validateCell(cell as ListCell, data.columns);
            item.fields = [...item.fields.filter(f => f.column_id !== cell.column_id), structuredClone(cell) as ListCell];
          }
          response = { ok: true };
          break;
        }
        case 'slackLists.access.set':
          assert.ok(['read', 'write'].includes(String(input.access_level)));
          assert.equal(Boolean(input.channel_ids) === Boolean(input.user_ids), false);
          this.grants.push(structuredClone(input));
          response = { ok: true };
          break;
        default: throw new Error(`Unimplemented Lists method: ${String(method)}`);
      }
    }
    return structuredClone(this.after ? this.after(method, response) : response);
  };

  private validateCell(cell: ListCell, columns: ListColumn[]): void {
    const column = columns.find(c => c.id === cell.column_id);
    assert.ok(column, 'column must exist');
    if (column.type === 'text') {
      assert.ok(Array.isArray(cell.rich_text), 'text writes require rich_text, never text');
      assert.equal('text' in cell, false);
    } else if (column.type === 'todo_assignee') assert.ok(Array.isArray(cell.user));
    else if (column.type === 'todo_due_date') assert.ok(Array.isArray(cell.date));
    else if (column.type === 'todo_completed') assert.equal(typeof cell.checkbox, 'boolean');
    else assert.fail(`Unsupported write type: ${column.type}`);
    object(cell);
  }
}
