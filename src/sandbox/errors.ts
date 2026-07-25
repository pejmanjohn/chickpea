import { FlueError } from '@flue/runtime';

/**
 * Public-safe infrastructure failure used at the Flue HTTP boundary.
 *
 * Cloudflare's raw container errors can contain control-plane details. Keep
 * those only as the server-side cause while giving the Slack relay a stable
 * category it can render without leaking the underlying message.
 */
export class SandboxUnavailableError extends FlueError {
  constructor(cause?: unknown) {
    super({
      type: 'sandbox_unavailable',
      message: 'The coding workspace is temporarily unavailable.',
      details: 'The workspace could not be started or reached for this turn.',
      dev: '',
      cause,
    });
    this.name = 'SandboxUnavailableError';
  }
}

/** Public-safe refusal when the operator-configured monthly cap is exhausted. */
export class SandboxSessionCapError extends FlueError {
  constructor() {
    super({
      type: 'sandbox_session_cap_reached',
      message: 'The coding workspace monthly session limit has been reached.',
      details: 'An administrator can review the coding sandbox limit in Settings.',
      dev: '',
    });
    this.name = 'SandboxSessionCapError';
  }
}
