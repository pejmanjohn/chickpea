import type { SlackIdentity, SlackIdentityLifecycle } from '../config/types.ts';

export type SlackIdentityOperationalOperation =
  | 'binding_rejected'
  | 'egress_unavailable'
  | 'fanout_ignored'
  | 'ingress_rejected'
  | 'setup_handshake';

export type SlackIdentityOperationalOutcome =
  | 'accepted'
  | 'ignored'
  | 'operator_repair'
  | 'rejected'
  | 'retry';

export interface SlackIdentityOperationalEvent {
  operation: SlackIdentityOperationalOperation;
  identityId: string;
  appId?: string;
  lifecycle?: SlackIdentityLifecycle;
  outcome: SlackIdentityOperationalOutcome;
  failureClass?: string;
  fallbackPrevented?: boolean;
}

const SAFE_OPERATIONAL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/**
 * Emit one allowlisted, content-free operational record. Constructing a fresh
 * object instead of serializing the caller input keeps accidental credentials,
 * ingress keys, and Slack content out of runtime diagnostics.
 */
export function recordSlackIdentityOperationalEvent(
  input: SlackIdentityOperationalEvent,
): void {
  const event = {
    operation: input.operation,
    identityId: safeOperationalValue(input.identityId),
    ...(input.appId === undefined
      ? {}
      : { appId: safeOperationalValue(input.appId) }),
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
    outcome: input.outcome,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: safeOperationalValue(input.failureClass) }),
    ...(input.fallbackPrevented === true ? { fallbackPrevented: true } : {}),
  };
  console.info('[chickpea] slack_identity_operational', JSON.stringify(event));
}

export function recordSlackIdentityFanoutIgnored(identity: SlackIdentity): void {
  recordSlackIdentityOperationalEvent({
    operation: 'fanout_ignored',
    identityId: identity.id,
    ...(identity.appId ? { appId: identity.appId } : {}),
    lifecycle: identity.lifecycle,
    outcome: 'ignored',
    failureClass: 'non_selected_identity',
    fallbackPrevented: true,
  });
}

export function recordSlackIdentityUnavailable(input: {
  identityId: string;
  reasonCode: string;
  retryable: boolean;
}): void {
  recordSlackIdentityOperationalEvent({
    operation: 'egress_unavailable',
    identityId: input.identityId,
    outcome: input.retryable ? 'retry' : 'operator_repair',
    failureClass: input.reasonCode,
    fallbackPrevented: true,
  });
}

function safeOperationalValue(value: string): string {
  return SAFE_OPERATIONAL_VALUE.test(value) ? value : 'invalid_metadata';
}
