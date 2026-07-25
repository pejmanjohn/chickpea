#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLUE_VERSION = '1.0.0-beta.8';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flueRoot = path.join(projectRoot, 'node_modules', '@flue', 'runtime');
const fluePackagePath = path.join(flueRoot, 'package.json');
const flueRuntimeIndexPath = path.join(flueRoot, 'dist', 'index.mjs');
const flueRuntimeInternalPath = path.join(flueRoot, 'dist', 'internal.mjs');

const fluePackage = JSON.parse(await readFile(fluePackagePath, 'utf8'));
if (fluePackage.version !== FLUE_VERSION) {
  throw new Error(
    `[patch-flue-runtime] Expected @flue/runtime ${FLUE_VERSION}, found ${String(fluePackage.version)}. ` +
      'Review the upstream MCP validator before updating this patch.',
  );
}

const validatorReplacements = [
  {
    label: 'validator import',
    before: 'import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";',
    after:
      'import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";',
  },
  {
    label: 'SDK client validator',
    before: `\treturn connectMcpServerWithClient(name, new Client({
\t\tname: "flue",
\t\tversion
\t}), transport, {`,
    after: `\treturn connectMcpServerWithClient(name, new Client({
\t\tname: "flue",
\t\tversion
\t}, {
\t\tjsonSchemaValidator: new CfWorkerJsonSchemaValidator()
\t}), transport, {`,
  },
  {
    label: 'Flue tool validator',
    before: '\tconst validator = new AjvJsonSchemaValidator();',
    after: '\tconst validator = new CfWorkerJsonSchemaValidator();',
  },
];

const recoveryReplacements = [
  {
    label: 'Cloudflare recovery materialization context',
    before: '\t\t\t\t\tawait this.materializeSubmissionConversation(submission.input, agent);',
    after:
      '\t\t\t\t\tawait this.runWithInstanceContext(() => this.materializeSubmissionConversation(submission.input, agent));',
  },
];

const validatorChanged = await patchFile(flueRuntimeIndexPath, validatorReplacements);
const recoveryChanged = await patchFile(flueRuntimeInternalPath, recoveryReplacements);
const changed = validatorChanged || recoveryChanged;

if (changed) {
  console.log(`[patch-flue-runtime] Patched @flue/runtime ${FLUE_VERSION}.`);
} else {
  console.log(`[patch-flue-runtime] @flue/runtime ${FLUE_VERSION} is already patched.`);
}

async function patchFile(filePath, replacements) {
  let source = await readFile(filePath, 'utf8');
  let changed = false;

  for (const replacement of replacements) {
    const beforeCount = countOccurrences(source, replacement.before);
    const afterCount = countOccurrences(source, replacement.after);

    if (beforeCount === 1 && afterCount === 0) {
      source = source.replace(replacement.before, replacement.after);
      changed = true;
      continue;
    }

    if (beforeCount === 0 && afterCount === 1) {
      continue;
    }

    throw new Error(
      `[patch-flue-runtime] Unexpected ${replacement.label} shape in @flue/runtime ${FLUE_VERSION} ` +
        `(unpatched=${beforeCount}, patched=${afterCount}).`,
    );
  }

  if (changed) await writeFile(filePath, source);
  return changed;
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}
