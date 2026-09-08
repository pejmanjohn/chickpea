import { createHash } from 'node:crypto';

/** Slack uses client_msg_id to return the original post for a retried write. */
export function slackClientMessageId(idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(`chickpea:slack-message:${idempotencyKey}`)
    .digest('hex');
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
