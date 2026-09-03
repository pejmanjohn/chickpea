import { createHash } from 'node:crypto';

import type { DoctorTargetResolution } from './private-config.ts';

export interface WorkerDeployment {
  versionId: string;
  percentage: number;
  activatedAt?: string;
}

export interface GatewayAttestationObservation {
  healthy: boolean;
  phase: string;
  detail: string | null;
  generation: number | null;
  versionId: string | null;
}

export interface EventsAttestationObservation {
  installationHealthy: boolean;
  signedEventReceiptFresh: boolean;
  signedEventReceiptVersionId: string;
  signedEventReceiptAt: string;
  installationRevision: number;
}

export interface LiveTargetObservation {
  targetAlias: string;
  transport: 'gateway' | 'events';
  workerName: string;
  deployments: WorkerDeployment[];
  bindingIdentities: Record<string, string>;
  slack: { teamId: string; appId: string };
  provider: { projectId: string; authConfigId: string };
  timezone: string;
  evidenceRoot: string;
  gateway?: GatewayAttestationObservation;
  events?: EventsAttestationObservation;
}

export interface LiveTargetAttestation {
  schemaVersion: 'chickpea-live-attestation/v1';
  targetAlias: string;
  transport: 'gateway' | 'events';
  servingVersion: string;
  targetFingerprint: string;
}

export type AttestationErrorCode =
  | 'INVALID_ATTESTATION'
  | 'TARGET_ALIAS_MISMATCH'
  | 'TRANSPORT_MISMATCH'
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
  | 'INSTALLATION_UNHEALTHY'
  | 'SIGNED_EVENT_RECEIPT_STALE'
  | 'SIGNED_EVENT_RECEIPT_VERSION_MISMATCH'
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
  if (observed.transport !== expected.transport) fail('TRANSPORT_MISMATCH');
  if (observed.deployments.length !== 1 || observed.deployments[0]?.percentage !== 100) {
    fail('DEPLOYMENT_VECTOR_MISMATCH');
  }
  const servingVersion = observed.deployments[0]!.versionId;

  const [
    workerName,
    workspaceId,
    slackAppId,
    providerProjectId,
    providerAuthConfigId,
    timezone,
    evidenceRoot,
    bindingIdentities,
  ] = await Promise.all([
    expected.workerName(),
    expected.workspaceId(),
    expected.slackAppId(),
    expected.providerProjectId(),
    expected.providerAuthConfigId(),
    expected.timezone(),
    expected.evidenceRoot(),
    expected.bindingIdentities(),
  ]);

  if (observed.workerName !== workerName) fail('WORKER_MISMATCH');
  if (!sameRecord(observed.bindingIdentities, bindingIdentities)) fail('BINDING_MISMATCH');
  if (observed.slack.teamId !== workspaceId) fail('SLACK_TEAM_MISMATCH');
  if (observed.slack.appId !== slackAppId) fail('SLACK_APP_MISMATCH');
  if (observed.provider.projectId !== providerProjectId) fail('PROVIDER_PROJECT_MISMATCH');
  if (observed.provider.authConfigId !== providerAuthConfigId) {
    fail('PROVIDER_AUTH_CONFIG_MISMATCH');
  }
  if (observed.timezone !== timezone) fail('TIMEZONE_MISMATCH');
  if (observed.evidenceRoot !== evidenceRoot) fail('EVIDENCE_ROOT_MISMATCH');
  if (observed.transport === 'gateway') {
    if (observed.gateway === undefined || !observed.gateway.healthy) fail('GATEWAY_UNHEALTHY');
    if (observed.gateway.versionId !== servingVersion) fail('GATEWAY_VERSION_MISMATCH');
  } else {
    if (observed.events === undefined || !observed.events.installationHealthy) fail('INSTALLATION_UNHEALTHY');
    if (!observed.events.signedEventReceiptFresh) fail('SIGNED_EVENT_RECEIPT_STALE');
    if (observed.events.signedEventReceiptVersionId !== servingVersion) {
      fail('SIGNED_EVENT_RECEIPT_VERSION_MISMATCH');
    }
    const activatedAt = observed.deployments[0]?.activatedAt;
    if (activatedAt === undefined
      || Date.parse(observed.events.signedEventReceiptAt) < Date.parse(activatedAt)) {
      fail('SIGNED_EVENT_RECEIPT_STALE');
    }
  }

  const targetFingerprint = `sha256:${createHash('sha256').update(stableJson({
    targetAlias: expected.targetAlias,
    transport: expected.transport,
    workerName,
    workspaceId,
    slackAppId,
    providerProjectId,
    providerAuthConfigId,
    timezone,
    evidenceRoot,
    bindingIdentities,
    servingVersion,
  })).digest('hex')}`;
  return Object.freeze({
    schemaVersion: 'chickpea-live-attestation/v1',
    targetAlias: expected.targetAlias,
    transport: expected.transport,
    servingVersion,
    targetFingerprint,
  });
}

export function assertStableAttestation(
  before: LiveTargetAttestation,
  after: LiveTargetAttestation,
): void {
  if (before.targetAlias !== after.targetAlias
    || before.transport !== after.transport
    || before.servingVersion !== after.servingVersion
    || before.targetFingerprint !== after.targetFingerprint) {
    fail('TARGET_DRIFT');
  }
}

function validateObservation(input: LiveTargetObservation): void {
  if (!isRecord(input)
    || !bounded(input.targetAlias)
    || (input.transport !== 'gateway' && input.transport !== 'events')
    || !bounded(input.workerName)
    || !Array.isArray(input.deployments)
    || input.deployments.length === 0
    || input.deployments.some((deployment) => !isRecord(deployment)
      || !bounded(deployment.versionId)
      || typeof deployment.percentage !== 'number'
      || !Number.isFinite(deployment.percentage)
      || deployment.percentage < 0
      || deployment.percentage > 100
      || (deployment.activatedAt !== undefined && !timestamp(deployment.activatedAt)))
    || !stringRecord(input.bindingIdentities)
    || !isRecord(input.slack)
    || !bounded(input.slack.teamId)
    || !bounded(input.slack.appId)
    || !isRecord(input.provider)
    || !bounded(input.provider.projectId)
    || !bounded(input.provider.authConfigId)
    || !bounded(input.timezone)
    || !bounded(input.evidenceRoot, 2_048)
    || (input.transport === 'gateway' && !validGateway(input.gateway))
    || (input.transport === 'events' && !validEvents(input.events))
    || (input.transport === 'gateway' && input.events !== undefined)
    || (input.transport === 'events' && input.gateway !== undefined)) {
    fail('INVALID_ATTESTATION');
  }
}

function validGateway(input: unknown): input is GatewayAttestationObservation {
  return isRecord(input)
    && typeof input.healthy === 'boolean'
    && bounded(input.phase)
    && (input.detail === null || bounded(input.detail))
    && (input.generation === null || Number.isSafeInteger(input.generation))
    && (input.versionId === null || bounded(input.versionId));
}

function validEvents(input: unknown): input is EventsAttestationObservation {
  return isRecord(input)
    && typeof input.installationHealthy === 'boolean'
    && typeof input.signedEventReceiptFresh === 'boolean'
    && bounded(input.signedEventReceiptVersionId)
    && timestamp(input.signedEventReceiptAt)
    && Number.isSafeInteger(input.installationRevision)
    && Number(input.installationRevision) >= 0;
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

function timestamp(input: unknown): input is string {
  return typeof input === 'string' && Number.isFinite(Date.parse(input));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function fail(code: AttestationErrorCode): never {
  throw new AttestationError(code);
}
