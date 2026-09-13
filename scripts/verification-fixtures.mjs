#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { outsideGit } from './lib/private-evidence.mjs';
import { fixtureReadiness } from './lib/verification-fixtures.mjs';

function readPrivateJson(file) {
  if (!isAbsolute(file)) throw new Error('Input paths must be absolute.');
  const initial = lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 8 * 1024 * 1024) throw new Error('Input must be a bounded private regular file.');
  const path = outsideGit(file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Input must be a bounded private regular file.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function runFixtureCli(argv, io = {}) {
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value) => process.stderr.write(value));
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      spec: { type: 'string' }, inventory: { type: 'string' }, operation: { type: 'string' },
      'reset-rights': { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
      'max-age-ms': { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) { stdout('Usage: verification-fixtures.mjs readiness --spec FILE --inventory FILE [--operation ID] [--reset-rights RIGHT] [--from RELEASE --to RELEASE] [--max-age-ms MS]\nRead-only advisory: this command creates no fixture reservation or authorization.\n'); return 0; }
    if (positionals.length !== 1 || positionals[0] !== 'readiness' || !values.spec || !values.inventory) throw new Error('Choose readiness and pass --spec and --inventory.');
    if ((values.from === undefined) !== (values.to === undefined)) throw new Error('Pass --from and --to together.');
    if (values['reset-rights'] && !['none', 'restore', 'dispose'].includes(values['reset-rights'])) throw new Error('Choose reset rights none, restore, or dispose.');
    for (const value of [values.operation, values.from, values.to].filter(Boolean)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('Operation and release selectors must be aliases.');
    }
    const maxAgeMs = values['max-age-ms'] === undefined ? undefined : Number(values['max-age-ms']);
    const result = fixtureReadiness(readPrivateJson(values.spec), readPrivateJson(values.inventory), {
      operation: values.operation, resetRights: values['reset-rights'], fromRelease: values.from,
      toRelease: values.to, maxAgeMs,
    });
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return result.cases.every(({ ready }) => ready) ? 0 : 1;
  } catch (error) {
    stderr(`Fixture readiness failed: ${error instanceof Error ? error.message : 'Invalid input.'}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runFixtureCli(process.argv.slice(2));
}
