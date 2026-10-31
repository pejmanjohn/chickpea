// Zip archives attached to the current Slack message: the listing the
// attachment analysis reads, the `file:N` handle the Agent reads entries by,
// and the advice for an archive or entry that cannot be read.

import { sniffFileKind } from '../files/magic.ts';
import { createByteBudget, openZip, type ZipProblem } from '../files/zip.ts';
import { formatBytes } from './message-text.ts';

/**
 * An archive on the current message, numbered by its attachment ordinal. It
 * names a file, never bytes: a read resolves it against the file IDs the host
 * recorded for the message.
 */
export type ArchiveHandle = `file:${number}`;

export const READ_ARCHIVE_FILE_TOOL_NAME = 'read_archive_file';
export const MAX_LISTED_ARCHIVE_ENTRIES = 200;
/** Long paths are cut for display; 200 such lines still fit one attachment's character limit. */
const MAX_LISTED_PATH_CHARACTERS = 255;

export function archiveHandle(ordinal: number): ArchiveHandle {
  return `file:${ordinal}`;
}

/** The attachment ordinal a handle names, or undefined for anything else. */
export function archiveHandleOrdinal(value: string): number | undefined {
  const match = /^file:([1-9][0-9]{0,2})$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/**
 * The archive's file list for the attachment analysis: path, kind by name, and
 * size for at most 200 files, then a count of the rest. Nothing is inflated.
 */
export function archiveListing(bytes: Uint8Array, handle: ArchiveHandle): string {
  const archive = openZip(bytes, { maxEntryBytes: 0, budget: createByteBudget(0) });
  const lines = [`Zip archive ${handle}: its file list, not file contents.`];
  if (archive.entries.length === 0) lines.push('It has no files.');
  else lines.push(`${archive.entries.length.toLocaleString('en-US')} ${archive.entries.length === 1 ? 'file' : 'files'}:`);
  for (const entry of archive.entries.slice(0, MAX_LISTED_ARCHIVE_ENTRIES)) {
    const characters = Array.from(entry.path);
    const path = characters.length > MAX_LISTED_PATH_CHARACTERS
      ? `${characters.slice(0, MAX_LISTED_PATH_CHARACTERS).join('')}…`
      : entry.path;
    lines.push(`- ${path} (${sniffFileKind(entry.path).kind}, ${formatBytes(entry.size)})`);
  }
  const unlisted = archive.entries.length - MAX_LISTED_ARCHIVE_ENTRIES;
  if (unlisted > 0) lines.push(`${unlisted.toLocaleString('en-US')} more files are not listed.`);
  if (archive.refused.length > 0) {
    lines.push(`${archive.refused.length.toLocaleString('en-US')} more entries were left out because they repeat a path, share data with another file, or have control characters in their names.`);
  }
  return lines.join('\n');
}

/** What the Agent can tell the person when an archive, or a file inside it, cannot be read. */
export function archiveProblemMessage(problem: ZipProblem): string {
  const rezip = 'Ask for the archive re-created with standard zip compression, or for the files attached directly.';
  switch (problem.code) {
    case 'encrypted':
      return 'This archive is password-protected. Ask for it again without a password, or for the files attached directly.';
    case 'not_a_zip':
    case 'zip64':
    case 'split':
    case 'damaged':
    case 'unsafe_path':
      return `This archive uses a zip format Chickpea cannot read. ${rezip}`;
    case 'too_many_entries':
      return `This archive has more than ${problem.limit.toLocaleString('en-US')} files. Ask for a smaller archive.`;
    case 'unsupported_method':
      return `This file uses zip compression method ${problem.method}, which Chickpea cannot read. ${rezip}`;
    case 'entry_too_large':
      return `This file unpacks to ${formatBytes(problem.size)}, over the ${formatBytes(problem.limit)} limit. Ask for it split or attached directly.`;
    case 'header_mismatch':
    case 'size_mismatch':
    case 'inflate_failed':
      return `This file is damaged inside the archive. ${rezip}`;
    case 'budget_exceeded':
      return 'This read is over the size limit for one call. Read one file per call.';
  }
}
