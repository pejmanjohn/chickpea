#!/usr/bin/env node
/**
 * Reset the Chickpea live-test environment for a clean fresh install.
 *
 * We do this reset every test cycle. The steps:
 *
 *   1. Ship the code the Deploy button installs from:
 *        git push origin main
 *      (The README's "Deploy to Cloudflare" button clones github.com/pejmanjohn/
 *       chickpea, so unpushed local commits will NOT be in a fresh install.)
 *
 *   2. Delete the previous test run's Cloudflare Worker (this script, with --yes).
 *      Each install creates a new worker (e.g. `chickpea-test-run`); pass its
 *      name with --worker. Deleting it (with force) also drops its Durable
 *      Object, which held the last test's Slack creds + config.
 *
 *   3. Delete the Slack app — MANUAL (no bot-token API for this):
 *        https://api.slack.com/apps -> the app in your test workspace (e.g.
 *        "Chickpea" in "Acme Inc") -> Basic Information -> Delete App -> confirm.
 *      Each fresh install's wizard creates a NEW app, so always delete the old.
 *
 *   4. Clear local dev state (this script, with --yes): removes tmp/ and
 *      .wrangler/. Add --wipe-creds to also remove the now-invalid
 *      .env.slack.* credential files.
 *
 *   5. Fresh install: click Deploy to Cloudflare, set TAG_ADMIN_TOKEN
 *      (openssl rand -hex 32), open /admin, sign in through the token form,
 *      and follow the wizard's Slack manifest deep-link to connect a fresh app.
 *
 * Usage:
 *   node scripts/reset-test-env.mjs                                  # dry run — print the plan
 *   node scripts/reset-test-env.mjs --worker chickpea-test-run --yes # delete worker + clear local state
 *   node scripts/reset-test-env.mjs --worker <name> --yes --wipe-creds
 *
 * Requires Node >= 22.19 and an authenticated wrangler (`wrangler whoami`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY_URL = 'https://deploy.workers.cloudflare.com/?url=https://github.com/pejmanjohn/chickpea';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const worker = value('--worker');
const apply = flag('--yes');
const wipeCreds = flag('--wipe-creds');

const localTargets = ['tmp', '.wrangler', ...(wipeCreds ? ['.env.slack.local', '.env.slack.rehearsal'] : [])];

console.log('\nChickpea test-env reset' + (apply ? '' : '  (dry run — pass --yes to execute)'));
console.log('─'.repeat(52));
console.log('1. Push code first (manual):  git push origin main');
console.log(`2. Cloudflare worker:         ${worker ? `delete "${worker}"` : '(pass --worker <name> to delete)'}`);
console.log('3. Slack app:                 delete at https://api.slack.com/apps  (MANUAL — no API)');
console.log(`4. Local dev state:           remove ${localTargets.join(', ')}`);
console.log(`5. Fresh install:             ${DEPLOY_URL}`);
console.log('─'.repeat(52));

if (!apply) {
  console.log('\nDry run only. Re-run with --yes to perform steps 2 and 4.');
  console.log('Steps 1, 3, 5 are always yours to run (push / Slack console / Deploy button).\n');
  process.exit(0);
}

// Step 2 — delete the Cloudflare worker (force also removes its Durable Object).
if (worker) {
  console.log(`\n→ Deleting Cloudflare worker "${worker}" …`);
  const res = spawnSync('node_modules/.bin/wrangler', ['delete', '--name', worker], {
    cwd: REPO_ROOT,
    input: 'y\ny\n',
    encoding: 'utf8',
  });
  process.stdout.write(res.stdout || '');
  process.stderr.write(res.stderr || '');
  if (res.status !== 0) {
    console.error('  wrangler delete failed — check `wrangler whoami` and the worker name.');
  }
} else {
  console.log('\n→ No --worker given; skipping the Cloudflare delete.');
}

// Step 4 — clear local dev state.
console.log('\n→ Clearing local state …');
for (const target of localTargets) {
  const path = join(REPO_ROOT, target);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`  removed ${target}`);
  } else {
    console.log(`  (already gone) ${target}`);
  }
}

console.log('\nDone. Remaining manual steps:');
console.log('  • Delete the Slack app (step 3) if you have not.');
console.log(`  • Fresh install: ${DEPLOY_URL}\n`);
