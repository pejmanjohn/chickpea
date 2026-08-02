#!/usr/bin/env node
/**
 * Temporary migration gate: require every TypeScript diagnostic to be one of
 * the reviewed U3/U4/U5 file+code pairs. Line numbers and message wording are
 * intentionally ignored so ordinary edits do not churn the inventory.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');
const expectedPath = path.join(
  projectRoot,
  'scripts',
  'fixtures',
  'flue-v2-expected-type-errors.txt',
);

const result = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], {
  cwd: projectRoot,
  encoding: 'utf8',
});
if (result.error) throw result.error;

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const diagnosticPattern = /^(.+?)\(\d+,\d+\): error (TS\d+):/;
const diagnostics = output
  .split(/\r?\n/)
  .map((line) => diagnosticPattern.exec(line))
  .filter(Boolean)
  .map((match) => `${path.relative(projectRoot, path.resolve(projectRoot, match[1])).replaceAll('\\', '/')}:${match[2]}`);
const actual = [...new Set(diagnostics)].sort();
const expected = readFileSync(expectedPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))
  .sort();

const missing = expected.filter((entry) => !actual.includes(entry));
const unexpected = actual.filter((entry) => !expected.includes(entry));
const unparsedErrors = output
  .split(/\r?\n/)
  .filter((line) => line.includes(': error TS') && !diagnosticPattern.test(line));

if (missing.length > 0 || unexpected.length > 0 || unparsedErrors.length > 0) {
  if (missing.length > 0) console.error(`Missing reviewed diagnostics:\n${missing.join('\n')}`);
  if (unexpected.length > 0) console.error(`Unexpected diagnostics:\n${unexpected.join('\n')}`);
  if (unparsedErrors.length > 0) console.error(`Unparsed diagnostics:\n${unparsedErrors.join('\n')}`);
  process.exit(1);
}
if (result.status === 0 && expected.length > 0) {
  console.error('TypeScript unexpectedly passed while the staged inventory is non-empty.');
  process.exit(1);
}
if (result.status !== 0 && actual.length === 0) {
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

console.log(`Flue 2 staged type inventory matched ${actual.length} reviewed file/code pairs.`);
