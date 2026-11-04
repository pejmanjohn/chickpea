import type { SettingsStore } from '../../config/settings-store.ts';

export const SLACK_GROUP_DM_RECEIPT_PREFIX = 'slack_group_dm.v1:';

export type GroupDmReceipt =
  | { status: 'pending' }
  | { status: 'posted'; channelId: string; messageTs: string; people: string[] }
  | { status: 'not_posted' };

const PENDING = JSON.stringify({ status: 'pending' });

export class GroupDmReceipts {
  readonly key: string;

  constructor(
    private readonly store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
    turnJobId: string,
  ) {
    this.key = `${SLACK_GROUP_DM_RECEIPT_PREFIX}${turnJobId}`;
  }

  async claim(): Promise<Exclude<GroupDmReceipt, { status: 'not_posted' }> | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await this.store.getSetting(this.key);
      const previous = raw === undefined ? undefined : parseReceipt(raw);
      if (previous && previous.status !== 'not_posted') return previous;
      if (await this.store.applySettingsPatch({
        expected: { key: this.key, value: raw ?? null },
        set: [{ key: this.key, value: PENDING }],
      })) return undefined;
    }
    return { status: 'pending' };
  }

  async settle(receipt: Exclude<GroupDmReceipt, { status: 'pending' }>): Promise<void> {
    // A receipt left pending blocks later calls in the request: the safe side.
    await this.store.applySettingsPatch({
      expected: { key: this.key, value: PENDING },
      set: [{ key: this.key, value: JSON.stringify(receipt) }],
    }).catch(() => false);
  }
}

function parseReceipt(raw: string): GroupDmReceipt {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.status === 'not_posted') return { status: 'not_posted' };
    if (value.status === 'posted' && typeof value.channelId === 'string' && typeof value.messageTs === 'string' &&
        Array.isArray(value.people) && value.people.every((id) => typeof id === 'string')) {
      return { status: 'posted', channelId: value.channelId, messageTs: value.messageTs, people: value.people as string[] };
    }
  } catch {}
  return { status: 'pending' };
}
