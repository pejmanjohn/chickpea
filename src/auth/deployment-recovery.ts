import type { SettingsStore } from '../config/settings-store.ts';
import { GATEWAY_BINDING_SETTING } from '../slack/gateway/client.ts';
import { digestDeploymentActivation } from './deployment-activation.mjs';

export const DEPLOYMENT_RECOVERY_SETTING = 'deployment.recovery.v1';
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

// Called only after the current-version deployment activation proof is verified.
// The receipt keeps the capability; the Worker keeps only its digest and scope.
export async function provisionDeploymentRecovery(settings: SettingsStore, versionId: string, digest: string): Promise<void> {
  if (!CAPABILITY.test(digest)) throw new Error('Invalid recovery digest.');
  const binding = await settings.getSetting(GATEWAY_BINDING_SETTING) ?? null;
  if (!await settings.applySettingsPatch({ expected: {key: GATEWAY_BINDING_SETTING, value: binding},
    set: [{key: DEPLOYMENT_RECOVERY_SETTING, value: JSON.stringify({versionId, digest, binding})}] })) {
    throw new Error('Gateway installation changed during recovery provisioning.');
  }
}

export async function authorizeDeploymentRecovery(settings: SettingsStore, versionId: string, authorization: string): Promise<false | {binding: string | null}> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return false;
  const raw = await settings.getSetting(DEPLOYMENT_RECOVERY_SETTING);
  if (!raw) return false;
  let value: {versionId?: unknown; digest?: unknown; binding?: unknown};
  try { value = JSON.parse(raw); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if ((value.binding !== null && typeof value.binding !== 'string') || value.versionId !== versionId || typeof value.digest !== 'string' || !CAPABILITY.test(value.digest)) return false;
  const actual = await digestDeploymentActivation(match[1]!);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ value.digest.charCodeAt(i);
  if (difference !== 0) return false;
  // A different deployment or reinstall invalidates the old receipt capability.
  const [currentAuthority, currentBinding] = await settings.getSettings([DEPLOYMENT_RECOVERY_SETTING, GATEWAY_BINDING_SETTING]);
  return currentAuthority === raw && (currentBinding ?? null) === value.binding
    ? {binding: value.binding as string | null} : false;
}
