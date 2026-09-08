export class ManagedAuthorizationExpiredError extends Error {
  readonly name = 'ManagedAuthorizationExpiredError';

  constructor(readonly metadata?: ManagedProviderFailureMetadata) {
    super('Managed connection authorization expired; reconnect the account');
  }
}

type ManagedProviderFailureCode =
  | 'validation_failed'
  | 'throttled'
  | 'provider_unavailable'
  | 'ambiguous';

export interface ManagedProviderFailureMetadata {
  providerTool?: string;
  providerVersion?: string;
  remoteCallCount: number;
  providerToolCallCount: number;
  httpStatus?: number;
  rateLimitRemaining?: number;
  retryAfterMs?: number;
  providerLogId?: string;
  /** False only when the capability's own provider tool provably never ran. */
  capabilityToolDispatched?: boolean;
  /** True only when the provider explicitly reported a terminal non-success outcome. */
  definiteFailure?: boolean;
}

export class ManagedProviderRequestError extends Error {
  readonly name = 'ManagedProviderRequestError';

  constructor(
    readonly code: ManagedProviderFailureCode,
    message: string,
    readonly metadata: ManagedProviderFailureMetadata,
  ) {
    super(message);
  }
}

/** A provider allocated a deletable remote account before start validation failed. */
export class ManagedAuthorizationAllocatedError extends Error {
  readonly name = 'ManagedAuthorizationAllocatedError';

  constructor(readonly authorizationRef: string) {
    super('Managed connection authorization allocated a remote account before failing');
  }
}
