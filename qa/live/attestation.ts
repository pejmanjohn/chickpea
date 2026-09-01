import { createHash } from 'node:crypto';

import type { DoctorTargetResolution } from './private-config.ts';

export interface WorkerDeployment {
  versionId: string;
  percentage: number;
}

export interface GatewayAttestationObservation {
  healthy: boolean;
  phase: string;
  detail: string | null;
  generation: number | null;
  versionId: string | null;
}

export interface LiveTargetObservation {
  targetAlias: string;
  workerName: string;
  deployments: WorkerDeployment[];
  bindingIdentities: Record<string, string>;
  slack: { teamId: string; appId: string };
  provider: { projectId: string; readOnlyAuthConfigId: string };
  timezone: string;
  evidenceRoot: string;
  gateway: GatewayAttestationObservation;
}

export interface LiveTargetAttestation {
  schemaVersion: 'chickpea-live-attestation/v1';
  targetAlias: string;
  servingVersion: string;
  targetFingerprint: string;
}

export type AttestationErrorCode =
  | 'INVALID_ATTESTATION'
  | 'TARGET_ALIAS_MISMATCH'
  | 'WORKER_MISMATCH'
  | 'DEPLOYMENT_VECTOR_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'SLACK_TEAM_MISMATCH'
  | 'SLACK_APP_MISMATCH'
  | 'PROVIDER_PROJECT_MISMATCH'
  | 'PROVIDER_AUTH_CONFIG_MISMATCH'
  | 'TIMEZONE_MISMATCH'
  | 'EVIDENCE_ROOT_MISMATCH'
  | 'GATEWAY_UNHEALTHY'
  | 'GATEWAY_VERSION_MISMATCH'
  | 'TARGET_DRIFT';

export class AttestationError extends Error {
  readonly code: AttestationErrorCode;

  constructor(code: AttestationErrorCode) {
    super(code);
    this.name = 'AttestationError';
    this.code = code;
  }
}

export async function attestLiveTarget(
  expected: DoctorTargetResolution,
  observed: LiveTargetObservation,
): Promise<LiveTargetAttestation> {
  validateObservation(observed);
  if (observed.targetAlias !== expected.targetAlias) fail('TARGET_ALIAS_MISMATCH');
  if (observed.deployments.length !== 1 || observed.deployments[0]?.percentage !== 100) {
    fail('DEPLOYMENT_VECTOR_MISMATCH');
  }
  const servingVersion = observed.deployments[0]!.versionId;

  const [
    workerName,
    workspaceId,
    slackAppId,
    providerProjectId,
    providerReadOnlyAuthConfigId,
    timezone,
    evidenceRoot,
    bindingIdentities,
  ] = await Promise.all([
    expected.workerName(),
    expected.workspaceId(),
    expected.slackAppId(),
    expected.providerProjectId(),
    expected.providerReadOnlyAuthConfigId(),
    expected.timezone(),
    expected.evidenceRoot(),
    expected.bindingIdentities(),
  ]);

  if (observed.workerName !== workerName) fail('WORKER_MISMATCH');
  if (!sameRecord(observed.bindingIdentities, bindingIdentities)) fail('BINDING_MISMATCH');
  if (observed.slack.teamId !== workspaceId) fail('SLACK_TEAM_MISMATCH');
  if (observed.slack.appId !== slackAppId) fail('SLACK_APP_MISMATCH');
  if (observed.provider.projectId !== providerProjectId) fail('PROVIDER_PROJECT_MISMATCH');
  if (observed.provider.readOnlyAuthConfigId !== providerReadOnlyAuthConfigId) {
    fail('PROVIDER_AUTH_CONFIG_MISMATCH');
  }
  if (observed.timezone !== timezone) fail('TIMEZONE_MISMATCH');
  if (observed.evidenceRoot !== evidenceRoot) fail('EVIDENCE_ROOT_MISMATCH');
  if (!observed.gateway.healthy) fail('GATEWAY_UNHEALTHY');
  if (observed.gateway.versionId !== servingVersion) fail('GATEWAY_VERSION_MISMATCH');

  const targetFingerprint = `sha256:${createHash('sha256').update(stableJson({
    targetAlias: expected.targetAlias,
    workerName,
    workspaceId,
    slackAppId,
    providerProjectId,
    providerReadOnlyAuthConfigId,
    timezone,
    evidenceRoot,
    bindingIdentities,
    servingVersion,
  })).digest('hex')}`;
  return Object.freeze({
    schemaVersion: 'chickpea-live-attestation/v1',
    targetAlias: expected.targetAlias,
    servingVersion,
    targetFingerprint,
  });
}

export function assertStableAttestation(
  before: LiveTargetAttestation,
  after: LiveTargetAttestation,
): void {
  if (before.targetAlias !== after.targetAlias
    || before.servingVersion !== after.servingVersion
    || before.targetFingerprint !== after.targetFingerprint) {
    fail('TARGET_DRIFT');
  }
}

function validateObservation(input: LiveTargetObservation): void {
  if (!isRecord(input)
    || !bounded(input.targetAlias)
    || !bounded(input.workerName)
    || !Array.isArray(input.deployments)
    || input.deployments.length === 0
    || input.deployments.some((deployment) => !isRecord(deployment)
      || !bounded(deployment.versionId)
      || typeof deployment.percentage !== 'number'
      || !Number.isFinite(deployment.percentage)
      || deployment.percentage < 0
      || deployment.percentage > 100)
    || !stringRecord(input.bindingIdentities)
    || !isRecord(input.slack)
    || !bounded(input.slack.teamId)
    || !bounded(input.slack.appId)
    || !isRecord(input.provider)
    || !bounded(input.provider.projectId)
    || !bounded(input.provider.readOnlyAuthConfigId)
    || !bounded(input.timezone)
    || !bounded(input.evidenceRoot, 2_048)
    || !isRecord(input.gateway)
    || typeof input.gateway.healthy !== 'boolean'
    || !bounded(input.gateway.phase)
    || (input.gateway.detail !== null && !bounded(input.gateway.detail))
    || (input.gateway.generation !== null && !Number.isSafeInteger(input.gateway.generation))
    || (input.gateway.versionId !== null && !bounded(input.gateway.versionId))) {
    fail('INVALID_ATTESTATION');
  }
}

function stableJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(',')}]`;
  if (isRecord(input)) {
    return `{${Object.keys(input).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(input[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(input);
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function stringRecord(input: unknown): input is Record<string, string> {
  return isRecord(input) && Object.keys(input).length > 0
    && Object.entries(input).every(([key, value]) => bounded(key) && bounded(value));
}

function bounded(input: unknown, max = 512): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= max;
}

function isRecord(input: unknown): input is Record<string, any> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function fail(code: AttestationErrorCode): never {
  throw new AttestationError(code);
}
