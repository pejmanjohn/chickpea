import { createHash } from 'node:crypto';
import type { SettingsStore } from '../../config/settings-store.ts';
import { SlackListError, type JsonObject, type SlackListOperation } from './types.ts';

export const SLACK_LIST_WRITE_KEY_PREFIX = 'slack_lists.writes.v1:';
export type WriteStatus = 'pending' | 'confirmed' | 'failed' | 'unknown';
export interface ListWriteReceipt {
  toolCallId: string;
  operation: SlackListOperation;
  inputSha256: string;
  status: WriteStatus;
  listId?: string;
  itemId?: string;
}
interface Ledger { schemaVersion: 1; workspaceId: string; entries: ListWriteReceipt[] }

/** Awaited settings CAS commits independently of Flue's eventual tool batch. */
export class ListWriteLedger {
  readonly key: string;
  constructor(private readonly store: SettingsStore, private readonly workspaceId: string, turnJobId: string) {
    if (!turnJobId || turnJobId.length > 256) throw new SlackListError('invalid_context', 'A verified Slack turn is required.');
    this.key = `${SLACK_LIST_WRITE_KEY_PREFIX}${turnJobId}`;
  }

  async reserve(toolCallId: string, operation: SlackListOperation, input: JsonObject): Promise<{ reserved: boolean; receipt: ListWriteReceipt }> {
    const inputSha256 = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = await this.store.getSetting(this.key);
      const ledger = this.parse(raw);
      const sameCall = ledger.entries.find(e => e.toolCallId === toolCallId);
      if (sameCall && (sameCall.inputSha256 !== inputSha256 || sameCall.operation !== operation)) {
        throw new SlackListError('write_identity_mismatch', 'This tool call already belongs to a different List operation.');
      }
      // Stop the whole request after uncertainty, including a model retry with
      // rephrased arguments. Read-only reconciliation remains available.
      const previous = sameCall ?? ledger.entries.find(e => e.status === 'pending' || e.status === 'unknown') ??
        ledger.entries.find(e => e.operation === operation && e.inputSha256 === inputSha256 && e.status === 'confirmed');
      if (previous) return { reserved: false, receipt: previous };
      if (!toolCallId || toolCallId.length > 256 || ledger.entries.length >= 16) {
        throw new SlackListError('write_limit', 'This request has reached its limit of 16 List write attempts.');
      }
      const receipt: ListWriteReceipt = { toolCallId, operation, inputSha256, status: 'pending' };
      if (typeof input.list_id === 'string') receipt.listId = input.list_id;
      const next: Ledger = { ...ledger, entries: [...ledger.entries, receipt] };
      if (await this.store.applySettingsPatch({ expected: { key: this.key, value: raw ?? null }, set: [{ key: this.key, value: JSON.stringify(next) }] })) {
        return { reserved: true, receipt };
      }
    }
    throw new SlackListError('write_busy', 'Another List action is updating this request. No new write was sent.');
  }

  async finish(receipt: ListWriteReceipt, status: Exclude<WriteStatus, 'pending'>, ids: { listId?: string; itemId?: string } = {}): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = await this.store.getSetting(this.key);
      const ledger = this.parse(raw);
      const index = ledger.entries.findIndex(e => e.toolCallId === receipt.toolCallId && e.inputSha256 === receipt.inputSha256 && e.operation === receipt.operation);
      if (index < 0) throw new SlackListError('write_receipt_missing', 'The List action could not be durably verified. Do not repeat it.');
      const previous = ledger.entries[index]!;
      if (previous.status === 'confirmed') return;
      ledger.entries[index] = { ...previous, ...ids, status };
      if (await this.store.applySettingsPatch({ expected: { key: this.key, value: raw ?? null }, set: [{ key: this.key, value: JSON.stringify(ledger) }] })) return;
    }
    throw new SlackListError('write_receipt_unconfirmed', 'The List action could not be durably verified. Do not repeat it.');
  }

  private parse(raw: string | undefined): Ledger {
    if (raw === undefined) return { schemaVersion: 1, workspaceId: this.workspaceId, entries: [] };
    try {
      const data = JSON.parse(raw) as Ledger;
      if (data.schemaVersion !== 1 || data.workspaceId !== this.workspaceId || !Array.isArray(data.entries) || data.entries.length > 16 ||
          data.entries.some(e => !e || typeof e.toolCallId !== 'string' || typeof e.operation !== 'string' || !/^[a-f0-9]{64}$/.test(e.inputSha256) ||
            !['pending', 'confirmed', 'failed', 'unknown'].includes(e.status))) throw new Error();
      return data;
    } catch { throw new SlackListError('write_receipt_invalid', 'This request has an unreadable List action receipt. Read-only inspection is still available; do not repeat its writes.'); }
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
