import * as v from 'valibot';

import { MemoryStateError, type MemoryEntryType } from './types.ts';

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

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CREDENTIAL_PATTERNS = [
  /\bxox[a-z]-[a-z0-9-]{20,}\b/i,
  /\bsk-ant-[a-z0-9_-]{20,}\b/i,
  /\b(?:ghp|github_pat)_[a-z0-9_]{20,}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:TAG_ADMIN_TOKEN|ADMIN_TOKEN|SLACK_(?:BOT|APP)_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\s*=\s*[^\s]{8,}/i,
];

export interface ValidMemoryContent {
  description: string;
  body: string;
  type: MemoryEntryType;
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
  if (CONTROL_CHARACTER_PATTERN.test(description) || CONTROL_CHARACTER_PATTERN.test(body)) {
    throw new MemoryStateError(
      'memory_invalid_control_character',
      'Memory content cannot contain control characters.',
    );
  }
  const combined = `${description}\n${body}`;
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(combined))) {
    throw new MemoryStateError(
      'memory_credential_rejected',
      'Memory cannot contain credential-like content.',
    );
  }
  return { description, body, type: parsed.output.type };
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
