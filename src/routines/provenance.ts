import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';
import { stripLeadingUserMentions } from '../slack/command-address.ts';
import { isOpaqueRoutineId } from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  RoutineStateError,
  type RoutineRequestProvenanceInput,
} from './types.ts';

const SLACK_TIMESTAMP = /^\d{1,16}\.\d{1,9}$/;

export function validateRoutineRequestProvenanceInput(
  input: RoutineRequestProvenanceInput,
): RoutineRequestProvenanceInput {
  const requestText = input.requestText.trim();
  if (
    !['slack_request', 'slack_clone'].includes(input.sourceKind) ||
    !['current_request', 'previous_revision', 'cloned_revision'].includes(input.authoritySource) ||
    !isOpaqueRoutineId(input.eventId) ||
    !SLACK_TIMESTAMP.test(input.messageTs) ||
    !SLACK_TIMESTAMP.test(input.threadTs) ||
    !requestText
  ) {
    throw invalid('routine_provenance_invalid', 'Routine request provenance is invalid.');
  }
  if (
    new TextEncoder().encode(requestText).byteLength > ROUTINE_LIMITS.maxSourceRequestBytes ||
    hasDisallowedControlCharacter(requestText)
  ) {
    throw invalid('routine_provenance_invalid', 'The original routine request is not safe to retain.');
  }
  if (hasCredentialLikeContent(requestText)) {
    throw invalid(
      'routine_credential_rejected',
      'Routine requests cannot contain credentials. Configure a channel connection instead.',
    );
  }
  const sourceRoutineId = input.sourceRoutineId ?? null;
  const sourceRoutineVersion = input.sourceRoutineVersion ?? null;
  if (
    (sourceRoutineId !== null && !isOpaqueRoutineId(sourceRoutineId)) ||
    (sourceRoutineVersion !== null && (!Number.isSafeInteger(sourceRoutineVersion) || sourceRoutineVersion < 1)) ||
    ((sourceRoutineId === null) !== (sourceRoutineVersion === null))
  ) {
    throw invalid('routine_provenance_invalid', 'Routine request provenance is invalid.');
  }
  return {
    ...input,
    requestText,
    sourceRoutineId,
    sourceRoutineVersion,
  };
}

/**
 * Previous authority is available only for edits whose intent deliberately
 * omits taskText. The command layer selects this source only in that case.
 */
export function assertRoutineTaskBoundToPrevious(
  taskText: string,
  previousTaskText: string,
  _requestText: string,
): void {
  if (normalizeAuthorityText(taskText) !== normalizeAuthorityText(previousTaskText)) {
    throw invalid(
      'routine_source_authority_mismatch',
      'The normalized routine task must exactly match its prior task.',
    );
  }
}

export function normalizeAuthorityText(text: string): string {
  return stripLeadingUserMentions(text)
    .trim()
    .replace(/\s+/g, ' ');
}

function invalid(code: string, message: string): RoutineStateError {
  return new RoutineStateError(code, message);
}
