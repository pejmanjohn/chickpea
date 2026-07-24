import type { SettingsStore } from './settings-store.ts';

export const SANDBOX_SETTING_KEYS = {
  enabled: 'sandbox.enabled',
  instanceType: 'sandbox.instanceType',
  allowedHosts: 'sandbox.allowedHosts',
  local: 'sandbox.local',
} as const;

export const SANDBOX_PACKAGE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

export const SANDBOX_INSTANCE_TYPES = [
  'standard-1',
  'standard-2',
  'standard-3',
  'standard-4',
] as const;

export type SandboxInstanceType = (typeof SANDBOX_INSTANCE_TYPES)[number];

export interface SandboxSettings {
  enabled: boolean;
  instanceType: SandboxInstanceType;
  allowedHosts: string[];
  localEnabled: boolean;
}

export const DEFAULT_SANDBOX_SETTINGS: Readonly<SandboxSettings> = {
  enabled: false,
  instanceType: 'standard-1',
  allowedHosts: [...SANDBOX_PACKAGE_REGISTRY_HOSTS],
  localEnabled: false,
};

const SUPPORTED_PACKAGE_REGISTRY_HOSTS = new Set<string>(SANDBOX_PACKAGE_REGISTRY_HOSTS);
const SUPPORTED_INSTANCE_TYPES = new Set<string>(SANDBOX_INSTANCE_TYPES);

export async function resolveSandboxSettings(store: SettingsStore): Promise<SandboxSettings> {
  const [enabled, instanceType, allowedHosts, localEnabled] = await store.getSettings([
    SANDBOX_SETTING_KEYS.enabled,
    SANDBOX_SETTING_KEYS.instanceType,
    SANDBOX_SETTING_KEYS.allowedHosts,
    SANDBOX_SETTING_KEYS.local,
  ]);
  return {
    enabled: enabled === 'true',
    instanceType: SUPPORTED_INSTANCE_TYPES.has(instanceType ?? '')
      ? (instanceType as SandboxInstanceType)
      : DEFAULT_SANDBOX_SETTINGS.instanceType,
    allowedHosts: parseSandboxAllowedHosts(allowedHosts),
    localEnabled: localEnabled === 'true',
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
