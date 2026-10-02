import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { loadOrCreateNodeCredentialKeyring } from '../../src/slack/credential-keyring.ts';
import type { CredentialKeyring } from '../../src/slack/secret-envelope.ts';

/**
 * The deployment's credential keyring for one test: a fresh Node keyring file
 * that `loadCredentialKeyring` finds, as a deployment's readers and writers
 * would, removed with the test.
 */
export function useDeploymentKeyring(t: TestContext): CredentialKeyring {
  const dir = mkdtempSync(join(tmpdir(), 'chickpea-deployment-keyring-'));
  const path = join(dir, 'keyring.json');
  const previous = process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
  process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH;
    else process.env.CHICKPEA_CREDENTIAL_KEYRING_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return loadOrCreateNodeCredentialKeyring({ path });
}
