import type { ApplicationIdentity } from './identity.ts';

export const SUPPORT_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'workers-ai'] as const;
export type SupportProviderStatus = 'configured' | 'missing' | 'unknown';
export interface InstallationDetails {
  identity: ApplicationIdentity;
  deployment: 'cloudflare' | 'node';
  setup: 'ready' | 'needs-attention' | 'unknown';
  providers: Record<typeof SUPPORT_PROVIDERS[number], SupportProviderStatus>;
  errors: string[];
}
const SAFE_CODES = new Set(['provider-status-unavailable', 'setup-status-unavailable']);

export function supportReport(details: InstallationDetails): string {
  const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(details.identity.version) ? details.identity.version : 'development';
  const commit = /^[a-f0-9]{40}$/.test(details.identity.sourceCommit ?? '') ? details.identity.sourceCommit : 'unknown';
  return [
    'Chickpea support report',
    `Application version: ${version}`,
    `Source commit: ${commit}`,
    `Deployment: ${details.deployment === 'cloudflare' ? 'Cloudflare' : 'Node'}`,
    'CLI version: not applicable (browser report)',
    `Setup: ${['ready', 'needs-attention'].includes(details.setup) ? details.setup : 'unknown'}`,
    ...SUPPORT_PROVIDERS.map((id) => `${id}: ${details.providers[id] === 'configured' ? 'configured (not verified)' : details.providers[id] === 'missing' ? 'missing' : 'unknown'}`),
    `Diagnostic codes: ${details.errors.filter((code) => SAFE_CODES.has(code)).join(', ') || 'none'}`,
  ].join('\n');
}
