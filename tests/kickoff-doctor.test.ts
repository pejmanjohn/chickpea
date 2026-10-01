import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { deployCommand, gatherKickoffFacts, kickoffReport, renderKickoff } from '../scripts/lib/kickoff-doctor.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { adminSession, slackSession } from '../scripts/lib/lane-browser-probe.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { main, parseArguments } from '../scripts/verify-live-kickoff.mjs';

const SCHEMA = 'd1:0002_mcp_oauth;do:v11';

function lane(overrides: object = {}) {
  return {
    target: 'amber', health: 'ready', profile: 'core', liveVersion: 'b56bcee6-1', servingVersion: 'b56bcee6-1',
    schemaGeneration: SCHEMA, readErrors: [], modelRoles: null, providerKeys: null, versionMatchesRegistry: true,
    missingActorAliases: [], setupFlowUnprovenSince: null, claim: null, telemetryReceipt: true,
    browser: { state: 'running', admin: 'signed_in', slack: 'signed_in' }, ...overrides,
  };
}

function facts(overrides: object = {}) {
  return {
    generatedAt: '2026-10-01T00:00:00.000Z', worktree: '/work/tree',
    node: { version: 'v24.20.0', baseline: '24.20.0', supported: true },
    dependencies: { drift: [] }, hostReservation: null,
    source: { status: 'current', approvedTip: 'a'.repeat(40) }, localSchema: SCHEMA,
    lanes: [lane()], ...overrides,
  };
}

test('a clean host and a signed-in free lane are ready, with the right deploy command', () => {
  const report = kickoffReport(facts({ lanes: [lane(), lane({ target: 'cobalt', profile: 'sandbox' })] }));
  assert.equal(report.ok, true);
  assert.deepEqual(report.ready, ['amber', 'cobalt']);
  assert.deepEqual(report.needs, []);
  assert.equal(deployCommand('cobalt', 'sandbox'), 'CHICKPEA_DEPLOY_TARGET=cobalt npm run verify:host -- --wait-ms 300000 npm run deploy:sandbox');
  const text = renderKickoff(report);
  assert.match(text, /amber: ready/);
  assert.match(text, /deploy with: CHICKPEA_DEPLOY_TARGET=amber npm run verify:host -- --wait-ms 300000 npm run deploy\n/);
  assert.match(text, /Ready: amber, cobalt\. Next: npm run env -- wait-claim amber --timeout-ms 0 --poll-ms 1000 --worktree \/work\/tree/);
});

test('host problems block the run and say how to fix them', () => {
  const report = kickoffReport(facts({
    node: { version: 'v26.7.0', baseline: '24.20.0', supported: false },
    dependencies: { drift: [{ name: 'fast-uri', installed: '3.1.7', locked: '3.1.8' }] },
    source: { status: 'behind', code: 'QA_SOURCE_BEHIND_MAIN' },
    hostReservation: { pid: 42, cwd: '/other', startedAt: 'then', alive: false },
  }));
  assert.equal(report.ok, false);
  const levels = report.host.map((c: any) => c.level);
  assert.deepEqual(levels, ['block', 'block', 'human', 'block']);
  assert.match(report.host[1].fix, /npm ci --strict-allow-scripts/);
  assert.match(report.host[3].fix, /env -- restamp/);
  assert.match(report.needs[0], /PID 42 .*no longer running/);
  const alive = kickoffReport(facts({ hostReservation: { pid: 42, cwd: '/other', startedAt: 'then', alive: true } }));
  assert.equal(alive.host[2].level, 'info', 'a running reservation only means a deploy waits');
  assert.equal(alive.ok, true);
});

test('lane problems are sorted into blockers and things only a person can do', () => {
  const report = kickoffReport(facts({ lanes: [
    lane({ target: 'amber', claim: { ownWorktree: false, branch: 'other-task', expiresAt: 'later' } }),
    lane({ target: 'cobalt', schemaGeneration: 'd1:0002_mcp_oauth;do:v10', browser: { state: 'held', holderPid: 63707 } }),
    lane({ target: 'violet', browser: { state: 'running', admin: 'signed_out', slack: 'other_workspace' }, versionMatchesRegistry: false }),
  ] }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.ready, []);
  const amber = report.lanes[0].checks.find((c: any) => c.level === 'block');
  assert.match(amber.text, /Held by another worktree on other-task/);
  assert.match(amber.fix, /never take it/);
  assert.equal(report.needs.length, 4);
  assert.match(report.needs.join('\n'), /cobalt: Lane serves schema .*do:v10; the candidate needs .*do:v11/);
  assert.match(report.needs.join('\n'), /cobalt: Lane browser profile is held by another session's Chrome \(PID 63707\)/);
  assert.match(report.needs.join('\n'), /violet: Admin is signed out/);
  assert.match(report.needs.join('\n'), /violet: Slack in chrome-violet is on a different workspace/);
  assert.match(renderKickoff(report), /No lane is ready/);
  assert.ok(report.lanes[2].checks.some((c: any) => c.level === 'warn' && /live version differs/.test(c.text)));
  const own = kickoffReport(facts({ lanes: [lane({ claim: { ownWorktree: true, branch: 'mine', expiresAt: 'later' } })] }));
  assert.equal(own.ok, true);
  const stopped = kickoffReport(facts({ lanes: [lane({ browser: { state: 'stopped' } })] }));
  assert.match(stopped.lanes[0].checks.find((c: any) => c.level === 'block').fix, /npm run lane:browser -- start amber/);
  assert.equal(kickoffReport(facts({ lanes: [lane({ browser: null })] })).ok, true, '--no-browser leaves the lane ready');
});

test('sign-in classifiers read only the address and visible text', () => {
  assert.equal(adminSession({ url: 'https://x.workers.dev/admin', text: 'AGENTS\nNew Agent\nSettings' }), 'signed_in');
  assert.equal(adminSession({ url: 'https://x.workers.dev/admin/login', text: 'Sign in with Slack' }), 'signed_out');
  assert.equal(adminSession({ url: 'https://x.workers.dev/admin', text: 'Loading' }), 'unknown');
  assert.equal(slackSession({ url: 'https://app.slack.com/client/T0B123/C01', text: '' }, 'T0B123'), 'signed_in');
  assert.equal(slackSession({ url: 'https://app.slack.com/client/T999/C01', text: '' }, 'T0B123'), 'other_workspace');
  assert.equal(slackSession({ url: 'https://slack.com/signin', text: 'Sign in to Slack' }, 'T0B123'), 'signed_out');
  assert.equal(slackSession({ url: 'https://app.slack.com/', text: '' }, 'T0B123'), 'unknown');
});

test('facts come from injectable readers, and a claim is ours only for this checkout', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'kickoff-root-'));
  const evidence = join(root, 'evidence');
  mkdirSync(evidence);
  writeFileSync(join(evidence, 'telemetry-v1-2026-10-01T00-00-00-000Z.json'), '{}');
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const probed: string[] = [];
  const gathered = await gatherKickoffFacts({
    root, lanes: ['amber', 'cobalt'],
    readers: {
      nodeVersion: 'v24.20.0', lockfileDrift: () => [], hostReservation: null,
      source: { status: 'current', approvedTip: 'b'.repeat(40) }, localSchema: SCHEMA,
      capabilities: [
        { target: 'amber', health: 'ready', profile: 'core', liveVersion: 'v1', schemaGeneration: SCHEMA, errors: [], secrets: { OPENAI_API_KEY: true, BROWSERBASE_API_KEY: false }, defaultChatModel: 'm', modelRoles: 'm / image unset / coding unset', versionMatchesRegistry: true, missingActorAliases: [] },
        { target: 'cobalt', health: 'ready', profile: 'sandbox', liveVersion: 'v2', schemaGeneration: SCHEMA, errors: ['WRANGLER_UNAVAILABLE'], secrets: null, missingActorAliases: [] },
      ],
      registry: { targets: {
        amber: { servingVersion: 'v1', evidenceRoot: evidence, claim: { canonicalWorktreePath: root, branch: 'mine', expiresAt: 'later' } },
        cobalt: { servingVersion: 'v2', evidenceRoot: evidence, claim: { canonicalWorktreePath: '/elsewhere', branch: 'theirs', expiresAt: 'later' } },
      } },
      browser: async ({ lane: name }: { lane: string }) => { probed.push(name); return { state: 'running', admin: 'signed_in', slack: 'signed_in' }; },
    },
  });
  assert.deepEqual(probed, ['amber', 'cobalt']);
  assert.equal(gathered.lanes[0].claim.ownWorktree, true);
  assert.equal(gathered.lanes[1].claim.ownWorktree, false);
  assert.equal(gathered.lanes[0].telemetryReceipt, true);
  assert.equal(gathered.lanes[1].telemetryReceipt, false);
  assert.deepEqual(gathered.lanes[0].providerKeys, ['OPENAI_API_KEY']);
  const report = kickoffReport(gathered);
  assert.deepEqual(report.ready, ['amber']);
  assert.ok(report.lanes[1].checks.some((c: any) => /WRANGLER_UNAVAILABLE/.test(c.text)));
});

test('the CLI validates arguments, prints JSON on request and exits 1 when nothing is ready', async () => {
  assert.deepEqual(parseArguments(['--lane', 'violet', '--no-browser']).lanes, ['violet']);
  assert.throws(() => parseArguments(['--lane', 'teal']), /Choose a lane/);
  assert.throws(() => parseArguments(['--bogus']), /Unknown argument/);
  let out = '', err = '';
  const io = (value: object) => ({ stdout: { write: (v: string) => { out += v; } }, stderr: { write: (v: string) => { err += v; } }, gather: async () => value });
  assert.equal(await main(['--lane', 'teal'], io(facts())), 2);
  assert.match(err, /Usage: npm run verify:live:kickoff/);
  out = '';
  assert.equal(await main(['--json'], io(facts())), 0);
  assert.equal(JSON.parse(out).ready[0], 'amber');
  assert.equal(await main([], io(facts({ lanes: [lane({ health: 'unreachable' })] }))), 1);
});
