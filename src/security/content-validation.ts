const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
/**
 * One table behind three consumers: the detector, the redactor, and the plain
 * text markers the Slack streaming path holds back until a token boundary
 * proves terminal redaction can no longer rewrite the tail.
 *
 * Flags are per signature on purpose: the AWS access-key-id shape is
 * case-sensitive today, and widening it to `i` would change what counts as a
 * credential.
 */
const CREDENTIAL_SIGNATURES: readonly {
  source: string;
  flags: string;
  markers: readonly string[];
}[] = [
  { source: String.raw`\bxox[a-z]-[a-z0-9-]{20,}\b`, flags: 'i', markers: ['xox'] },
  { source: String.raw`\bsk-ant-[a-z0-9_-]{20,}\b`, flags: 'i', markers: ['sk-ant-'] },
  {
    source: String.raw`\bsk-proj-[a-z0-9_-]{20,}(?![a-z0-9_-])`,
    flags: 'i',
    markers: ['sk-proj-'],
  },
  {
    source: String.raw`\b(?:ghp|github_pat)_[a-z0-9_]{20,}\b`,
    flags: 'i',
    markers: ['ghp_', 'github_pat_'],
  },
  { source: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, flags: '', markers: ['AKIA', 'ASIA'] },
  {
    source: String.raw`-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----`,
    flags: 'i',
    markers: ['-----BEGIN '],
  },
  {
    source: String.raw`\b(?:CHICKPEA_(?:AUTH_SECRET|RECOVERY_TOKEN|CREDENTIAL_KEY_[A-Z0-9_]+)|TAG_ADMIN_TOKEN|ADMIN_TOKEN|SLACK_(?:BOT|APP)_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\s*=\s*[^\s]{8,}`,
    flags: 'i',
    markers: [
      'CHICKPEA_AUTH_SECRET',
      'CHICKPEA_RECOVERY_TOKEN',
      'CHICKPEA_CREDENTIAL_KEY_',
      'TAG_ADMIN_TOKEN',
      'ADMIN_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
    ],
  },
  {
    source: String.raw`\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b["']?\s*(?:=|:)\s*["']?[a-z0-9/+=]{8,}`,
    flags: 'i',
    markers: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
  },
];

const CREDENTIAL_PATTERNS = CREDENTIAL_SIGNATURES.map(
  (signature) => new RegExp(signature.source, signature.flags),
);
const CREDENTIAL_REDACTIONS = CREDENTIAL_SIGNATURES.map(
  (signature) => new RegExp(signature.source, `${signature.flags}g`),
);
const CREDENTIAL_MARKERS: readonly string[] = CREDENTIAL_SIGNATURES.flatMap(
  (signature) => signature.markers,
);

export function hasDisallowedControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

export function hasCredentialLikeContent(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}

export function redactCredentialLikeContent(text: string): string {
  return CREDENTIAL_REDACTIONS.reduce(
    (value, pattern) => value.replace(pattern, '[credential redacted]'),
    text,
  );
}

/** Literal prefixes of the signatures above, for streaming tail suppression. */
export function credentialMarkers(): readonly string[] {
  return CREDENTIAL_MARKERS;
}
