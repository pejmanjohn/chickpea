import { COMMON_PASSWORDS } from './generated-common-passwords.ts';

export type PasswordPolicyErrorCode = 'too_short' | 'too_long' | 'common' | 'context';

export class PasswordPolicyError extends Error {
  readonly name = 'PasswordPolicyError';

  constructor(readonly code: PasswordPolicyErrorCode) {
    super('Choose a longer, less predictable password.');
  }
}

export interface PasswordPolicyContext {
  email?: string | null;
  organizationName?: string | null;
  workspaceName?: string | null;
}

const COMMON_PASSWORD_SET = new Set<string>(COMMON_PASSWORDS);
const MIN_CODE_POINTS = 15;
const MAX_CODE_POINTS = 128;
const MAX_UTF8_BYTES = 512;

export function assertPasswordPolicy(
  password: string,
  context: PasswordPolicyContext = {},
): void {
  const codePointLength = Array.from(password).length;
  if (codePointLength < MIN_CODE_POINTS) throw new PasswordPolicyError('too_short');
  if (codePointLength > MAX_CODE_POINTS || new TextEncoder().encode(password).length > MAX_UTF8_BYTES) {
    throw new PasswordPolicyError('too_long');
  }

  const normalized = normalizeForRejection(password);
  if (COMMON_PASSWORD_SET.has(normalized)) throw new PasswordPolicyError('common');

  const compactCandidate = compact(normalized);
  for (const term of contextTerms(context)) {
    if (normalized.includes(term) || compactCandidate.includes(compact(term))) {
      throw new PasswordPolicyError('context');
    }
  }
}

function contextTerms(context: PasswordPolicyContext): string[] {
  const raw = ['chickpea', context.organizationName, context.workspaceName];
  if (context.email) raw.push(context.email.split('@', 1)[0]);
  const terms = new Set<string>();
  for (const value of raw) {
    if (!value) continue;
    const normalized = normalizeForRejection(value);
    if (Array.from(compact(normalized)).length >= 4) terms.add(normalized);
    for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
      if (Array.from(word).length >= 4) terms.add(word);
    }
  }
  return [...terms];
}

function normalizeForRejection(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function compact(value: string): string {
  return value.replace(/[^\p{L}\p{N}]+/gu, '');
}
