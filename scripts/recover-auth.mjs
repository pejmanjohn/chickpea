#!/usr/bin/env node
/**
 * Offline token-mode bootstrap and recovery.
 *
 * This command opens the deployment's Node SQLite state directly. It never
 * calls a Chickpea HTTP route and never turns CHICKPEA_RECOVERY_TOKEN into a
 * browser credential. Cloudflare Access installations use /admin/recovery
 * after repairing the edge policy; this command is only for explicit token
 * mode on Node or another operator-controlled SQLite deployment.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { PersonalTokenService } from '../src/auth/personal-token.ts';
import { constantCredentialEquals, validRecoveryToken } from '../src/auth/setup.ts';
import { SqliteIdentityStore } from '../src/identity/store.ts';
import { resolveStateDbPath } from '../src/state/node-state-db.ts';

const USAGE = `Usage:
  npm run auth:recover -- --state-db <path> --owner-email <email> --yes
  npm run auth:recover -- --bootstrap-token-mode --state-db <path> \\
    --owner-email <email> --origin <https://admin-origin> --yes

The configured CHICKPEA_RECOVERY_TOKEN is read from the environment. Supply
the same value on standard input when prompted or pipe one line into the
command. The replacement personal token is printed once after old tokens and
their browser sessions are revoked.`;

export async function recoverTokenMode(options) {
  const expected = validRecoveryToken(options.expectedRecoveryToken);
  if (!constantCredentialEquals(options.recoveryProof, expected)) {
    throw new Error('Recovery proof was not accepted.');
  }
  if (!options.apply) {
    return { changed: false, message: 'Dry run only; pass --yes to rotate authentication.' };
  }

  const identity = new SqliteIdentityStore(options.stateDbPath);
  try {
    let organization = await identity.getOrganization();
    if (!organization) {
      if (!options.bootstrapTokenMode) {
        throw new Error('No Chickpea identity organization exists. Use --bootstrap-token-mode explicitly.');
      }
      if (!options.ownerEmail || !options.origin) {
        throw new Error('Token-mode bootstrap requires --owner-email and --origin.');
      }
      organization = await identity.ensureOrganization({ displayName: 'Chickpea' });
      await identity.createOwnerClaim({ organizationId: organization.id, email: options.ownerEmail });
      await identity.claimOwner({
        organizationId: organization.id,
        provider: 'operator_token',
        issuer: 'urn:chickpea:operator',
        subject: `owner_${randomUUID()}`,
        verifiedEmail: options.ownerEmail,
      });
      organization = await identity.updateOrganizationAuth({
        organizationId: organization.id,
        authMode: 'token_active',
        canonicalAdminOrigin: options.origin,
      });
    }
    if (organization.authMode !== 'token_active') {
      throw new Error(
        `Authentication mode is ${organization.authMode}; this command only changes token_active installations.`,
      );
    }

    const owners = [];
    for (const membership of await identity.listMemberships()) {
      if (membership.role !== 'owner' || membership.status !== 'active') continue;
      const user = await identity.getUser(membership.userId);
      if (user) owners.push({ membership, user });
    }
    const normalizedEmail = options.ownerEmail?.trim().toLowerCase();
    const selected = normalizedEmail
      ? owners.find(({ user }) => user.primaryEmail === normalizedEmail)
      : owners.length === 1 ? owners[0] : undefined;
    if (!selected) {
      throw new Error(
        owners.length > 1
          ? 'Multiple active owners exist; select one with --owner-email.'
          : 'The requested active owner was not found.',
      );
    }

    const prior = (await identity.exportSummary()).personalTokens.filter(
      (token) => token.userId === selected.user.id && token.status === 'active',
    );
    const created = await new PersonalTokenService(identity).create(
      selected.user.id,
      `Operator recovery ${new Date().toISOString().slice(0, 10)}`,
    );
    for (const token of prior) await identity.revokePersonalToken(token.id);
    return {
      changed: true,
      ownerEmail: selected.user.primaryEmail,
      revokedTokens: prior.length,
      token: created.token,
    };
  } finally {
    identity.close();
  }
}

async function readRecoveryProof() {
  if (process.stdin.isTTY) {
    process.stderr.write('Recovery token (input is visible): ');
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseArgs(argv) {
  const options = {
    apply: false,
    bootstrapTokenMode: false,
    stateDbPath: resolveStateDbPath(),
    ownerEmail: undefined,
    origin: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--yes') options.apply = true;
    else if (argument === '--bootstrap-token-mode') options.bootstrapTokenMode = true;
    else if (['--state-db', '--owner-email', '--origin'].includes(argument)) {
      const value = argv[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      if (argument === '--state-db') options.stateDbPath = value;
      if (argument === '--owner-email') options.ownerEmail = value;
      if (argument === '--origin') options.origin = value;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const expectedRecoveryToken = process.env.CHICKPEA_RECOVERY_TOKEN ?? '';
  const recoveryProof = await readRecoveryProof();
  const result = await recoverTokenMode({
    ...parsed,
    expectedRecoveryToken,
    recoveryProof,
  });
  if (!result.changed) {
    process.stdout.write(`${result.message}\n`);
    return;
  }
  process.stdout.write(
    [
      'Chickpea token-mode authentication recovered.',
      `Owner: ${result.ownerEmail}`,
      `Prior personal tokens revoked: ${result.revokedTokens}`,
      '',
      'Copy this personal token now. It will not be shown again:',
      result.token,
      '',
    ].join('\n'),
  );
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
