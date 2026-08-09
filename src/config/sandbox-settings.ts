import type { SettingsStore } from './settings-store.ts';
import { parseMonthlySessionCap } from '../sandbox/session-cap.ts';

export const SANDBOX_SETTING_KEYS = {
  installRequested: 'sandbox.installRequested',
  enabled: 'sandbox.enabled',
  allowedHosts: 'sandbox.allowedHosts',
  monthlySessionCap: 'sandbox.monthlySessionCap',
} as const;

export const SANDBOX_PACKAGE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

export const SANDBOX_INSTANCE_TYPE = 'standard-1' as const;
export type SandboxInstanceType = typeof SANDBOX_INSTANCE_TYPE;

export interface SandboxSettings {
  installRequested: boolean;
  enabled: boolean;
  instanceType: SandboxInstanceType;
  allowedHosts: string[];
  monthlySessionCap: number;
  monthlySessionCapConfigured: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: Readonly<SandboxSettings> = {
  installRequested: false,
  enabled: false,
  instanceType: SANDBOX_INSTANCE_TYPE,
  allowedHosts: [...SANDBOX_PACKAGE_REGISTRY_HOSTS],
  monthlySessionCap: 0,
  monthlySessionCapConfigured: false,
};

const SUPPORTED_PACKAGE_REGISTRY_HOSTS = new Set<string>(SANDBOX_PACKAGE_REGISTRY_HOSTS);

export async function resolveSandboxSettings(store: SettingsStore): Promise<SandboxSettings> {
  const [installRequested, enabled, allowedHosts, monthlySessionCap] = await store.getSettings([
    SANDBOX_SETTING_KEYS.installRequested,
    SANDBOX_SETTING_KEYS.enabled,
    SANDBOX_SETTING_KEYS.allowedHosts,
    SANDBOX_SETTING_KEYS.monthlySessionCap,
  ]);
  return {
    installRequested: installRequested === 'true',
    enabled: enabled === 'true',
    instanceType: SANDBOX_INSTANCE_TYPE,
    allowedHosts: parseSandboxAllowedHosts(allowedHosts),
    monthlySessionCap: parseMonthlySessionCap(monthlySessionCap),
    monthlySessionCapConfigured: monthlySessionCap !== undefined,
  };
}

export function parseSandboxAllowedHosts(raw: string | undefined): string[] {
  // Unconfigured = permit the full curated registry set, so the coding loop's
  // `npm install` / `pip install` works out of the box. The set is a vetted
  // constant (npm + PyPI), not arbitrary operator input, so default-permit is
  // safe. An operator who explicitly configures the setting gets exactly their
  // (curated-filtered) list — including an explicit empty array to block all.
  if (raw === undefined) return [...SANDBOX_PACKAGE_REGISTRY_HOSTS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...SANDBOX_PACKAGE_REGISTRY_HOSTS];
  }
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    return [...SANDBOX_PACKAGE_REGISTRY_HOSTS];
  }
  return [
    ...new Set(
      parsed
        .map((host) => host.trim().toLowerCase())
        .filter((host) => SUPPORTED_PACKAGE_REGISTRY_HOSTS.has(host)),
    ),
  ];
}
