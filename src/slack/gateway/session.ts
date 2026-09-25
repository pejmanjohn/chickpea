const GATEWAY_SESSION_ROTATION_MS = 12 * 60_000;
export const GATEWAY_HEARTBEAT_TIMEOUT_MS = 90_000;
const GATEWAY_RECONNECT_BASE_MS = 1_000;
const GATEWAY_RECONNECT_MAX_MS = 60_000;

type GatewaySessionHealth =
  | 'disconnected'
  | 'connecting'
  | 'healthy'
  | 'needs_attention';

export interface GatewaySessionCheckpoint {
  health: GatewaySessionHealth;
  attempt: number;
  connectedAt?: number;
  lastHeartbeatAt?: number;
  rotateAt?: number;
  retryAt?: number;
  reason?: string;
}

/**
 * Outbound Worker WebSockets cannot hibernate. Rotate before Cloudflare's
 * documented 15-minute outbound-connection keepalive window and let a Durable
 * Object alarm establish the successor logical session.
 */
export function gatewaySessionRotationAt(now: number): number {
  return now + GATEWAY_SESSION_ROTATION_MS;
}

export function gatewayReconnectAt(
  attempt: number,
  now: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.min(Math.max(0, attempt), 10);
  const ceiling = Math.min(GATEWAY_RECONNECT_MAX_MS, GATEWAY_RECONNECT_BASE_MS * (2 ** exponent));
  const jitter = Math.max(0, Math.min(1, random()));
  return now + Math.max(GATEWAY_RECONNECT_BASE_MS, Math.floor(ceiling * (0.5 + jitter * 0.5)));
}

export function gatewaySessionHealthy(
  checkpoint: GatewaySessionCheckpoint,
  now: number,
): boolean {
  return checkpoint.health === 'healthy' &&
    checkpoint.lastHeartbeatAt !== undefined &&
    checkpoint.lastHeartbeatAt > now - GATEWAY_HEARTBEAT_TIMEOUT_MS &&
    checkpoint.rotateAt !== undefined && checkpoint.rotateAt > now;
}

export function gatewaySessionFailure(
  checkpoint: GatewaySessionCheckpoint,
  reason: string,
  now: number,
  random?: () => number,
): GatewaySessionCheckpoint {
  const attempt = checkpoint.attempt + 1;
  return {
    health: reason === 'unauthorized' || reason === 'binding_revoked'
      ? 'needs_attention'
      : 'disconnected',
    attempt,
    reason,
    retryAt: gatewayReconnectAt(attempt, now, random),
  };
}

/**
 * Heartbeat-only checkpoint changes are persisted at most this often. The
 * persisted checkpoint is read for the reconnect attempt count and, with no
 * live runner, for `needs_attention`; live health comes from the runner.
 */
export const GATEWAY_CHECKPOINT_HEARTBEAT_WRITE_MS = 60_000;

/**
 * Whether a checkpoint must be written: always on a health, attempt,
 * connection, rotation, retry, or reason change; a newer heartbeat alone only
 * once the last write is at least GATEWAY_CHECKPOINT_HEARTBEAT_WRITE_MS old.
 */
export function gatewaySessionCheckpointWriteDue(
  persisted: GatewaySessionCheckpoint | undefined,
  next: GatewaySessionCheckpoint,
  persistedAt: number | undefined,
  now: number,
): boolean {
  if (!persisted || persistedAt === undefined) return true;
  if (persisted.health !== next.health || persisted.attempt !== next.attempt ||
      persisted.connectedAt !== next.connectedAt || persisted.rotateAt !== next.rotateAt ||
      persisted.retryAt !== next.retryAt || persisted.reason !== next.reason) return true;
  if (persisted.lastHeartbeatAt === next.lastHeartbeatAt) return false;
  return now - persistedAt >= GATEWAY_CHECKPOINT_HEARTBEAT_WRITE_MS;
}
