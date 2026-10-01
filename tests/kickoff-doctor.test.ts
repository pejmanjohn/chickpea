import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { deployCommand, gatherKickoffFacts, kickoffReport, renderKickoff, telemetryReceiptFor } from '../scripts/lib/kickoff-doctor.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { adminSession, slackSession } from '../scripts/lib/lane-browser-probe.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { main, parseArguments } from '../scripts/verify-live-kickoff.mjs';
// @ts-expect-error Executable helpers are JavaScript, shared with the CLI.
import { schemaStep } from '../scripts/lib/environment-preflight.mjs';

const SCHEMA = 'd1:0002_mcp_oauth;do:v11';

function lane(overrides: object = {}) {
  return {
    target: 'amber', health: 'ready', profile: 'core', liveVersion: 'b56bcee6-1', servingVersion: 'b56bcee6-1',
    schemaGeneration: SCHEMA, schemaStep: 'same', readErrors: [], modelRoles: null, providerKeys: null, versionMatchesRegistry: true,
    missingActorAliases: [], setupFlowUnprovenSince: null, claim: null, telemetryReceipt: 'passed',
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
  assert.match(report.needs[0], /PID 42 .*no longer running; verify:host refuses it/);
  const alive = kickoffReport(facts({ hostReservation: { pid: 42, cwd: '/other', startedAt: 'then', alive: true } }));
  assert.equal(alive.host[2].level, 'info', 'a running reservation only means a deploy waits');
  assert.equal(alive.ok, true);
  const stale = kickoffReport(facts({ hostReservation: { pid: 42, cwd: '/other', startedAt: 'then', alive: false } }));
  assert.equal(stale.ok, false, 'a stale reservation stops the guarded deploy, so the run is not ready');
  assert.equal(kickoffReport(facts({ hostReservation: { pid: 1, cwd: '/x', startedAt: 'then', alive: 'unknown' } })).host[2].level, 'human');
  const unreadable = kickoffReport(facts({ lanes: [], lanesError: 'TARGET_NOT_REGISTERED' }));
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.host.at(-1).text, /Could not read the lane registry or capabilities: TARGET_NOT_REGISTERED/);
});

test('lane problems are sorted into blockers and things only a person can do', () => {
  const report = kickoffReport(facts({ lanes: [
    lane({ target: 'amber', claim: { ownWorktree: false, branch: 'other-task', expiresAt: 'later' } }),
    lane({ target: 'cobalt', schemaGeneration: 'd1:0002_mcp_oauth;do:v10', schemaStep: 'one_step', browser: { state: 'held', holderPid: 63707 } }),
    lane({ target: 'violet', browser: { state: 'running', admin: 'signed_out', slack: 'other_workspace' }, versionMatchesRegistry: false }),
  ] }));
  assert.equal(report.ok, false);
  assert.deepEqual(report.ready, []);
  const amber = report.lanes[0].checks.find((c: any) => c.level === 'block');
  assert.match(amber.text, /Held by another worktree on other-task/);
  assert.match(amber.fix, /never take it/);
  assert.equal(report.needs.length, 3, 'a schema advance needs no person');
  assert.ok(report.lanes[1].checks.some((c: any) => c.level === 'warn' && /Lane serves schema .*do:v10; the candidate needs .*do:v11/.test(c.text) && /schema-advance/.test(c.fix)));
  assert.match(report.needs.join('\n'), /cobalt: Lane browser profile is held by another session's Chrome \(PID 63707\)/);
  assert.match(report.needs.join('\n'), /violet: Admin is signed out/);
  assert.match(report.needs.join('\n'), /violet: Slack in chrome-violet is on a different workspace/);
  assert.match(renderKickoff(report), /No lane is ready/);
  assert.ok(report.lanes[2].checks.some((c: any) => c.level === 'warn' && /live version differs/.test(c.text)));
  const own = kickoffReport(facts({ lanes: [lane({ claim: { ownWorktree: true, branch: 'mine', expiresAt: 'later' } })] }));
  assert.equal(own.ok, true);
  const behind = kickoffReport(facts({ lanes: [lane({ schemaGeneration: 'd1:0002_mcp_oauth;do:v10', schemaStep: 'one_step' })] }));
  assert.equal(behind.ok, true, 'a lane one schema step behind is still ready; the verifier advances it');
  const ahead = kickoffReport(facts({ lanes: [lane({ schemaGeneration: 'd1:0002_mcp_oauth;do:v12', schemaStep: 'ahead' })] }));
  assert.equal(ahead.ok, false, 'the deploy refuses a lane on a newer schema');
  assert.match(ahead.lanes[0].checks.find((c: any) => c.level === 'block').text, /newer than the candidate's/);
  const far = kickoffReport(facts({ lanes: [lane({ schemaGeneration: 'd1:0002_mcp_oauth;do:v8', schemaStep: 'unreachable' })] }));
  assert.equal(far.ok, false, 'schema-advance records only one step');
  const stopped = kickoffReport(facts({ lanes: [lane({ browser: { state: 'stopped' } })] }));
  assert.match(stopped.lanes[0].checks.find((c: any) => c.level === 'block').fix, /npm run lane:browser -- start amber/);
  assert.equal(kickoffReport(facts({ lanes: [lane({ browser: null })] })).ok, true, '--no-browser leaves the lane ready');
  const unread = kickoffReport(facts({ lanes: [lane({ readErrors: ['WORKER_DEPLOYMENT_UNAVAILABLE'], profile: 'unknown', liveVersion: null })] }));
  assert.equal(unread.ok, false, 'a lane Wrangler cannot read would fail its deploy after the claim');
  assert.match(unread.lanes[0].checks.find((c: any) => c.level === 'block').fix, /wrangler whoami/);
  const failed = kickoffReport(facts({ lanes: [lane({ telemetryReceipt: 'failed' })] }));
  assert.equal(failed.ok, false);
  assert.equal(kickoffReport(facts({ lanes: [lane({ telemetryReceipt: null })] })).ok, true, 'a missing receipt is written by the deploy');
  const mixed = kickoffReport(facts({ lanes: [lane({ profile: 'mixed' })] }));
  assert.equal(deployCommand('amber', 'mixed'), null);
  assert.ok(mixed.lanes[0].checks.some((c: any) => c.level === 'warn' && /no deploy command applies/.test(c.text)));
  assert.ok(kickoffReport(facts({ lanes: [lane({ browser: { state: 'error', error: 'LaneBrowserError: no root' } })] })).lanes[0].checks
    .some((c: any) => c.level === 'warn' && /could not be checked: LaneBrowserError/.test(c.text)));
});

test('a telemetry receipt counts only when it covers the serving version, and the newest decides', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'kickoff-receipts-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, status: string, version: string, observedAt: string) =>
    writeFileSync(join(dir, name), JSON.stringify({ status, observedAt, versions: [{ version, traffic: 100 }] }));
  assert.equal(telemetryReceiptFor(dir, 'v1'), null);
  write('telemetry-v1-old.json', 'failed', 'v1', '2026-10-01T00:00:00Z');
  assert.equal(telemetryReceiptFor(dir, 'v1'), 'failed');
  // verify:telemetry --target names receipts by time only; the contents decide.
  write('telemetry-2026-10-01T01-00-00-000Z.json', 'passed', 'v1', '2026-10-01T01:00:00Z');
  assert.equal(telemetryReceiptFor(dir, 'v1'), 'passed');
  write('telemetry-v2-new.json', 'passed', 'v2', '2026-10-01T02:00:00Z');
  assert.equal(telemetryReceiptFor(dir, 'v3'), null);
  writeFileSync(join(dir, 'telemetry-broken.json'), '{');
  assert.equal(telemetryReceiptFor(dir, 'v1'), 'passed');
  assert.equal(telemetryReceiptFor(join(dir, 'missing'), 'v1'), null);
});

test('schema steps are judged the way the deploy and schema-advance judge them', () => {
  const history = { d1: ['0001', '0002'], durableObject: ['v1', 'v2', 'v3'] };
  assert.equal(schemaStep('d1:0002;do:v2', 'd1:0002;do:v2', history), 'same');
  assert.equal(schemaStep('d1:0002;do:v1', 'd1:0002;do:v2', history), 'one_step');
  assert.equal(schemaStep('d1:0001;do:v2', 'd1:0002;do:v3', history), 'one_step');
  assert.equal(schemaStep('d1:0002;do:v1', 'd1:0002;do:v3', history), 'unreachable');
  assert.equal(schemaStep('d1:0002;do:v3', 'd1:0002;do:v2', history), 'ahead');
  assert.equal(schemaStep('d1:0002;do:v9', 'd1:0002;do:v3', history), 'unreachable', 'a lane on a migration the candidate never had');
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
  writeFileSync(join(evidence, 'telemetry-v1-2026-10-01T00-00-00-000Z.json'), JSON.stringify({ status: 'passed', observedAt: '2026-10-01T00:00:00Z', versions: [{ version: 'v1' }] }));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const probed: string[] = [];
  const gathered = await gatherKickoffFacts({
    root, lanes: ['amber', 'cobalt'],
    readers: {
      nodeVersion: 'v24.20.0', lockfileDrift: () => [], hostReservation: null,
      source: { status: 'current', approvedTip: 'b'.repeat(40) }, localSchema: SCHEMA,
      capabilities: [
        { target: 'amber', health: 'ready', profile: 'core', liveVersion: 'v1', servingVersion: 'v1', schemaGeneration: SCHEMA, errors: [], secrets: { OPENAI_API_KEY: true, BROWSERBASE_API_KEY: false }, defaultChatModel: 'm', modelRoles: 'm / image unset / coding unset', versionMatchesRegistry: true, missingActorAliases: [] },
        { target: 'cobalt', health: 'ready', profile: 'sandbox', liveVersion: 'v2', servingVersion: 'v2', schemaGeneration: SCHEMA, errors: ['WRANGLER_UNAVAILABLE'], secrets: null, missingActorAliases: [] },
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
  assert.equal(gathered.lanes[0].telemetryReceipt, 'passed');
  assert.equal(gathered.lanes[1].telemetryReceipt, null);
  assert.deepEqual(gathered.lanes[0].providerKeys, ['OPENAI_API_KEY']);
  const report = kickoffReport(gathered);
  assert.deepEqual(report.ready, ['amber']);
  assert.ok(report.lanes[1].checks.some((c: any) => c.level === 'block' && /WRANGLER_UNAVAILABLE/.test(c.text)));
  // A browser probe that throws becomes a fact, and a registry that cannot be read ends gathering, not the report.
  const thrown = await gatherKickoffFacts({ root, lanes: ['amber'], readers: {
    nodeVersion: 'v24.20.0', lockfileDrift: () => [], hostReservation: null, source: { status: 'current', approvedTip: 'b'.repeat(40) }, localSchema: SCHEMA,
    capabilities: [{ target: 'amber', health: 'ready', profile: 'core', liveVersion: 'v1', servingVersion: 'v1', schemaGeneration: SCHEMA, errors: [], missingActorAliases: [] }],
    registry: { targets: { amber: { evidenceRoot: evidence } } },
    browser: async () => { throw new Error('no daemon root'); },
  } });
  assert.deepEqual(thrown.lanes[0].browser, { state: 'error', error: 'no daemon root' });
  const broken = await gatherKickoffFacts({ root, lanes: ['amber'], readers: {
    nodeVersion: 'v24.20.0', lockfileDrift: () => [], hostReservation: null, source: { status: 'current', approvedTip: 'b'.repeat(40) }, localSchema: SCHEMA,
    get capabilities() { throw Object.assign(new Error('missing'), { code: 'TARGET_NOT_REGISTERED' }); },
  } });
  assert.equal(broken.lanesError, 'TARGET_NOT_REGISTERED');
  assert.equal(kickoffReport(broken).ok, false);
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
