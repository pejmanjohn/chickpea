import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run, type CliDeps } from '../../src/cli.ts';
import { CredentialStore } from '../../src/store.ts';

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export function temporaryStore(): CredentialStore {
  return new CredentialStore(path.join(mkdtempSync(path.join(tmpdir(), 'chickpea-cli-')), 'chickpea'));
}

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<CliRun> {
  let stdout = '';
  let stderr = '';
  const code = await run(argv, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    openBrowser: async () => { throw new Error('openBrowser must be stubbed in tests'); },
    env: {},
    ...deps,
  });
  return { code, stdout, stderr };
}
