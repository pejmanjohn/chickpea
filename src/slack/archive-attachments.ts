import { sniffFileKind } from '../files/magic.ts';
import { createByteBudget, openZip, printableZipPath, type ZipProblem } from '../files/zip.ts';
import { formatBytes } from './message-text.ts';

export type ArchiveHandle = `file:${number}`;

export const READ_ARCHIVE_FILE_TOOL_NAME = 'read_archive_file';
export const MAX_LISTED_ARCHIVE_ENTRIES = 200;
/** Long paths are cut for display; 200 such lines still fit one attachment's character limit. */
const MAX_DISPLAYED_PATH_CHARACTERS = 255;
export const ARCHIVE_HANDLE_PATTERN = /^file:([1-9][0-9]{0,2})$/;

export function archiveHandle(ordinal: number): ArchiveHandle {
  return `file:${ordinal}`;
}

export function archiveHandleOrdinal(value: string): number | undefined {
  const match = ARCHIVE_HANDLE_PATTERN.exec(value);
  return match ? Number(match[1]) : undefined;
}

export type ArchiveFileIds = readonly string[] & { readonly __order: 'thread archives, then current message' };

export function archiveFileIds(
  threadArchiveFileIds: readonly string[],
  currentFileIds: readonly string[],
): ArchiveFileIds {
  const ordered = [...threadArchiveFileIds, ...currentFileIds.filter((fileId) => !threadArchiveFileIds.includes(fileId))];
  return ordered as readonly string[] as ArchiveFileIds;
}

/**
 * An entry path as models and people see it: unprintable characters replaced
 * and long paths cut. A read accepts this form as well as the exact path.
 */
export function displayPath(path: string): string {
  const characters = Array.from(printableZipPath(path));
  return characters.length > MAX_DISPLAYED_PATH_CHARACTERS
    ? `${characters.slice(0, MAX_DISPLAYED_PATH_CHARACTERS).join('')}…`
    : characters.join('');
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
    lines.push(`- ${displayPath(entry.path)} (${sniffFileKind(entry.path).kind}, ${formatBytes(entry.size)})`);
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
      return 'This file is over the size limit for one read. Ask for it attached directly.';
  }
}
