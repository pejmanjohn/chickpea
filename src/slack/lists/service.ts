import type { WebClient } from '@slack/web-api';
import { slackPlatformErrorCode } from '../errors.ts';
import { SlackTransportError } from '../transport/types.ts';
import { taskCells } from './fields.ts';
import { presentItem, readListItem, readListSnapshot, sameCell } from './schema.ts';
import { parseSlackListUrl, requireListItemId } from './urls.ts';
import { ListWriteLedger, type ListWriteReceipt } from './writes.ts';
import { SlackListError, object, type ClearTaskField, type JsonObject, type ListCell, type ListSnapshot, type SlackListOperation, type SlackListsCall, type TaskFields } from './types.ts';

export function createSlackListsCall(client: Pick<WebClient, 'apiCall'>): SlackListsCall {
  return async (method, input) => object(await client.apiCall(method, input));
}

const DEFINITE_FAILURES = new Set([
  // Documented validation/access/limit failures cannot have committed a write.
  // Unrecognized service errors stay uncertain: Slack explicitly allows partial
  // effects for internal_error/fatal_error, even with ok:false.
  'invalid_name', 'name_too_long', 'too_many_users', 'invalid_cursor', 'invalid_args',
  'invalid_column_id', 'invalid_column_type', 'invalid_copy_and_schema_args',
  'invalid_primary_column', 'invalid_schema', 'invalid_input_type', 'invalid_option_id',
  'invalid_vote_value', 'uneditable_column', 'over_cell_fields_limit', 'over_row_maximum',
  'over_column_maximum', 'over_list_file_maximum', 'over_title_length_maximum',
  'file_not_found', 'user_not_found', 'duplicated_item_not_found', 'missing_arg_copy_from_list_id',
  'accesslimited', 'deprecated_endpoint', 'method_deprecated', 'ekm_access_denied',
  'enterprise_is_restricted', 'no_permission', 'team_access_not_granted', 'token_expired',
  'two_factor_setup_required',
  'list_not_found', 'item_not_found', 'record_not_found', 'missing_scope', 'not_allowed_token_type',
  'invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'invalid_arguments',
  'invalid_arg_name', 'invalid_array_arg', 'invalid_charset', 'invalid_form_data',
  'invalid_post_type', 'missing_post_type', 'access_denied', 'permission_denied',
  'restricted_action', 'feature_not_enabled', 'not_available', 'team_not_found',
  'operation_not_allowed', 'unknown_operation', 'unsupported_operation', 'gateway_http_404',
  'gateway_request_too_large', 'ratelimited', 'slack_webapi_rate_limited_error',
]);

export class SlackListsService {
  private calls = 0;
  private readonly startedAt = Date.now();
  constructor(private readonly options: {
    workspaceId: string;
    call: SlackListsCall;
    ledger: ListWriteLedger;
    admittedListIds?: readonly string[] | undefined;
    timezone?: string | undefined;
    signal?: AbortSignal | undefined;
  }) {}

  async readList(listUrl: string, cursor?: string, limit = 20): Promise<JsonObject> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursor?.length ?? 0) > 2_048) throw new SlackListError('invalid_page', 'Use a page size from 1 to 50 and a cursor returned by this List.');
    const { listId } = parseSlackListUrl(listUrl, this.options.workspaceId);
    const snapshot = await this.snapshot(listId, cursor, limit);
    return this.bounded({ status: 'read', list: { id: listId, name: snapshot.name, url: snapshot.url, columns: snapshot.columns }, items: snapshot.items.map(item => presentItem(item, snapshot, false)), nextCursor: snapshot.nextCursor, contentIsUntrusted: true });
  }

  async readItem(listUrl: string, itemId?: string): Promise<JsonObject> {
    const ref = parseSlackListUrl(listUrl, this.options.workspaceId);
    const id = requireListItemId(itemId, ref.itemId);
    const snapshot = await this.itemSnapshot(ref.listId, id);
    return this.bounded({ status: 'read', list: { id: ref.listId, name: snapshot.name, url: snapshot.url, columns: snapshot.columns }, item: presentItem(snapshot.items[0]!, snapshot), contentIsUntrusted: true });
  }

  async createItem(toolCallId: string, listUrl: string, fields: TaskFields): Promise<JsonObject> {
    if (!fields.title?.trim()) throw new SlackListError('title_required', 'A task title is required.');
    const { listId } = parseSlackListUrl(listUrl, this.options.workspaceId);
    await this.assertWriteAdmission(listId);
    const snapshot = await this.snapshot(listId, undefined, 1);
    const cells = taskCells({ ...snapshot, items: [] }, fields, [], this.options.timezone);
    return this.mutate(toolCallId, 'slackLists.items.create', { list_id: listId, initial_fields: cells }, async (response, ids) => {
      const item = readListItem(response.item, listId);
      ids.listId = listId; ids.itemId = item.id;
      return this.verifyItem(listId, item.id, cells);
    });
  }

  async updateItem(toolCallId: string, listUrl: string, itemId: string | undefined, fields: TaskFields, clear: ClearTaskField[] = []): Promise<JsonObject> {
    const ref = parseSlackListUrl(listUrl, this.options.workspaceId);
    await this.assertWriteAdmission(ref.listId);
    const id = requireListItemId(itemId, ref.itemId);
    const snapshot = await this.itemSnapshot(ref.listId, id);
    const cells = taskCells(snapshot, fields, clear, this.options.timezone);
    return this.mutate(toolCallId, 'slackLists.items.update', { list_id: ref.listId, cells: cells.map(cell => ({ ...cell, row_id: id })) }, async (_response, ids) => {
      ids.listId = ref.listId; ids.itemId = id;
      return this.verifyItem(ref.listId, id, cells);
    });
  }

  async createList(toolCallId: string, name: string): Promise<JsonObject> {
    const input = { name, todo_mode: true, schema: [
      { key: 'task', name: 'Task', type: 'text', is_primary_column: true },
      { key: 'details', name: 'Details', type: 'text', is_primary_column: false },
    ] };
    return this.mutate(toolCallId, 'slackLists.create', input, async (response, ids) => {
      if (typeof response.list_id !== 'string' || !/^F[A-Z0-9]+$/.test(response.list_id)) throw new SlackListError('invalid_response', 'Slack did not return the new List ID.');
      ids.listId = response.list_id;
      const snapshot = await this.snapshot(response.list_id, undefined, 1);
      if (snapshot.name !== name || !snapshot.columns.some(c => c.name === 'Details' && c.type === 'text' && !c.is_primary_column)) throw new SlackListError('readback_mismatch', 'The created List did not match the requested name and context column.');
      return { status: 'confirmed', list: { id: snapshot.id, name: snapshot.name, url: snapshot.url, columns: snapshot.columns }, sharing: 'No sharing was requested. Explicitly share the List before expecting people to open it.' };
    });
  }

  async shareList(toolCallId: string, listUrl: string, access: 'view' | 'edit', target: { channelId?: string | undefined; userId?: string | undefined }): Promise<JsonObject> {
    const { listId } = parseSlackListUrl(listUrl, this.options.workspaceId);
    await this.assertWriteAdmission(listId);
    if (Boolean(target.channelId) === Boolean(target.userId) || !['view', 'edit'].includes(access)) throw new SlackListError('share_target_required', 'Choose one explicit channel or person and Can view or Can edit.');
    const snapshot = await this.snapshot(listId, undefined, 1);
    const input = { list_id: listId, access_level: access === 'edit' ? 'write' : 'read', ...(target.channelId ? { channel_ids: [target.channelId] } : { user_ids: [target.userId] }) };
    return this.mutate(toolCallId, 'slackLists.access.set', input, async (_response, ids) => {
      ids.listId = listId;
      return { status: 'confirmed', verification: 'slack_acknowledged', list: { id: listId, url: snapshot.url }, access, target, message: 'Slack accepted this sharing change. No channel message was posted.' };
    });
  }

  private async snapshot(listId: string, cursor?: string, limit = 20): Promise<ListSnapshot> {
    return readListSnapshot(await this.call('slackLists.items.list', { list_id: listId, include_list: true, limit, ...(cursor ? { cursor } : {}) }), this.options.workspaceId, listId);
  }

  private async assertWriteAdmission(listId: string): Promise<void> {
    // This proves only that the host saw a usable source reference. The current
    // request, actor, Slack access, and write receipt gates remain independent.
    const admitted = new Set(this.options.admittedListIds ?? []);
    for (const created of await this.options.ledger.confirmedCreatedListIds()) admitted.add(created);
    if (!admitted.has(listId)) {
      throw new SlackListError(
        'list_reference_required',
        'Provide the exact Slack List link again in this current task conversation, or use an ordinary saved default. Nothing was written.',
      );
    }
  }

  private async itemSnapshot(listId: string, itemId: string): Promise<ListSnapshot> {
    const raw = await this.call('slackLists.items.info', { list_id: listId, id: itemId });
    readListItem(raw.record, listId, itemId);
    return readListSnapshot(raw, this.options.workspaceId, listId);
  }

  private async verifyItem(listId: string, itemId: string, cells: ListCell[]): Promise<JsonObject> {
    const snapshot = await this.itemSnapshot(listId, itemId);
    const item = snapshot.items[0]!;
    const mismatches = cells.filter(cell => !sameCell(item.fields.find(f => f.column_id === cell.column_id), cell)).map(cell => cell.column_id);
    if (mismatches.length) throw new SlackListError('readback_mismatch', 'Slack did not persist every requested field. Do not repeat the write automatically.', { mismatchedColumns: mismatches, item: presentItem(item, snapshot) });
    return this.bounded({ status: 'confirmed', list: { id: listId, url: snapshot.url }, item: presentItem(item, snapshot), followUp: 'No reminders or follow-up work were created.' });
  }

  private async mutate(toolCallId: string, method: SlackListOperation, input: JsonObject, verify: (response: JsonObject, ids: { listId?: string; itemId?: string }) => Promise<JsonObject>): Promise<JsonObject> {
    this.checkBudget();
    if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 32_768) throw new SlackListError('input_too_large', 'This task is too large for one List write. Nothing was written.');
    const reservation = await this.options.ledger.reserve(toolCallId, method, input);
    if (!reservation.reserved) return previousWrite(reservation.receipt);
    const ids: { listId?: string; itemId?: string } = { ...(reservation.receipt.listId ? { listId: reservation.receipt.listId } : {}) };
    let acknowledged = false;
    try {
      const response = await this.call(method, input);
      acknowledged = true;
      const result = await verify(response, ids);
      await this.options.ledger.finish(reservation.receipt, 'confirmed', ids);
      return result;
    } catch (error) {
      const code = errorCode(error);
      const failed = !acknowledged && (DEFINITE_FAILURES.has(code) || (error instanceof SlackTransportError && error.effectOutcome === 'failed') || code === 'cancelled_before_call' || code === 'call_budget');
      try { await this.options.ledger.finish(reservation.receipt, failed ? 'failed' : 'unknown', ids); } catch { /* The durable pending reservation still blocks redispatch. */ }
      return { status: failed ? 'not_written' : 'unverified', code, ...ids, message: failed ? explainError(code) : 'This List write may have taken effect, but could not be fully verified. Do not repeat it. Inspect the known List/item; if a new List has no returned ID, its creation cannot be reconciled through these tools.', ...(error instanceof SlackListError ? error.context : {}) };
    }
  }

  private async call(method: SlackListOperation, input: JsonObject): Promise<JsonObject> {
    this.checkBudget();
    this.calls++;
    const result = await this.options.call(method, input);
    if (result.ok !== true) {
      if (result.ok === false && typeof result.error === 'string' && /^[a-z0-9_]{1,100}$/.test(result.error)) throw new SlackListError(result.error, explainError(result.error));
      throw new SlackListError('invalid_response', 'Slack returned an invalid Lists response.');
    }
    return result;
  }

  private checkBudget(): void {
    if (this.options.signal?.aborted) throw new SlackListError('cancelled_before_call', 'The tool was cancelled before its next Slack call.');
    if (this.calls >= 3 || Date.now() - this.startedAt >= 45_000) throw new SlackListError('call_budget', 'This List operation reached its request or time limit.');
  }

  private bounded(result: JsonObject): JsonObject {
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32_768) throw new SlackListError('result_too_large', 'The List result is too large. Read fewer items or one specific item; no content was silently omitted.');
    return result;
  }
}

export function listToolFailure(error: unknown): JsonObject {
  const code = errorCode(error);
  return { status: 'not_written', code, message: error instanceof SlackListError ? error.message : explainError(code), ...(error instanceof SlackListError ? error.context : {}) };
}

function previousWrite(receipt: ListWriteReceipt): JsonObject {
  return { status: 'already_attempted', previousStatus: receipt.status, ...(receipt.listId ? { listId: receipt.listId } : {}), ...(receipt.itemId ? { itemId: receipt.itemId } : {}), message: receipt.status === 'confirmed' ? 'This operation was already confirmed in this request. Do not repeat it; read the returned List/item if needed.' : 'An earlier List write in this request is unresolved. Do not send another write. Read the known List/item to reconcile it.' };
}

function errorCode(error: unknown): string {
  if (error instanceof SlackListError) return error.code;
  const platform = slackPlatformErrorCode(error);
  if (platform && /^[a-z0-9_]{1,100}$/.test(platform)) return platform;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'slack_webapi_rate_limited_error') return 'ratelimited';
  if (error instanceof SlackTransportError && error.effectOutcome === 'failed') return 'transport_rejected';
  return 'unknown_response';
}

function explainError(code: string): string {
  if (['list_not_found', 'item_not_found', 'record_not_found', 'access_denied', 'permission_denied'].includes(code)) return 'The agent cannot access or edit this List/item. Check its link and Slack sharing permissions; no access was changed.';
  if (code === 'missing_scope') return 'This Slack installation needs the Lists read/write permissions. Its owner must update the app scopes and reinstall through the existing Slack setup flow. Ordinary chat can continue.';
  if (['operation_not_allowed', 'unknown_operation', 'unsupported_operation', 'gateway_http_404'].includes(code)) return 'This shared gateway does not support Slack Lists yet. Its operator must upgrade the gateway before Lists tools can work.';
  if (code === 'ratelimited') return 'Slack rate-limited this operation. No automatic retry was made.';
  return `Slack could not complete this Lists operation (${code}).`;
}
