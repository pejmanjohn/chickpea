import { deploymentServesManyInstallations } from '../config/installation-scope.ts';
import type { ManagementResultLinks } from './types.ts';

/**
 * Admin deep links the management service hands to callers when something is
 * Admin-only. Admin routes are path-based (`applyRoute` in
 * `assets/admin-ui/admin.js`): `/admin/settings/<section>` opens one Settings
 * section, `/admin/team` opens the member list, `/admin/agents/<id>` opens an
 * Agent. Links are presentation-only, computed from the deployment's public
 * base URL, and never carry a secret or an internal identifier.
 */

export const ADMIN_PATH = '/admin';
export const ADMIN_TEAM_PATH = '/admin/team';

export const ADMIN_SETTINGS_SECTIONS = {
  connectors: 'Connectors',
  providers: 'Model providers',
  github: 'GitHub',
  sandbox: 'Coding sandbox',
  browser: 'Browser',
  'agents-clients': 'MCP',
} as const;

export type AdminSettingsSection = keyof typeof ADMIN_SETTINGS_SECTIONS;

/** Settings sections with no MCP operation today (a provider key or connector still hands off through a tool). */
const ADMIN_ONLY_SETTINGS_SECTIONS: readonly AdminSettingsSection[] = [
  'providers', 'github', 'sandbox', 'browser', 'connectors',
];

/**
 * Sections a deployment serving many installations leaves out of Admin: the
 * host runs the coding sandbox, and the browser is not offered. Nothing names
 * or links them there.
 */
const HOSTED_HIDDEN_SETTINGS_SECTIONS: ReadonlySet<AdminSettingsSection> = new Set([
  'sandbox', 'browser',
]);

/** Whether this deployment's Admin shows a Settings section. */
export function adminSettingsSectionShown(
  section: AdminSettingsSection,
  env?: Record<string, unknown>,
): boolean {
  return !(HOSTED_HIDDEN_SETTINGS_SECTIONS.has(section) && deploymentServesManyInstallations(env));
}

/** The Admin-only Settings sections this deployment's Admin shows, in order. */
export function adminOnlySettingsSections(env?: Record<string, unknown>): AdminSettingsSection[] {
  return ADMIN_ONLY_SETTINGS_SECTIONS.filter((section) => adminSettingsSectionShown(section, env));
}

export function adminSettingsPath(section: AdminSettingsSection): string {
  return `${ADMIN_PATH}/settings/${section}`;
}

/**
 * Normalize a deployment base URL to its origin. Returns undefined when the
 * value is missing or unparsable so callers fall back to a relative Admin
 * path instead of printing a broken link.
 */
export function adminOrigin(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Absolute Settings link for one section, or the relative path without an origin. */
function adminSettingsUrl(baseUrl: string | undefined, section: AdminSettingsSection): string {
  const origin = adminOrigin(baseUrl);
  return origin ? `${origin}${adminSettingsPath(section)}` : adminSettingsPath(section);
}

export function adminTeamUrl(baseUrl: string | undefined): string {
  const origin = adminOrigin(baseUrl);
  return origin ? `${origin}${ADMIN_TEAM_PATH}` : ADMIN_TEAM_PATH;
}

/**
 * `links.admin` for a receipt or error that names one Admin-only Settings
 * section. Without a usable deployment origin there is no link: a bare path
 * in a field clients treat as a URL would read as clickable and not be. A
 * section this deployment's Admin does not show has no link either.
 */
export function adminSettingsLinks(
  baseUrl: string | undefined,
  section: AdminSettingsSection,
  env?: Record<string, unknown>,
): ManagementResultLinks | undefined {
  if (!adminSettingsSectionShown(section, env)) return undefined;
  return adminOrigin(baseUrl) ? { admin: adminSettingsUrl(baseUrl, section) } : undefined;
}

export function adminTeamLinks(baseUrl: string | undefined): ManagementResultLinks | undefined {
  return adminOrigin(baseUrl) ? { admin: adminTeamUrl(baseUrl) } : undefined;
}
