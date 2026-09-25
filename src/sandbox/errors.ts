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

/**
 * What the model sees when the connection to the workspace's Sandbox Durable
 * Object dropped under an operation that is not safe to replay (a command, a
 * delete, a restore). Cloudflare can replace the Durable Object instance while
 * the container keeps running, so the workspace survives but the call's
 * outcome is unknown. The next call reconnects on a fresh stub.
 */
export const SANDBOX_CONNECTION_DROPPED_MESSAGE =
  'The connection to the coding workspace dropped before this operation finished. ' +
  'The workspace and its files are intact, but the outcome of this operation is unknown: ' +
  'it may or may not have completed. Check the current state first (for example git status, ' +
  'git log, the files it should have changed, or whether a long-running command left its output) ' +
  'and re-run it only if it did not complete. The next workspace call reconnects automatically.';

/**
 * The same drop while the workspace was being opened for this turn. Opening
 * fails closed: the half-prepared container is destroyed so a changed owner
 * can never inherit it, so its unsaved files may be gone.
 */
export const SANDBOX_CONNECTION_DROPPED_WHILE_OPENING_MESSAGE =
  'The connection to the coding workspace dropped while it was being opened, so the workspace was reset ' +
  'to keep it safe: files that were not pushed or checkpointed may be gone. Call it again to reopen it; ' +
  'the next workspace call reconnects automatically. Check what is there before relying on earlier work.';

export class SandboxConnectionDroppedError extends FlueError {
  constructor(cause?: unknown, phase: 'operation' | 'opening' = 'operation') {
    super({
      type: 'sandbox_connection_dropped',
      message: phase === 'opening'
        ? SANDBOX_CONNECTION_DROPPED_WHILE_OPENING_MESSAGE
        : SANDBOX_CONNECTION_DROPPED_MESSAGE,
      details: 'The workspace connection was re-established; the interrupted operation was not replayed.',
      dev: '',
      cause,
    });
    this.name = 'SandboxConnectionDroppedError';
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
