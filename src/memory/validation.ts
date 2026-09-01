import * as v from 'valibot';

import { MemoryStateError } from './types.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';

const MAX_DESCRIPTION_BYTES = 512;
const MAX_BODY_BYTES = 8 * 1_024;
const MEMORY_ENTRY_TYPES = [
  'fact',
  'decision',
  'project',
  'feedback',
  'preference',
] as const;

const MemoryContentSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1)),
  body: v.pipe(v.string(), v.minLength(1)),
  type: v.picklist(MEMORY_ENTRY_TYPES),
});

interface ValidMemoryContent {
  description: string;
  body: string;
  type: typeof MEMORY_ENTRY_TYPES[number];
}

export function validateMemoryContent(input: unknown): ValidMemoryContent {
  const parsed = v.safeParse(MemoryContentSchema, input);
  if (!parsed.success) {
    throw new MemoryStateError('memory_invalid_content', 'Memory content is invalid.');
  }
  const description = parsed.output.description.trim();
  const body = parsed.output.body.trim();
  if (description.length === 0 || body.length === 0) {
    throw new MemoryStateError('memory_invalid_content', 'Memory content cannot be empty.');
  }
  assertByteLength('Description', description, MAX_DESCRIPTION_BYTES);
  assertByteLength('Body', body, MAX_BODY_BYTES);
  if (hasDisallowedControlCharacter(description) || hasDisallowedControlCharacter(body)) {
    throw new MemoryStateError(
      'memory_invalid_control_character',
      'Memory content cannot contain control characters.',
    );
  }
  const combined = `${description}\n${body}`;
  if (hasCredentialLikeContent(combined)) {
    throw new MemoryStateError(
      'memory_credential_rejected',
      'Memory cannot contain credential-like content.',
    );
  }
  return { description, body, type: parsed.output.type };
}

/** Preserve both parts of the Slack/tool contract without duplicating one-line memories. */
export function renderMemoryContent(content: Pick<ValidMemoryContent, 'description' | 'body'>): string {
  return content.description === content.body
    ? content.body
    : `${content.description}\n\n${content.body}`;
}

function assertByteLength(label: string, value: string, maximum: number): void {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > maximum) {
    throw new MemoryStateError(
      'memory_content_too_large',
      `${label} must be at most ${maximum} bytes.`,
    );
  }
}
