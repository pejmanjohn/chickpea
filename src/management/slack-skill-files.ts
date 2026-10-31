import {
  MAX_UPLOAD_BYTES,
  UNSUPPORTED_FILE,
  type SkillUploadIssue,
  type UploadedSkillFile,
} from '../config/skill-upload.ts';
import { NOT_A_ZIP_ARCHIVE } from '../config/zip-reader.ts';
import type { GatewayAttachmentClient } from '../slack/gateway/client.ts';
import type { GatewayAttachmentRepresentation } from '../slack/gateway/protocol.ts';

/** Markdown arrives as its text and archives as their bytes; an image or PDF is never downloaded. */
const SKILL_FILE_ACCEPT: readonly GatewayAttachmentRepresentation[] = ['text_original', 'zip_original'];

type ReadIssue = Omit<SkillUploadIssue, 'path'>;

const UNREADABLE: ReadIssue = {
  code: 'attachment_unreadable',
  message: 'Chickpea could not read this file from Slack. Attach it again.',
};
const TOO_LARGE: ReadIssue = {
  code: 'upload_too_large',
  message: 'The files in one message can total up to 8 MB.',
};

/** How a read failure appears among the upload's left-out files; any other code is UNREADABLE. */
const READ_FAILURE_ISSUES: ReadonlyMap<string, ReadIssue> = new Map([
  ['unsupported_file_type', { code: 'unsupported_file', message: UNSUPPORTED_FILE }],
  // A .zip or .skill file that is not a zip: both readers check its bytes and download type.
  ['invalid_slack_file_magic', { code: 'invalid_archive', message: NOT_A_ZIP_ARCHIVE }],
  ['invalid_slack_file_type', { code: 'invalid_archive', message: NOT_A_ZIP_ARCHIVE }],
  ['attachment_byte_limit_exceeded', TOO_LARGE],
  ['attachment_too_large', TOO_LARGE],
  ['gateway_attachment_unsupported', {
    code: 'gateway_attachment_unsupported',
    message: 'This Slack connection cannot read skill files yet. Upload it on the Agent\'s Skills tab in Admin.',
  }],
]);

/**
 * Reads the files attached to the person's message one at a time, each bounded
 * by what is left of the upload's byte budget. A file that cannot be read
 * becomes an issue at "Attachment N"; Slack names only the files it returned.
 */
export async function readSlackSkillFiles(
  client: GatewayAttachmentClient,
  fileIds: readonly string[],
): Promise<{ files: UploadedSkillFile[]; issues: SkillUploadIssue[] }> {
  const files: UploadedSkillFile[] = [];
  const issues: SkillUploadIssue[] = [];
  let remaining = MAX_UPLOAD_BYTES;
  for (const [index, fileId] of fileIds.entries()) {
    const path = `Attachment ${index + 1}`;
    if (remaining < 1) {
      issues.push({ path, ...TOO_LARGE });
      continue;
    }
    try {
      const read = await client.readAttachment(fileId, remaining, undefined, SKILL_FILE_ACCEPT);
      files.push({ name: read.filename, bytes: read.bytes });
      remaining -= read.bytes.byteLength;
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      issues.push({ path, ...(typeof code === 'string' && READ_FAILURE_ISSUES.get(code) || UNREADABLE) });
    }
  }
  return { files, issues };
}
