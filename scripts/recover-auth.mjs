#!/usr/bin/env node
/** Read-only operator preflight for the hidden Slack credential-repair route. */
import { pathToFileURL } from 'node:url';

import { decodeRecoverySecret } from '../src/auth/recovery-secret.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../src/config/types.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';

const USAGE = `Usage:
  CHICKPEA_RECOVERY_TOKEN=<32-byte value> npm run auth:recover -- \\
    --url https://your-chickpea.example [--state-db /path/to/tag-state.db]

This command is read-only. It validates the temporary deployment capability,
prints the hidden browser URL, and optionally confirms the unchanged app/team
from a local Node state database. Enter all repair secrets only in that HTTPS
page. The command cannot create a user, role, session, or replacement app.`;

export async function inspectSlackRecoveryReadiness(options) {
  decodeRecoverySecret(options.expectedRecoveryToken ?? '');
  const origin = exactOrigin(options.origin);
  let installation;
  if (options.stateDbPath) {
    const identity = new SqliteIdentityStore(options.stateDbPath);
    try {
      const [control, active] = await Promise.all([
        identity.getAuthControl(),
        identity.getActiveSlackCredentialRevision(WORKSPACE_DEFAULT_SLACK_IDENTITY_ID),
      ]);
      if (!active || active.purpose !== 'connected_credentials' || !active.teamId) {
        throw new Error('No connected workspace-default Slack installation is available to repair.');
      }
      installation = {
        appId: active.appId,
        teamId: active.teamId,
        credentialRevision: active.revision,
        healthGate: control?.healthGate ?? 'normal',
      };
    } finally { identity.close(); }
  }
  return {
    recoveryUrl: `${origin}/admin/recovery`,
    ...(installation ? { installation } : {}),
  };
}

function parseArgs(argv) {
  const parsed = { origin: undefined, stateDbPath: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') parsed.help = true;
    else if (argument === '--url' || argument === '--state-db') {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--url') parsed.origin = value;
      else parsed.stateDbPath = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function exactOrigin(value) {
  try {
    const url = new URL(value);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!loopback && url.protocol !== 'https:') || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error('--url must be an HTTPS origin (or loopback HTTP for a local dry run).'); }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!parsed.origin) throw new Error('--url is required.');
  const result = await inspectSlackRecoveryReadiness({
    origin: parsed.origin,
    stateDbPath: parsed.stateDbPath,
    expectedRecoveryToken: process.env.CHICKPEA_RECOVERY_TOKEN,
  });
  const lines = [
    'Slack credential recovery preflight passed.',
    `Open: ${result.recoveryUrl}`,
  ];
  if (result.installation) {
    lines.push(
      `Expected Slack app: ${result.installation.appId}`,
      `Expected Slack workspace: ${result.installation.teamId}`,
      `Deployment health gate: ${result.installation.healthGate}`,
    );
  }
  lines.push(
    'The browser session lasts 15 minutes and can repair credentials/URLs only.',
    'After success, an existing Owner must sign in normally with Slack.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
