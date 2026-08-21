export type SlackInstallationOperationalOperation =
  | 'binding_rejected'
  | 'egress_unavailable'
  | 'ingress_rejected'
  | 'setup_handshake';

export type SlackInstallationOperationalOutcome =
  | 'accepted'
  | 'ignored'
  | 'operator_repair'
  | 'rejected'
  | 'retry';

export interface SlackInstallationOperationalEvent {
  operation: SlackInstallationOperationalOperation;
  workspaceId: string;
  appId?: string;
  outcome: SlackInstallationOperationalOutcome;
  failureClass?: string;
  fallbackPrevented?: boolean;
}

const SAFE_OPERATIONAL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

/** Emit one allowlisted, content-free operational record. */
export function recordSlackInstallationOperationalEvent(
  input: SlackInstallationOperationalEvent,
): void {
  const event = {
    operation: input.operation,
    workspaceId: safeOperationalValue(input.workspaceId),
    ...(input.appId === undefined ? {} : { appId: safeOperationalValue(input.appId) }),
    outcome: input.outcome,
    ...(input.failureClass === undefined
      ? {}
      : { failureClass: safeOperationalValue(input.failureClass) }),
    ...(input.fallbackPrevented === true ? { fallbackPrevented: true } : {}),
  };
  console.info('[chickpea] slack_installation_operational', JSON.stringify(event));
}

export function recordSlackInstallationUnavailable(input: {
  workspaceId: string;
  reasonCode: string;
  retryable: boolean;
}): void {
  recordSlackInstallationOperationalEvent({
    operation: 'egress_unavailable',
    workspaceId: input.workspaceId,
    outcome: input.retryable ? 'retry' : 'operator_repair',
    failureClass: input.reasonCode,
    fallbackPrevented: true,
  });
}

function safeOperationalValue(value: string): string {
  return SAFE_OPERATIONAL_VALUE.test(value) ? value : 'invalid_metadata';
}
