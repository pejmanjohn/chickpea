import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ProductTelemetryEventInput } from './events.ts';

export const PRODUCT_TELEMETRY_ACTIVE_DAY_SETTING = 'telemetry.active_day.v1';

export type ProductTelemetryInventoryStore = Pick<
  ConfigStore,
  'summarizeAdoptionInventory'
>;

/** Claim the installation's UTC-day snapshot before performing any inventory reads. */
export async function claimDailyAdoptionSnapshot(input: {
  settings: SettingsStore;
  config: ProductTelemetryInventoryStore;
  now?: () => number;
}): Promise<Extract<ProductTelemetryEventInput, { event: 'installation_active' }> | undefined> {
  const today = new Date((input.now ?? Date.now)()).toISOString().slice(0, 10);
  const current = await input.settings.getSetting(PRODUCT_TELEMETRY_ACTIVE_DAY_SETTING);
  if (current === today) return undefined;
  const claimed = await input.settings.applySettingsPatch({
    expected: { key: PRODUCT_TELEMETRY_ACTIVE_DAY_SETTING, value: current ?? null },
    set: [{ key: PRODUCT_TELEMETRY_ACTIVE_DAY_SETTING, value: today }],
  });
  if (!claimed) return undefined;

  try {
    const inventory = await input.config.summarizeAdoptionInventory();
    return {
      event: 'installation_active',
      ...inventory,
    };
  } catch {
    // The gate intentionally remains claimed. A partial or repeatedly retried
    // snapshot would be less trustworthy than one missing daily summary.
    return undefined;
  }
}
