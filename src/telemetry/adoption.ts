import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ProductTelemetryEventInput } from './events.ts';

export const PRODUCT_TELEMETRY_ACTIVE_DAY_SETTING = 'telemetry.active_day.v1';

export type ProductTelemetryInventoryStore = Pick<
  ConfigStore,
  | 'listWorkspaceInstallations'
  | 'listUserAgents'
  | 'listConnectionAccounts'
  | 'listAgentScheduleReferences'
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
    const [workspaces, agents] = await Promise.all([
      input.config.listWorkspaceInstallations(),
      input.config.listUserAgents(),
    ]);
    const activeWorkspaces = workspaces.filter(({ health }) => health !== 'revoked');
    const [accountsByWorkspace, schedulesByAgent] = await Promise.all([
      Promise.all(activeWorkspaces.map(({ workspaceId }) =>
        input.config.listConnectionAccounts(workspaceId)
      )),
      Promise.all(agents.map(({ id }) => input.config.listAgentScheduleReferences(id))),
    ]);
    return {
      event: 'installation_active',
      workspaceCount: activeWorkspaces.length,
      userAgentCount: agents.length,
      readyConnectionCount: accountsByWorkspace.flat()
        .filter(({ lifecycle }) => lifecycle === 'ready').length,
      enabledScheduleCount: schedulesByAgent.flat()
        .filter(({ state }) => state === 'active').length,
    };
  } catch {
    // The gate intentionally remains claimed. A partial or repeatedly retried
    // snapshot would be less trustworthy than one missing daily summary.
    return undefined;
  }
}
