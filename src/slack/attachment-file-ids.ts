export const MAX_SLACK_ATTACHMENTS = 4;

const SLACK_ATTACHMENT_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Every id at its 256-character maximum, joined by commas. */
const MAX_ENCODED_ATTACHMENT_FILE_IDS_CHARS = MAX_SLACK_ATTACHMENTS * 256 + MAX_SLACK_ATTACHMENTS - 1;

export function isSlackAttachmentFileId(value: string): boolean {
  return SLACK_ATTACHMENT_FILE_ID.test(value);
}

/** The comma-joined `attachmentFileIds` attribute: 1 to MAX_SLACK_ATTACHMENTS valid ids, else undefined. */
export function parseAttachmentFileIds(encoded: unknown): string[] | undefined {
  if (typeof encoded !== 'string' || encoded.length > MAX_ENCODED_ATTACHMENT_FILE_IDS_CHARS) return undefined;
  const fileIds = encoded.split(',');
  return fileIds.length <= MAX_SLACK_ATTACHMENTS && fileIds.every(isSlackAttachmentFileId) ? fileIds : undefined;
}
