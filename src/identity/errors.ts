export type IdentityErrorCode =
  | 'organization_missing'
  | 'owner_claim_conflict'
  | 'owner_claim_missing'
  | 'owner_already_claimed'
  | 'external_identity_conflict'
  | 'membership_missing'
  | 'membership_conflict'
  | 'last_owner_required'
  | 'inviter_not_authorized'
  | 'invitation_missing'
  | 'invitation_not_pending'
  | 'invitation_expired'
  | 'invitation_identity_mismatch'
  | 'invitation_token_invalid'
  | 'personal_token_missing'
  | 'browser_session_missing'
  | 'auth_control_missing'
  | 'auth_control_conflict'
  | 'auth_operation_missing'
  | 'auth_operation_conflict'
  | 'auth_operation_unavailable'
  | 'auth_operation_expired'
  | 'auth_operation_step_invalid'
  | 'identity_invalid';

export class IdentityStateError extends Error {
  readonly name = 'IdentityStateError';

  constructor(
    readonly code: IdentityErrorCode,
    message: string,
    readonly details: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function identityError(
  code: IdentityErrorCode,
  message: string,
  details: Record<string, string> = {},
): IdentityStateError {
  return new IdentityStateError(code, message, details);
}
