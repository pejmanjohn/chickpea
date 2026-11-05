import type { SettingsStore } from '../../config/settings-store.ts';
import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { isSlackRateLimitError } from '../read-budget.ts';
import { SlackTransportError } from '../transport/types.ts';

const PENDING = JSON.stringify({ status: 'pending' });

const UNCERTAIN_WRITE_ERRORS = new Set(['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable']);

export interface ReceiptCodec<Settled> {
  parse(value: Record<string, unknown>): Settled | undefined;
  retryable(settled: Settled): boolean;
}

export type ReceiptClaim<Settled> =
  | { claimed: true; previous?: Settled }
  | { claimed: false; previous: Settled | 'pending' };

export class RequestReceipt<Settled extends object> {
  constructor(
    private readonly store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
    readonly key: string,
    private readonly codec: ReceiptCodec<Settled>,
  ) {}

  async claim(): Promise<ReceiptClaim<Settled>> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const raw = await this.store.getSetting(this.key);
      const previous = raw === undefined ? undefined : this.read(raw);
      if (previous === 'pending' || (previous && !this.codec.retryable(previous))) return { claimed: false, previous };
      if (await this.store.applySettingsPatch({
        expected: { key: this.key, value: raw ?? null },
        set: [{ key: this.key, value: PENDING }],
      })) return previous ? { claimed: true, previous } : { claimed: true };
    }
    return { claimed: false, previous: 'pending' };
  }

  async settle(settled: Settled): Promise<void> {
    await this.store.applySettingsPatch({
      expected: { key: this.key, value: PENDING },
      set: [{ key: this.key, value: JSON.stringify(settled) }],
    }).catch(() => false);
  }

  private read(raw: string): Settled | 'pending' {
    try {
      const value: unknown = JSON.parse(raw);
      const settled = isRecord(value) ? this.codec.parse(value) : undefined;
      if (settled) return settled;
    } catch {}
    return 'pending';
  }
}

export function slackWriteSurelyFailed(error: unknown): boolean {
  if (error instanceof SlackTransportError) return error.effectOutcome === 'failed';
  if (isSlackRateLimitError(error)) return true;
  const code = slackPlatformErrorCode(error);
  return code !== undefined && !UNCERTAIN_WRITE_ERRORS.has(code);
}
