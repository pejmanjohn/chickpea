// Turns uploaded files (SKILL.md, other markdown, .zip and .skill archives)
// into the same pick-and-add candidates GitHub import offers. Every input is
// flattened into one entry list with lazy reads, then one classification pass
// decides what each entry is. Nothing here runs scripts or keeps package files.

import {
  MAX_SKILL_DOCUMENT_BYTES,
  parseFrontmatter,
  readSkillDocument,
  SKIP_DIR_RE,
  SkillImportError,
} from './skill-import.ts';
import { inspectSkillPackage, type SkillPackageInspection } from './skill-package.ts';
import {
  type ByteBudget,
  createByteBudget,
  isZipJunkPath,
  openZip,
  type RefusedZipEntry,
  ZipArchiveError,
  type ZipProblem,
} from '../files/zip.ts';

export interface UploadedSkillFile { name: string; bytes: Uint8Array }

export interface UploadedSkillCandidate {
  name: string;
  description: string;
  instructions: string;
  /** Display location: "<file>" or "<archive>/<dir inside archive>". */
  path: string;
  hasScripts: boolean;
  inspection: SkillPackageInspection;
}

export interface SkillUploadIssue { path: string; code: string; message: string }

export interface SkillUploadResolution {
  skills: UploadedSkillCandidate[];
  /** Markdown files that were not skills, or skills that failed validation. */
  skipped: number;
  issues: SkillUploadIssue[];
}

export const MAX_UPLOAD_FILES = 50;
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_CANDIDATES = 100;
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024;

/** The whole upload is refused; per-file problems are issues instead. */
export class SkillUploadError extends Error {
  readonly code: 'too_many_files' | 'upload_too_large';
  constructor(code: SkillUploadError['code'], message: string) {
    super(message);
    this.name = 'SkillUploadError';
    this.code = code;
  }
}

interface UploadEntry {
  /** Display path: the file name, or "<archive>/<path inside archive>". */
  path: string;
  /** Path inside the archive; the file name for a loose file. */
  innerPath: string;
  /** The archive this entry came from; loose files have none. */
  archive?: string;
  /** Bounded by the document limit and the upload's markdown budget. */
  read(): Promise<Uint8Array>;
}

export async function resolveUploadedSkills(
  files: readonly UploadedSkillFile[],
): Promise<SkillUploadResolution> {
  if (files.length > MAX_UPLOAD_FILES) {
    throw new SkillUploadError('too_many_files', `Upload up to ${MAX_UPLOAD_FILES} files at a time.`);
  }
  if (files.reduce((total, file) => total + file.bytes.byteLength, 0) > MAX_UPLOAD_BYTES) {
    throw new SkillUploadError('upload_too_large', 'Upload up to 8 MB of files at a time.');
  }
  const issues: SkillUploadIssue[] = [];
  const markdownBudget = createByteBudget(MAX_MARKDOWN_BYTES);
  const entries = files.flatMap((file) => uploadEntries(file, markdownBudget, issues));
  const roots = new Set(entries.flatMap(({ archive, innerPath }) =>
    archive && isSkillDocument(innerPath) && !SKIP_DIR_RE.test(innerPath) ? [rootKey(archive, dirname(innerPath))] : []));
  const insideRoot = ({ archive, innerPath }: UploadEntry) => archive !== undefined &&
    ancestors(dirname(innerPath)).some((dir) => roots.has(rootKey(archive, dir)));

  const skills: UploadedSkillCandidate[] = [];
  let skipped = 0;
  const skip = (path: string, code: string, message: string) => {
    issues.push({ path, code, message });
    skipped += 1;
  };
  for (const entry of entries) {
    const isSkillFile = isSkillDocument(entry.innerPath);
    if (!isSkillFile && !(isMarkdown(entry.innerPath) && !insideRoot(entry))) {
      if (!entry.archive) issues.push({ path: entry.path, code: 'unsupported_file', message: UNSUPPORTED_FILE });
      continue;
    }
    if (entry.archive && SKIP_DIR_RE.test(entry.innerPath)) continue;
    const directory = isSkillFile ? dirname(entry.innerPath) : '';
    const path = isSkillFile && entry.archive ? [entry.archive, directory].filter(Boolean).join('/') : entry.path;
    if (skills.length >= MAX_UPLOAD_CANDIDATES) {
      if (!issues.some(({ code }) => code === 'too_many_skills')) {
        skip(path, 'too_many_skills', `Only the first ${MAX_UPLOAD_CANDIDATES} skills in an upload are listed.`);
      } else skipped += 1;
      continue;
    }
    let document: ReturnType<typeof readSkillDocument>;
    try {
      const markdown = new TextDecoder().decode(await entry.read());
      if (!isSkillFile && !hasSkillHeader(markdown)) {
        skip(path, 'not_a_skill', NOT_A_SKILL);
        continue;
      }
      document = readSkillDocument(markdown, isSkillFile ? basename(directory) || archiveStem(entry.archive ?? '') : '');
    } catch (error) {
      if (error instanceof SkillImportError) skip(path, error.code, error.message);
      else if (error instanceof ZipArchiveError) {
        const issue = zipIssue(error.problem);
        skip(path, issue.code, issue.message);
      } else throw error;
      continue;
    }
    if (skills.some((skill) => skill.name === document.name)) {
      skip(path, 'duplicate_name', `Another skill in this upload is already named ${document.name}.`);
      continue;
    }
    const packageEntries = isSkillFile && entry.archive
      ? entries.filter((other) => other.archive === entry.archive &&
          (!directory || other.innerPath.startsWith(`${directory}/`)))
      : [];
    const inspection = inspectSkillPackage(directory, packageEntries.map((other) => ({ path: other.innerPath, type: 'blob' })));
    inspection.warnings.push(...document.warnings);
    skills.push({
      name: document.name,
      description: document.description,
      instructions: document.instructions,
      path,
      hasScripts: inspection.scriptPaths.length > 0,
      inspection,
    });
  }
  return { skills, skipped, issues };
}

function hasSkillHeader(markdown: string): boolean {
  try {
    const front = parseFrontmatter(markdown);
    return Boolean(front.name?.trim() && front.description?.trim());
  } catch (error) {
    if (error instanceof SkillImportError) return false;
    throw error;
  }
}

const NOT_A_SKILL = 'Not a skill. To upload a markdown file as a skill, give it a YAML header with a name and a description.';
export const UNSUPPORTED_FILE = 'Not a skill file. Upload SKILL.md files, other markdown files, or .zip and .skill archives.';

export const NOT_A_ZIP_ARCHIVE = 'This file is not a readable zip archive.';
const TOO_MUCH_MARKDOWN = 'This upload unpacks to more than 16 MB of markdown. Upload fewer files at a time.';

function documentTooLarge(size: number): string {
  return `This file is ${kib(size)} KB. The limit is ${kib(MAX_SKILL_DOCUMENT_BYTES)} KB.`;
}

/** The skill doors' wording for each archive problem. */
function zipIssue(problem: ZipProblem): Omit<SkillUploadIssue, 'path'> {
  const invalid = (message: string) => ({ code: 'invalid_archive', message });
  switch (problem.code) {
    case 'not_a_zip': return invalid(NOT_A_ZIP_ARCHIVE);
    case 'zip64': return invalid('This archive uses Zip64, which upload does not support.');
    case 'split': return invalid('Split zip archives are not supported.');
    case 'damaged': return invalid('This zip archive is damaged.');
    case 'encrypted': return invalid('This archive is encrypted.');
    case 'too_many_entries': return invalid(`This archive has ${problem.entries} entries. The limit is ${problem.limit}.`);
    case 'unsafe_path': return invalid(`This archive has a path outside the archive: ${problem.path}.`);
    case 'unsupported_method': return invalid(`This file uses zip compression method ${problem.method}. Upload reads stored and deflated files.`);
    case 'header_mismatch': return invalid('This file does not match its zip header.');
    case 'size_mismatch': return invalid('This file does not match its declared size.');
    case 'inflate_failed': return invalid('This file could not be unpacked.');
    case 'entry_too_large': return { code: 'document_too_large', message: documentTooLarge(problem.size) };
    case 'budget_exceeded': return { code: 'too_much_markdown', message: TOO_MUCH_MARKDOWN };
  }
}

const REFUSED_ENTRY_MESSAGES: Record<RefusedZipEntry['code'], string> = {
  invalid_name: 'This file name has control characters, so it was left out.',
  duplicate_path: 'This archive lists this path more than once. Only the first copy was read.',
  overlapping_data: 'This file shares its bytes with another file in the archive, so it was left out.',
};

function uploadEntries(file: UploadedSkillFile, budget: ByteBudget, issues: SkillUploadIssue[]): UploadEntry[] {
  const name = basename(file.name.replace(/\\/g, '/'));
  if (!/\.(zip|skill)$/i.test(name)) {
    if (isZipJunkPath(name)) return [];
    return [{ path: name, innerPath: name, read: async () => {
      if (file.bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) {
        throw new SkillImportError('document_too_large', documentTooLarge(file.bytes.byteLength));
      }
      if (!budget.take(file.bytes.byteLength)) throw new SkillImportError('too_much_markdown', TOO_MUCH_MARKDOWN);
      return file.bytes;
    } }];
  }
  try {
    const archive = openZip(file.bytes, { maxEntryBytes: MAX_SKILL_DOCUMENT_BYTES, budget });
    for (const { path, code } of archive.refused) {
      issues.push({ path: `${name}/${path}`, code: 'invalid_archive', message: REFUSED_ENTRY_MESSAGES[code] });
    }
    return archive.entries
      .map((entry) => ({ path: `${name}/${entry.path}`, innerPath: entry.path, archive: name, read: entry.read }));
  } catch (error) {
    if (!(error instanceof ZipArchiveError)) throw error;
    issues.push({ path: name, ...zipIssue(error.problem) });
    return [];
  }
}

function isSkillDocument(path: string): boolean {
  return basename(path).toLowerCase() === 'skill.md';
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function rootKey(archive: string, directory: string): string {
  return `${archive}\u0000${directory}`;
}

/** The directory itself and every parent, ending at the archive root "". */
function ancestors(directory: string): string[] {
  const parts = directory ? directory.split('/') : [];
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('/')).concat('');
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function archiveStem(archive: string): string {
  return archive.replace(/\.(zip|skill)$/i, '');
}

function kib(bytes: number): string {
  return Math.ceil(bytes / 1024).toLocaleString('en-US');
}
