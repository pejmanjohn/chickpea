import { basename } from 'node:path';

import { CliError } from './errors.ts';

/** The deployment's MCP request body cap, less room for the JSON-RPC envelope around the files. */
const MAX_CALL_FILE_BYTES = 1024 * 1024 - 16 * 1024;
/** upload_skills reads at most this many files in one call. */
const MAX_CALL_FILES = 50;

export type SkillUploadFile = { name: string; text: string } | { name: string; base64: string };

export function skillUploadFile(path: string, bytes: Uint8Array): SkillUploadFile {
  const name = basename(path);
  if (/\.(md|markdown)$/i.test(name)) return { name, text: new TextDecoder().decode(bytes) };
  if (/\.(zip|skill)$/i.test(name)) return { name, base64: Buffer.from(bytes).toString('base64') };
  throw new CliError('INVALID_ARGUMENT', `${name} is not a skill file`, 'Upload .md, .markdown, .zip or .skill files.');
}

/** Groups files in order so each upload_skills call stays under the deployment's request cap. */
export function skillUploadBatches(
  files: readonly SkillUploadFile[],
  adminUrl: string,
): SkillUploadFile[][] {
  const batches: SkillUploadFile[][] = [];
  let batchBytes = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (bytes > MAX_CALL_FILE_BYTES) {
      throw new CliError(
        'FILE_TOO_LARGE',
        `${file.name} is ${Math.ceil(bytes / 1024)} KB once encoded, over the ${Math.floor(MAX_CALL_FILE_BYTES / 1024)} KB one call carries`,
        `Upload it in Admin instead: open ${adminUrl}, then Skills, then Upload.`,
      );
    }
    const batch = batches.at(-1);
    if (batch && batch.length < MAX_CALL_FILES && batchBytes + bytes <= MAX_CALL_FILE_BYTES) {
      batch.push(file);
      batchBytes += bytes;
    } else {
      batches.push([file]);
      batchBytes = bytes;
    }
  }
  return batches;
}
