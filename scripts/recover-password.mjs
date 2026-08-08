#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || value === undefined) usage();
  args.set(key.slice(2), value);
}

const origin = required('url').replace(/\/$/, '');
const email = required('email');
const recoveryToken = process.env.CHICKPEA_RECOVERY_TOKEN;
if (!recoveryToken) fail('Set CHICKPEA_RECOVERY_TOKEN in the command environment.');
if (args.get('password-stdin') !== '-') usage();
const newPassword = (await readFile(0, 'utf8')).replace(/[\r\n]+$/, '');
if (!newPassword) fail('No password was read from stdin.');

const body = new URLSearchParams({ ownerEmail: email, newPassword, recoveryToken }).toString();
const response = await fetch(`${origin}/admin/recovery`, {
  method: 'POST',
  headers: {
    origin,
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': String(Buffer.byteLength(body)),
    'sec-fetch-site': 'same-origin',
  },
  body,
  redirect: 'manual',
});
if (!response.ok) fail(`Recovery was denied (${response.status}). No credential was printed.`);
process.stdout.write('Owner password replaced. All prior browser sessions were revoked.\n');

function required(name) {
  const value = args.get(name);
  if (!value) usage();
  return value;
}

function usage() {
  fail(
    'Usage: printf %s "$NEW_PASSWORD" | CHICKPEA_RECOVERY_TOKEN=... ' +
    'node scripts/recover-password.mjs --url https://your-host --email owner@example.com --password-stdin -',
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
