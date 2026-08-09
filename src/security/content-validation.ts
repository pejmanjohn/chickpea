const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CREDENTIAL_PATTERNS = [
  /\bxox[a-z]-[a-z0-9-]{20,}\b/i,
  /\bsk-ant-[a-z0-9_-]{20,}\b/i,
  /\bsk-proj-[a-z0-9_-]{20,}(?![a-z0-9_-])/i,
  /\b(?:ghp|github_pat)_[a-z0-9_]{20,}\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:CHICKPEA_(?:AUTH_SECRET|RECOVERY_TOKEN)|TAG_ADMIN_TOKEN|ADMIN_TOKEN|SLACK_(?:BOT|APP)_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN)\s*=\s*[^\s]{8,}/i,
  /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)\b["']?\s*(?:=|:)\s*["']?[a-z0-9/+=]{8,}/i,
] as const;

export function hasDisallowedControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER_PATTERN.test(value);
}

export function hasCredentialLikeContent(value: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value));
}
