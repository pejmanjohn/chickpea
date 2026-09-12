/**
 * Slack id shapes, validated wherever an id arrives from outside this host:
 * a gateway response, a raw thread row, or a persisted receipt. Shared so the
 * file transport, the receipts, and the thread image inventory accept exactly
 * the same ids — a narrower copy in one of them would silently strand a file
 * the others resolved.
 *
 * Both patterns are anchored and flagless, so the shared instances carry no
 * match state between callers.
 */

/** A Slack file id: `F` then the uppercase alphanumeric body. */
export const SLACK_FILE_ID = /^F[A-Z0-9]{6,40}$/;

/** A Slack message timestamp: whole seconds, a dot, then the sub-second part. */
export const SLACK_TS = /^\d{1,20}\.\d{1,10}$/;
