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
 * A model may select a contiguous part of the current request, but it cannot
 * rewrite that part. This keeps identifiers and other concrete targets bound
 * to the Slack text that authorized the saved task.
 */
export function assertRoutineTaskBoundToSource(taskText: string, requestText: string): void {
  const normalizedTask = normalizeAuthorityText(taskText);
  const normalizedRequest = normalizeAuthorityText(requestText);
  if (!normalizedTask) {
    throw invalid(
      'routine_source_authority_mismatch',
      'The normalized routine task must be an exact part of the original Slack request.',
    );
  }
  let offset = normalizedRequest.indexOf(normalizedTask);
  let found = false;
  let onlyNegatedMatches = false;
  while (offset >= 0) {
    found = true;
    if (!sourcePrefixNegatesTask(normalizedRequest, offset)) return;
    onlyNegatedMatches = true;
    offset = normalizedRequest.indexOf(normalizedTask, offset + normalizedTask.length);
  }
  throw invalid(
    'routine_source_authority_mismatch',
    found && onlyNegatedMatches
      ? 'The normalized routine task cannot discard a negative directive from the original Slack request.'
      : 'The normalized routine task must be an exact part of the original Slack request.',
  );
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

/** Only explicit future-delivery wording can bind a Channel routine to a thread. */
export function requestsChannelThreadDelivery(requestText: string): boolean {
  const text = requestText
    .replace(/```[\s\S]*?```|`[^`]*`|"[^"]*"|“[^”]*”/g, ' ')
    .replace(/^\s*>.*$/gm, ' ');
  for (const match of text.matchAll(/\b(?:in|to)\s+(?:this|the current|this request's)\s+thread\b/gi)) {
    const offset = match.index!;
    const start = Math.max(...['.', '!', '?', ';', '\n'].map((delimiter) =>
      text.lastIndexOf(delimiter, offset - 1))) + 1;
    const end = text.slice(offset).search(/[.!?;\n]/);
    const clause = text.slice(start, end < 0 ? undefined : offset + end);
    if (/\bnot\s*$/i.test(text.slice(start, offset)) ||
        sourcePrefixNegatesTask(text, offset) ||
        /\b(?:acknowledge|acknowledgement|acknowledgment|confirmation|hypothetically|example|explain|what if)\b/i.test(clause) ||
        (end >= 0 && text[offset + end] === '?')) continue;
    return true;
  }
  return false;
}

function sourcePrefixNegatesTask(requestText: string, taskOffset: number): boolean {
  const clauseStart = Math.max(
    requestText.lastIndexOf('.', taskOffset - 1),
    requestText.lastIndexOf('!', taskOffset - 1),
    requestText.lastIndexOf('?', taskOffset - 1),
    requestText.lastIndexOf(';', taskOffset - 1),
    requestText.lastIndexOf('\n', taskOffset - 1),
  ) + 1;
  const prefix = requestText.slice(clauseStart, taskOffset).trim();
  return /\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't|not\s+to|avoid|refrain\s+from|without)\b/i
    .test(prefix);
}

function invalid(code: string, message: string): RoutineStateError {
  return new RoutineStateError(code, message);
}
