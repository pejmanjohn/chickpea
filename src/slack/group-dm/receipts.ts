import type { SettingsStore } from '../../config/settings-store.ts';
import { RequestReceipt } from '../requested-conversations/receipts.ts';

export const SLACK_GROUP_DM_RECEIPT_PREFIX = 'slack_group_dm.v1:';

export type GroupDmReceipt =
  | { status: 'pending' }
  | { status: 'posted'; channelId: string; messageTs: string; people: string[] }
  | { status: 'not_posted' };

type SettledGroupDm = Exclude<GroupDmReceipt, { status: 'pending' }>;

export class GroupDmReceipts {
  private readonly receipt: RequestReceipt<SettledGroupDm>;

  constructor(store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>, turnJobId: string) {
    this.receipt = new RequestReceipt(store, `${SLACK_GROUP_DM_RECEIPT_PREFIX}${turnJobId}`, {
      parse: parseSettledGroupDm,
      retryable: (settled) => settled.status === 'not_posted',
    });
  }

  async claim(): Promise<Exclude<GroupDmReceipt, { status: 'not_posted' }> | undefined> {
    const claim = await this.receipt.claim();
    if (claim.claimed) return undefined;
    const { previous } = claim;
    return previous === 'pending' || previous.status === 'not_posted' ? { status: 'pending' } : previous;
  }

  settle(receipt: SettledGroupDm): Promise<void> {
    return this.receipt.settle(receipt);
  }
}

function parseSettledGroupDm(value: Record<string, unknown>): SettledGroupDm | undefined {
  if (value.status === 'not_posted') return { status: 'not_posted' };
  if (value.status === 'posted' && typeof value.channelId === 'string' && typeof value.messageTs === 'string' &&
      Array.isArray(value.people) && value.people.every((id) => typeof id === 'string')) {
    return { status: 'posted', channelId: value.channelId, messageTs: value.messageTs, people: value.people as string[] };
  }
  return undefined;
}
