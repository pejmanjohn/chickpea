import type { SlackInboundEnvelope } from '../transport/types.ts';

export const CHICKPEA_GATEWAY_PROTOCOL_VERSION = 1 as const;
export const MAX_GATEWAY_FRAME_BYTES = 1_048_576;
export const MAX_GATEWAY_CLOCK_SKEW_MS = 5 * 60_000;

export const GATEWAY_SLACK_OPERATIONS = [
  'auth.test',
  'users.info',
  'users.list',
  'users.conversations',
  'conversations.info',
  'conversations.list',
  'conversations.members',
  'conversations.open',
  'conversations.join',
  'conversations.history',
  'conversations.replies',
  'usergroups.list',
  'usergroups.create',
  'usergroups.update',
  'usergroups.disable',
  'usergroups.enable',
  'views.publish',
  'chat.postMessage',
  'chat.postEphemeral',
  'chat.update',
  'chat.delete',
  'chat.startStream',
  'chat.appendStream',
  'chat.stopStream',
  'assistant.threads.setStatus',
  'assistant.threads.setSuggestedPrompts',
  'assistant.threads.setTitle',
  'files.uploadV2',
  'reactions.get',
  'reactions.add',
  'reactions.remove',
] as const;

export type GatewaySlackOperation = (typeof GATEWAY_SLACK_OPERATIONS)[number];

export interface GatewayPublicKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface GatewaySignedRequest {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  deploymentId: string;
  requestId: string;
  issuedAt: number;
  nonce: string;
  signature: string;
}

export interface GatewayClaimCreateRequest extends GatewaySignedRequest {
  kind: 'claim.create';
  publicKey: GatewayPublicKey;
  returnUrl?: string;
  reconnectBindingId?: string;
}

export interface GatewayClaimCreateResponse {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  claimId: string;
  authorizationUrl: string;
  expiresAt: number;
}

export interface GatewayClaimStatusResponse {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  claimId: string;
  state: 'pending' | 'bound' | 'expired' | 'cancelled';
  expiresAt: number;
  binding?: GatewayWorkspaceBinding;
}

export interface GatewayWorkspaceBinding {
  bindingId: string;
  deploymentId: string;
  workspaceId: string;
  appId: string;
  clientId: string;
  botUserId: string;
  installerSlackUserId: string;
  sessionUrl: string;
  installedAt: number;
}

export interface GatewaySessionHello extends GatewaySignedRequest {
  kind: 'session.hello';
  bindingId: string;
}

export interface GatewaySessionReady {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  kind: 'session.ready';
  bindingId: string;
  workspaceId: string;
  sessionId: string;
  heartbeatIntervalMs: number;
  rotateAt: number;
}

export interface GatewayEventDelivery {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  kind: 'event.deliver';
  deliveryId: string;
  bindingId: string;
  workspaceId: string;
  envelope: SlackInboundEnvelope;
}

export interface GatewayAgentSelectionDelivery {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  kind: 'interaction.agent_selected';
  deliveryId: string;
  bindingId: string;
  workspaceId: string;
  userId: string;
  agentId: string;
}

export type GatewayInboundDelivery = GatewayEventDelivery | GatewayAgentSelectionDelivery;

export interface GatewayEventAck {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  kind: 'event.ack';
  deliveryId: string;
  outcome: 'accepted' | 'duplicate' | 'rejected';
}

export interface GatewayHeartbeat {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  kind: 'session.ping' | 'session.pong';
  at: number;
}

export interface GatewayOperationRequest extends GatewaySignedRequest {
  kind: 'slack.operation';
  bindingId: string;
  workspaceId: string;
  operation: GatewaySlackOperation;
  input: Record<string, unknown>;
}

export interface GatewayOperationResponse {
  protocolVersion: typeof CHICKPEA_GATEWAY_PROTOCOL_VERSION;
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
}

export interface GatewayAvatarPublishResponse {
  url: string;
}

export type GatewayServerFrame =
  | GatewaySessionReady
  | GatewayEventDelivery
  | GatewayAgentSelectionDelivery
  | GatewayHeartbeat;

export type GatewayClientFrame = GatewaySessionHello | GatewayEventAck | GatewayHeartbeat;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KEY_PART_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const OPERATION_SET = new Set<string>(GATEWAY_SLACK_OPERATIONS);

export class GatewayProtocolError extends Error {
  constructor(readonly code: string) {
    super(`Chickpea gateway protocol error (${code})`);
    this.name = 'GatewayProtocolError';
  }
}

export function parseGatewayServerFrame(value: unknown): GatewayServerFrame {
  const record = exactRecord(value, 'invalid_frame');
  requireProtocolVersion(record.protocolVersion);
  switch (record.kind) {
    case 'session.ready':
      return {
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        kind: 'session.ready',
        bindingId: requireId(record.bindingId),
        workspaceId: requireId(record.workspaceId),
        sessionId: requireId(record.sessionId),
        heartbeatIntervalMs: requirePositiveInteger(record.heartbeatIntervalMs, 300_000),
        rotateAt: requireTimestamp(record.rotateAt),
      };
    case 'event.deliver': {
      const envelope = parseSlackInboundEnvelope(record.envelope);
      const workspaceId = requireId(record.workspaceId);
      if (envelope.workspaceId !== workspaceId) throw new GatewayProtocolError('workspace_mismatch');
      return {
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        kind: 'event.deliver',
        deliveryId: requireId(record.deliveryId),
        bindingId: requireId(record.bindingId),
        workspaceId,
        envelope,
      };
    }
    case 'interaction.agent_selected':
      return {
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        kind: 'interaction.agent_selected',
        deliveryId: requireId(record.deliveryId),
        bindingId: requireId(record.bindingId),
        workspaceId: requireId(record.workspaceId),
        userId: requireId(record.userId),
        agentId: requireId(record.agentId),
      };
    case 'session.ping':
    case 'session.pong':
      return {
        protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
        kind: record.kind,
        at: requireTimestamp(record.at),
      };
    default:
      throw new GatewayProtocolError('unknown_frame');
  }
}

export function parseGatewayFrameText(raw: string): GatewayServerFrame {
  if (new TextEncoder().encode(raw).byteLength > MAX_GATEWAY_FRAME_BYTES) {
    throw new GatewayProtocolError('frame_too_large');
  }
  try {
    return parseGatewayServerFrame(JSON.parse(raw));
  } catch (error) {
    if (error instanceof GatewayProtocolError) throw error;
    throw new GatewayProtocolError('invalid_json');
  }
}

export function parseGatewayClaimCreateResponse(value: unknown): GatewayClaimCreateResponse {
  const record = exactRecord(value, 'invalid_claim');
  requireProtocolVersion(record.protocolVersion);
  return {
    protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
    claimId: requireId(record.claimId),
    authorizationUrl: requireHttpsUrl(record.authorizationUrl),
    expiresAt: requireTimestamp(record.expiresAt),
  };
}

export function parseGatewayClaimStatusResponse(value: unknown): GatewayClaimStatusResponse {
  const record = exactRecord(value, 'invalid_claim');
  requireProtocolVersion(record.protocolVersion);
  const state = record.state;
  if (!['pending', 'bound', 'expired', 'cancelled'].includes(String(state))) {
    throw new GatewayProtocolError('invalid_claim_state');
  }
  const binding = record.binding === undefined ? undefined : parseGatewayBinding(record.binding);
  if (state === 'bound' && !binding) throw new GatewayProtocolError('binding_missing');
  if (state !== 'bound' && binding) throw new GatewayProtocolError('unexpected_binding');
  return {
    protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
    claimId: requireId(record.claimId),
    state: state as GatewayClaimStatusResponse['state'],
    expiresAt: requireTimestamp(record.expiresAt),
    ...(binding ? { binding } : {}),
  };
}

export function parseGatewayOperationResponse(value: unknown): GatewayOperationResponse {
  const record = exactRecord(value, 'invalid_operation_response');
  requireProtocolVersion(record.protocolVersion);
  const requestId = requireId(record.requestId);
  if (typeof record.ok !== 'boolean') throw new GatewayProtocolError('invalid_operation_response');
  if (record.ok) {
    return {
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      requestId,
      ok: true,
      result: exactRecord(record.result ?? {}, 'invalid_operation_result'),
    };
  }
  const error = exactRecord(record.error, 'invalid_operation_error');
  return {
    protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: requireId(error.code),
      retryable: error.retryable === true,
      ...(error.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: requirePositiveInteger(error.retryAfterMs, 3_600_000) }),
    },
  };
}

export function parseGatewayAvatarPublishResponse(value: unknown): GatewayAvatarPublishResponse {
  const record = exactRecord(value, 'invalid_avatar_response');
  return { url: requireHttpsUrl(record.url) };
}

export function gatewayOperationAllowed(value: unknown): value is GatewaySlackOperation {
  return typeof value === 'string' && OPERATION_SET.has(value);
}

export function canonicalGatewayPayload(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function gatewaySigningPayload(
  value: Omit<GatewaySignedRequest, 'signature'> & Record<string, unknown>,
): string {
  const { signature: _signature, ...unsigned } = value as Record<string, unknown>;
  return canonicalGatewayPayload(unsigned);
}

function parseGatewayBinding(value: unknown): GatewayWorkspaceBinding {
  const record = exactRecord(value, 'invalid_binding');
  return {
    bindingId: requireId(record.bindingId),
    deploymentId: requireId(record.deploymentId),
    workspaceId: requireId(record.workspaceId),
    appId: requireId(record.appId),
    clientId: requireId(record.clientId),
    botUserId: requireId(record.botUserId),
    installerSlackUserId: requireId(record.installerSlackUserId),
    sessionUrl: requireWssUrl(record.sessionUrl),
    installedAt: requireTimestamp(record.installedAt),
  };
}

function parseSlackInboundEnvelope(value: unknown): SlackInboundEnvelope {
  const record = exactRecord(value, 'invalid_event');
  const event = exactRecord(record.event, 'invalid_event');
  return {
    workspaceId: requireId(record.workspaceId),
    eventId: requireId(record.eventId),
    eventTime: requireTimestamp(record.eventTime),
    event: event as unknown as SlackInboundEnvelope['event'],
  };
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      // Signatures must not depend on ICU locale data. Compare JavaScript
      // strings by code units so Node, workerd, and the private gateway produce
      // byte-identical payloads for every accepted key.
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  throw new GatewayProtocolError('non_canonical_value');
}

function exactRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayProtocolError(code);
  }
  return value as Record<string, unknown>;
}

function requireProtocolVersion(value: unknown): void {
  if (value !== CHICKPEA_GATEWAY_PROTOCOL_VERSION) {
    throw new GatewayProtocolError('unsupported_version');
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new GatewayProtocolError('invalid_id');
  }
  return value;
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new GatewayProtocolError('invalid_timestamp');
  }
  return Number(value);
}

function requirePositiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new GatewayProtocolError('invalid_integer');
  }
  return Number(value);
}

function requireHttpsUrl(value: unknown): string {
  return requireUrl(value, 'https:');
}

function requireWssUrl(value: unknown): string {
  return requireUrl(value, 'wss:');
}

function requireUrl(value: unknown, protocol: 'https:' | 'wss:'): string {
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new GatewayProtocolError('invalid_url');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GatewayProtocolError('invalid_url');
  }
  if (parsed.protocol !== protocol || parsed.username || parsed.password || parsed.hash) {
    throw new GatewayProtocolError('invalid_url');
  }
  return parsed.toString();
}

export function parseGatewayPublicKey(value: unknown): GatewayPublicKey {
  const record = exactRecord(value, 'invalid_public_key');
  if (
    record.kty !== 'EC' || record.crv !== 'P-256' ||
    typeof record.x !== 'string' || !KEY_PART_PATTERN.test(record.x) ||
    typeof record.y !== 'string' || !KEY_PART_PATTERN.test(record.y)
  ) {
    throw new GatewayProtocolError('invalid_public_key');
  }
  return { kty: 'EC', crv: 'P-256', x: record.x, y: record.y };
}
