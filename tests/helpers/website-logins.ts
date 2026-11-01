import { WEBSITE_LOGINS_SETTING } from '../../src/browser/logins.ts';
import type { SettingsStore } from '../../src/config/settings-store.ts';

/**
 * Rewrites a saved login's catalog record as releases before team-only
 * website logins stored a member's personal login: owned and added by that
 * member, in the field order they wrote. Returns the record's stored JSON.
 */
export async function storeAsPersonalLogin(
  settings: Pick<SettingsStore, 'getSetting' | 'setSetting'>,
  loginId: string,
  membershipId: string,
): Promise<string> {
  const catalog = JSON.parse((await settings.getSetting(WEBSITE_LOGINS_SETTING)) ?? '[]') as Array<Record<string, unknown>>;
  let record: Record<string, unknown> | undefined;
  const next = catalog.map((login) => {
    if (login.id !== loginId) return login;
    const { id, host, label, ownerKind: _team, createdByMembershipId: _by, ...rest } = login;
    record = { id, host, label, ownerKind: 'member', ownerMembershipId: membershipId, createdByMembershipId: membershipId, ...rest };
    return record;
  });
  if (!record) throw new Error(`No saved login ${loginId}.`);
  await settings.setSetting(WEBSITE_LOGINS_SETTING, JSON.stringify(next));
  return JSON.stringify(record);
}
