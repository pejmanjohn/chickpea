import * as v from 'valibot';

import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';
import { isOpaqueRoutineId } from './ids.ts';
import { ROUTINE_LIMITS } from './limits.ts';
import {
  RoutineStateError,
  type RoutineDefinitionContent,
  type RoutineDestination,
  type RoutineOutputPolicy,
} from './types.ts';

const DefinitionSchema = v.object({
  name: v.string(),
  description: v.string(),
  taskText: v.string(),
  triggerKind: v.picklist(['schedule', 'once']),
  scheduleInput: v.string(),
  scheduleJson: v.string(),
  timezone: v.string(),
  outputPolicy: v.picklist(['post', 'post_on_change'] satisfies RoutineOutputPolicy[]),
  authorityMode: v.picklist(['live_channel_v1', 'live_direct_member_v1']),
});

export function validateRoutineDefinition(input: unknown): RoutineDefinitionContent {
  const parsed = v.safeParse(DefinitionSchema, input);
  if (!parsed.success) throw invalid('routine_invalid_definition', 'Routine definition is invalid.');
  const definition = {
    ...parsed.output,
    name: parsed.output.name.trim(),
    description: parsed.output.description.trim(),
    taskText: parsed.output.taskText.trim(),
    scheduleInput: parsed.output.scheduleInput.trim(),
    scheduleJson: parsed.output.scheduleJson.trim(),
    timezone: parsed.output.timezone.trim(),
  };
  if (!definition.name || !definition.taskText || !definition.scheduleInput || !definition.scheduleJson) {
    throw invalid('routine_invalid_definition', 'Routine definition cannot be empty.');
  }
  assertText('name', definition.name, ROUTINE_LIMITS.maxNameCodePoints, ROUTINE_LIMITS.maxNameBytes);
  assertText(
    'description',
    definition.description,
    ROUTINE_LIMITS.maxDescriptionCodePoints,
    ROUTINE_LIMITS.maxDescriptionBytes,
  );
  assertBytes('task', definition.taskText, ROUTINE_LIMITS.maxTaskBytes);
  assertBytes('schedule', definition.scheduleInput, 1_024);
  assertBytes('normalized schedule', definition.scheduleJson, 4_096);
  assertBytes('time zone', definition.timezone, 128);
  if (!isIanaTimeZone(definition.timezone)) {
    throw invalid('routine_invalid_timezone', 'Routine time zone must be a valid IANA time zone.');
  }
  try {
    const schedule = JSON.parse(definition.scheduleJson) as unknown;
    if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) throw new Error();
  } catch {
    throw invalid('routine_invalid_schedule', 'Normalized routine schedule is invalid.');
  }
  const combined = [
    definition.name,
    definition.description,
    definition.taskText,
    definition.scheduleInput,
  ].join('\n');
  if (hasDisallowedControlCharacter(combined)) {
    throw invalid('routine_invalid_control_character', 'Routine content cannot contain control characters.');
  }
  if (hasCredentialLikeContent(combined)) {
    throw invalid(
      'routine_credential_rejected',
      'Routine content cannot contain credentials. Configure a channel connection instead.',
    );
  }
  return definition;
}

export function validateRoutineScope(workspaceId: string, channelId: string, actorId: string): void {
  if (![workspaceId, channelId, actorId].every(isOpaqueRoutineId)) {
    throw invalid('routine_invalid_scope', 'Routine scope is invalid.');
  }
}

export function validateRoutineDestination(
  input: RoutineDestination | undefined,
  channelId: string,
): RoutineDestination {
  const destination = input ?? { kind: 'channel' as const, channelId };
  if (destination.kind === 'channel') {
    if (!isOpaqueRoutineId(destination.channelId) || destination.channelId !== channelId) {
      throw invalid('routine_invalid_destination', 'Routine destination is invalid.');
    }
    return destination;
  }
  if (
    destination.kind !== 'direct_thread' ||
    !isOpaqueRoutineId(destination.conversationId) ||
    destination.conversationId !== channelId ||
    !/^\d{1,20}\.\d{1,12}$/.test(destination.threadTs) ||
    !isOpaqueRoutineId(destination.ownerMembershipId)
  ) {
    throw invalid('routine_invalid_destination', 'Routine destination is invalid.');
  }
  return destination;
}

export function validatePublicRoutineError(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (hasDisallowedControlCharacter(trimmed)) {
    throw invalid('routine_invalid_public_error', 'Routine public error is invalid.');
  }
  if (hasCredentialLikeContent(trimmed)) {
    throw invalid('routine_invalid_public_error', 'Routine public error is invalid.');
  }
  assertBytes('public error', trimmed, ROUTINE_LIMITS.maxPublicErrorBytes);
  return trimmed;
}

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return value.length > 0 && value.length <= 128;
  } catch {
    return false;
  }
}

function assertText(label: string, value: string, codePoints: number, bytes: number): void {
  if ([...value].length > codePoints) {
    throw invalid('routine_content_too_large', `Routine ${label} is too long.`);
  }
  assertBytes(label, value, bytes);
}

function assertBytes(label: string, value: string, maximum: number): void {
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw invalid('routine_content_too_large', `Routine ${label} is too large.`);
  }
}

function invalid(code: string, message: string): RoutineStateError {
  return new RoutineStateError(code, message);
}
