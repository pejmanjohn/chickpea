import { hostedSandboxPolicy } from './hosted-sandbox-policy.ts';
import {
  deploymentServesManyInstallations,
  InstallationContextError,
  installationScopeOf,
} from './installation-scope.ts';
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

const SANDBOX_INSTANCE_TYPE = 'standard-1' as const;
type SandboxInstanceType = typeof SANDBOX_INSTANCE_TYPE;

/** The host's per-installation limits on running containers; standalone has none. */
export interface SandboxContainerLimits {
  monthlyContainerHours: number;
  maxRunningContainers: number;
}

interface SandboxSettings {
  installRequested: boolean;
  enabled: boolean;
  instanceType: SandboxInstanceType;
  allowedHosts: string[];
  monthlySessionCap: number;
  monthlySessionCapConfigured: boolean;
  /** Present only on a deployment serving many installations, from the host's policy. */
  containerLimits?: SandboxContainerLimits;
}

const SUPPORTED_PACKAGE_REGISTRY_HOSTS = new Set<string>(SANDBOX_PACKAGE_REGISTRY_HOSTS);

/**
 * The coding sandbox settings a turn or Admin acts on. Standalone: the
 * operator's settings, as always. A deployment serving many installations:
 * the host's policy for the env's installation (hosted-sandbox-policy.ts);
 * the tenant's `sandbox.*` settings are not read, and an env naming no
 * installation is refused.
 */
export async function resolveSandboxSettings(
  store: SettingsStore,
  env: Record<string, unknown> | undefined,
): Promise<SandboxSettings> {
  if (deploymentServesManyInstallations(env)) {
    const scope = installationScopeOf(env);
    if (!scope) {
      throw new InstallationContextError(
        'installation_context_missing',
        'This deployment serves many installations and the request has none.',
      );
    }
    const policy = await hostedSandboxPolicy(scope.installationId);
    return {
      installRequested: false,
      enabled: policy.enabled,
      instanceType: SANDBOX_INSTANCE_TYPE,
      allowedHosts: curatedSandboxHosts(policy.allowedHosts),
      monthlySessionCap: policy.monthlySessionCap,
      monthlySessionCapConfigured: true,
      containerLimits: {
        monthlyContainerHours: policy.monthlyContainerHours,
        maxRunningContainers: policy.maxRunningContainers,
      },
    };
  }
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
  return curatedSandboxHosts(parsed);
}

function curatedSandboxHosts(hosts: readonly string[]): string[] {
  return [
    ...new Set(
      hosts
        .map((host) => host.trim().toLowerCase())
        .filter((host) => SUPPORTED_PACKAGE_REGISTRY_HOSTS.has(host)),
    ),
  ];
}
