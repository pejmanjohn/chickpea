import type { GatewayWorkspaceBinding } from './protocol.ts';

export interface GatewayInstallationAuthority {
  protocolVersion: 1;
  kind: 'installation.status';
  requestId: string;
  binding: Pick<GatewayWorkspaceBinding,
    'bindingId' | 'deploymentId' | 'workspaceId' | 'appId' | 'botUserId' | 'installedAt'>;
  grantedScopes: string[];
  grantedUserScopes: string[];
  /** Stored lifecycle/last-failure state, not current Slack token validity. */
  health: 'healthy' | 'needs_attention' | 'revoked';
  observedAt: number;
}

/** Fail closed on a different installation, replayed response, or accidental secret projection. */
export function parseGatewayInstallationAuthority(
  value: unknown,
  expected: { binding: GatewayWorkspaceBinding; deploymentId: string; requestId: string; now: number },
): GatewayInstallationAuthority {
  const invalid = () => new Error('Gateway installation authority mismatch.');
  if (!record(value) || !exactKeys(value, [
    'protocolVersion', 'kind', 'requestId', 'binding', 'grantedScopes',
    'grantedUserScopes', 'health', 'observedAt',
  ]) || value.protocolVersion !== 1 || value.kind !== 'installation.status'
    || value.requestId !== expected.requestId || !record(value.binding)
    || !exactKeys(value.binding, ['bindingId', 'deploymentId', 'workspaceId', 'appId', 'botUserId', 'installedAt'])
    || !Number.isSafeInteger(value.observedAt)
    || Math.abs(Number(value.observedAt) - expected.now) > 60_000
    || !['healthy', 'needs_attention', 'revoked'].includes(String(value.health))) throw invalid();
  for (const field of ['bindingId', 'workspaceId', 'appId', 'botUserId', 'installedAt'] as const) {
    if (value.binding[field] !== expected.binding[field]) throw invalid();
  }
  if (value.binding.deploymentId !== expected.deploymentId
    || value.binding.deploymentId !== expected.binding.deploymentId) throw invalid();
  for (const field of ['grantedScopes', 'grantedUserScopes'] as const) {
    const scopes = value[field];
    if (!Array.isArray(scopes) || scopes.length > 128
      || scopes.some((scope) => typeof scope !== 'string' || !/^[a-z][a-z0-9._:-]{0,127}$/.test(scope))
      || new Set(scopes).size !== scopes.length) throw invalid();
  }
  return value as unknown as GatewayInstallationAuthority;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
