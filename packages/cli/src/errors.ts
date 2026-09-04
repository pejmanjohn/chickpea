/**
 * One error shape for the whole CLI: a stable code, a human message, and a
 * resolution hint. Messages that originate elsewhere (the MCP SDK, fetch)
 * pass through `redactSensitive` before they reach a terminal.
 */
export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
  }
}

export interface ErrorRecord {
  code: string;
  message: string;
  hint?: string;
}

/**
 * Strip anything that could be a credential from free-form text: bearer
 * values, authorization codes, setup capabilities, and long opaque strings.
 * The CLI never prints a token on purpose; this covers the accidental path.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/#setup=[^\s"']+/g, '#setup=[redacted]')
    .replace(/([?&#](?:code|token|access_token|refresh_token|id_token|state|code_verifier)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/(?:xox[a-z]-|sk-|gh[opusr]_)[^\s"']+/gi, '[credential]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
}

export function describeError(error: unknown): ErrorRecord {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: redactSensitive(error.message),
      ...(error.hint ? { hint: error.hint } : {}),
    };
  }
  const name = error instanceof Error ? error.name : '';
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactSensitive(raw).slice(0, 400) || 'Unknown error';
  if (name === 'UnauthorizedError') {
    return {
      code: 'SESSION_EXPIRED',
      message,
      hint: 'Sign in again with: chickpea login <deployment-url>',
    };
  }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { code: 'TIMEOUT', message, hint: 'Check that the deployment URL is reachable and retry.' };
  }
  if (error instanceof TypeError && /fetch/i.test(message)) {
    return {
      code: 'NETWORK',
      message,
      hint: 'Check the deployment URL, DNS, and TLS. Only HTTPS origins and loopback HTTP are supported.',
    };
  }
  return { code: 'UNEXPECTED', message, hint: 'Rerun with --json for the full error record.' };
}

export function formatErrorLine(record: ErrorRecord): string {
  const hint = record.hint ? ` ${record.hint.endsWith('.') ? record.hint : `${record.hint}.`}` : '';
  const message = record.message.endsWith('.') ? record.message : `${record.message}.`;
  return `chickpea: ${record.code}: ${message}${hint}`;
}
