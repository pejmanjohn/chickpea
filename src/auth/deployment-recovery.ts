import type { SettingsStore } from '../config/settings-store.ts';
import { GATEWAY_BINDING_SETTING } from '../slack/gateway/client.ts';
import { digestDeploymentActivation } from './deployment-activation.mjs';

export const DEPLOYMENT_RECOVERY_SETTING = 'deployment.recovery.v1';
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
interface RecoveryState {
  versionId: string;
  digest: string;
  binding: string | null;
  intent: 'upgrade' | 'recover';
}
export interface RecoveryAuthority extends RecoveryState { raw: string }
function parse(raw: string | undefined): RecoveryState | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.versionId === 'string' && typeof value.digest === 'string' && CAPABILITY.test(value.digest) &&
        (value.binding === null || typeof value.binding === 'string') && ['upgrade','recover'].includes(value.intent)) return value;
  } catch { /* Unrecognized authority cannot authorize a mutation. */ }
  return undefined;
}

// A new receipt starts an upgrade. Re-provisioning the same receipt, including
// repairing a candidate during recovery, cannot undo its durable recovery intent.
export async function provisionDeploymentRecovery(settings: SettingsStore, versionId: string, digest: string): Promise<RecoveryAuthority> {
  if (!CAPABILITY.test(digest)) throw new Error('Invalid recovery digest.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const [priorRaw, bindingRaw] = await settings.getSettings([DEPLOYMENT_RECOVERY_SETTING, GATEWAY_BINDING_SETTING]);
    const prior = parse(priorRaw);
    const binding = bindingRaw ?? null;
    const value: RecoveryState = {versionId, digest, binding, intent: prior?.digest === digest ? prior.intent : 'upgrade'};
    const raw = JSON.stringify(value);
    if (!await settings.applySettingsPatch({expected:{key:DEPLOYMENT_RECOVERY_SETTING,value:priorRaw ?? null},
      set:[{key:DEPLOYMENT_RECOVERY_SETTING,value:raw}]})) continue;
    if ((await settings.getSetting(GATEWAY_BINDING_SETTING) ?? null) !== binding) throw new Error('Gateway installation changed during recovery provisioning.');
    return {...value,raw};
  }
  throw new Error('Deployment recovery authority changed concurrently.');
}

export async function deploymentUpgradeAllowed(settings: SettingsStore, authority: RecoveryAuthority): Promise<boolean> {
  const [raw,binding] = await settings.getSettings([DEPLOYMENT_RECOVERY_SETTING,GATEWAY_BINDING_SETTING]);
  return authority.intent === 'upgrade' && raw === authority.raw && (binding ?? null) === authority.binding;
}

export async function authorizeDeploymentRecovery(settings: SettingsStore, versionId: string, authorization: string): Promise<false | RecoveryAuthority> {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match) return false;
  const raw = await settings.getSetting(DEPLOYMENT_RECOVERY_SETTING);
  const value = parse(raw);
  if (!value || value.versionId !== versionId) return false;
  const actual = await digestDeploymentActivation(match[1]!);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ value.digest.charCodeAt(i);
  if (difference !== 0) return false;
  const [currentAuthority,currentBinding] = await settings.getSettings([DEPLOYMENT_RECOVERY_SETTING,GATEWAY_BINDING_SETTING]);
  return currentAuthority === raw && (currentBinding ?? null) === value.binding ? {...value,raw:raw!} : false;
}

export async function beginDeploymentRecovery(settings: SettingsStore, versionId: string, authorization: string): Promise<false | RecoveryAuthority> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const authority = await authorizeDeploymentRecovery(settings,versionId,authorization);
    if (!authority || authority.intent === 'recover') return authority;
    const {raw:priorRaw,...value} = authority;
    const raw = JSON.stringify({...value,intent:'recover'});
    if (await settings.applySettingsPatch({expected:{key:DEPLOYMENT_RECOVERY_SETTING,value:priorRaw},set:[{key:DEPLOYMENT_RECOVERY_SETTING,value:raw}]})) {
      return authorizeDeploymentRecovery(settings,versionId,authorization);
    }
  }
  throw new Error('Deployment recovery authority changed concurrently.');
}
