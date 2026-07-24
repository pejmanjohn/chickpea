export const SANDBOX_SETTING_KEYS = {
  enabled: 'sandbox.enabled',
  instanceType: 'sandbox.instanceType',
  allowedHosts: 'sandbox.allowedHosts',
} as const;

export const SANDBOX_PACKAGE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
] as const;

const SUPPORTED_PACKAGE_REGISTRY_HOSTS = new Set<string>(SANDBOX_PACKAGE_REGISTRY_HOSTS);

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
