/**
 * One structured line per OAuth credential lifecycle outcome, shared by the MCP
 * and API lanes. Records only bounded codes and timings: never tokens, client
 * ids, URLs, provider response bodies, or provider error descriptions.
 */

export type OAuthRefreshTrigger = 'turn' | 'admin' | 'keepalive';

export type OAuthRefreshOutcome =
  /** The token endpoint issued a new access token. */
  | 'refreshed'
  /** The provider rejected the grant or client; the credential is unusable. */
  | 'rejected'
  /** The refresh failed transiently; the stored credential was kept. */
  | 'unavailable'
  /** An access-only credential passed its expiry; it cannot be renewed. */
  | 'expired'
  /** A connection that should be authorized has no stored credential. */
  | 'missing';

export interface OAuthRefreshTelemetryEvent {
  event: 'chickpea.oauth.refresh';
  lane: 'mcp' | 'api';
  connectionId: string;
  trigger: OAuthRefreshTrigger;
  outcome: OAuthRefreshOutcome;
  /** OAuth error code for provider rejections, otherwise a local failure class. */
  reason: string | null;
  tokenDeleted: boolean;
  /** Time since the credential was issued or last refreshed. */
  tokenAgeMs: number | null;
  durationMs: number | null;
}

export interface OAuthRefreshTelemetry {
  trigger: OAuthRefreshTrigger;
  emit?: (event: OAuthRefreshTelemetryEvent) => void;
}

const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function emitOAuthRefreshTelemetry(
  telemetry: OAuthRefreshTelemetry | undefined,
  event: Omit<OAuthRefreshTelemetryEvent, 'event' | 'trigger'>,
): void {
  const record: OAuthRefreshTelemetryEvent = {
    event: 'chickpea.oauth.refresh',
    ...event,
    trigger: telemetry?.trigger ?? 'turn',
    // Provider error codes are attacker-influenced text; keep only the
    // registered-code shape so a hostile server cannot inject log content.
    reason: event.reason && REASON_PATTERN.test(event.reason) ? event.reason : event.reason ? 'other' : null,
  };
  try {
    (telemetry?.emit ?? ((value) => console.info(value)))(record);
  } catch {
    // Observability must not alter credential behavior.
  }
}

/** Report one renewal outcome for a credential, deriving its age and duration. */
export function reportOAuthRefresh(
  telemetry: OAuthRefreshTelemetry | undefined,
  input: {
    lane: OAuthRefreshTelemetryEvent['lane'];
    ref: { agentId: string; connectionId: string };
    now: number;
    outcome: OAuthRefreshOutcome;
    reason: string | null;
    tokenDeleted: boolean;
    obtainedAt?: number;
    startedAt?: number;
  },
): void {
  const { ref, now } = input;
  emitOAuthRefreshTelemetry(telemetry, {
    lane: input.lane,
    // Connection accounts are keyed by their own id; legacy lanes by Agent and connection.
    connectionId: ref.connectionId === 'account' && ref.agentId.startsWith('connection_')
      ? ref.agentId
      : `${ref.agentId}/${ref.connectionId}`,
    outcome: input.outcome,
    reason: input.reason,
    tokenDeleted: input.tokenDeleted,
    tokenAgeMs: input.obtainedAt === undefined ? null : Math.max(0, now - input.obtainedAt),
    durationMs: input.startedAt === undefined ? null : Math.max(0, now - input.startedAt),
  });
}

/** Bounded failure class for a refresh request that produced no OAuth error code. */
export function oauthRequestFailureReason(error: unknown): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'timeout';
  }
  if (error instanceof TypeError) return 'network';
  return 'request_failed';
}
