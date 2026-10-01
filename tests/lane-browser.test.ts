import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Executable helpers are JavaScript, shared with the launcher.
import { cookieMatchesHosts, decodeCookiePayload, encodeCookiePayload, headlessDefault, payloadDigest, resolveChromiumExecutable, resolveProfileRoot, SEED_MARKER_FILE, serverCommand } from '../scripts/lib/lane-browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'lane-browser.mjs');
const FIXTURE = path.join(ROOT, 'tests', 'lane-browser.fixture.mjs');
// Fake values that must never appear in any output, file, argv, or child environment.
const VALUES = { slack: 'FAKE-SLACK-SESSION-9f8e7d6c5b4a', admin: 'FAKE-ADMIN-SESSION-4c3b2a1908', session: 'FAKE-SESSION-ONLY-77aa' };
const POSIX = process.platform !== 'win32';

type Cookie = { name: string; value: string; domain: string; path?: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string };
type Plan = { profile: string; executable: string | null; headless: boolean; command: string; args: string[] };
type Marker = { schemaVersion: string; lane: string; payloadDigest: string; cookieCount: number; names: string[]; domains: string[]; skipped: { expired: number; sessionOnly: number } };

function scratch(context: TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'chickpea-lane-browser-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeChromium(dir: string): string {
  const wrapper = path.join(dir, 'fake-chromium');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function cookies(): Cookie[] {
  const expires = Math.floor(Date.now() / 1000) + 86400 * 30;
  return [
    { name: 'd', value: VALUES.slack, domain: '.slack.com', path: '/', expires, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'better-auth.session_token', value: VALUES.admin, domain: 'lane.example.workers.dev', path: '/', expires, httpOnly: true, secure: true },
    { name: 'x', value: VALUES.session, domain: '.slack.com', path: '/', httpOnly: true, secure: true },
  ];
}

function payloadFor(lane: string): string {
  return encodeCookiePayload({ lane, cookies: cookies(), exportedAt: '2026-09-25T00:00:00.000Z' }) as string;
}

// Lane daemons on the host listen on the fixed ports; tests never touch them.
const ISOLATED_PORTS = { CHICKPEA_LANE_CHROME_PORT_AMBER: '65431', CHICKPEA_LANE_CHROME_PORT_COBALT: '65432', CHICKPEA_LANE_CHROME_PORT_VIOLET: '65433' };

function run(args: string[], env: Record<string, string>) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...ISOLATED_PORTS, ...env },
  });
  assertNoValues(`${result.stdout}\n${result.stderr}`);
  return result;
}

function assertNoValues(text: string): void {
  for (const value of Object.values(VALUES)) assert.equal(text.includes(value), false, `a cookie value leaked: ${text}`);
}

function readJson<T>(file: string): T {
  const text = readFileSync(file, 'utf8');
  assertNoValues(file.endsWith('fake-cookies.json') ? '' : text);
  return JSON.parse(text) as T;
}

test('the profile root is opt-in, absolute, expands ~, and never sits inside the repository', (context) => {
  const dir = scratch(context);
  assert.throws(() => resolveProfileRoot({ env: {} }), /CHICKPEA_LANE_CHROME_ROOT is not set/);
  assert.throws(() => resolveProfileRoot({ env: { CHICKPEA_LANE_CHROME_ROOT: 'browsers' } }), /must be an absolute path/);
  assert.equal(resolveProfileRoot({ env: { CHICKPEA_LANE_CHROME_ROOT: '~/browsers' }, home: dir }), path.join(dir, 'browsers'));
  assert.equal(resolveProfileRoot({ root: path.join(dir, 'x'), env: { CHICKPEA_LANE_CHROME_ROOT: '/elsewhere' } }), path.join(dir, 'x'));
  assert.throws(() => resolveProfileRoot({ root: path.join(ROOT, 'tmp', 'browsers') }), /outside the repository/);
  assert.throws(() => resolveProfileRoot({ root: ROOT }), /outside the repository/);
});

test('Chromium resolution finds Playwright layouts, headless follows the display, and the server comes from node_modules or npx', (context) => {
  const dir = scratch(context);
  const browsers = path.join(dir, 'pw-browsers');
  for (const build of ['chromium-1100', 'chromium-1194']) {
    mkdirSync(path.join(browsers, build, 'chrome-linux'), { recursive: true });
    writeFileSync(path.join(browsers, build, 'chrome-linux', 'chrome'), '');
  }
  const newest = path.join(browsers, 'chromium-1194', 'chrome-linux', 'chrome');
  assert.equal(resolveChromiumExecutable({ env: { CHICKPEA_LANE_CHROME_EXECUTABLE: browsers }, platform: 'linux' }), newest);
  assert.equal(resolveChromiumExecutable({ executable: path.join(browsers, 'chromium-1100'), env: {}, platform: 'linux' }), path.join(browsers, 'chromium-1100', 'chrome-linux', 'chrome'));
  assert.throws(() => resolveChromiumExecutable({ env: { CHICKPEA_LANE_CHROME_EXECUTABLE: path.join(dir, 'missing') }, platform: 'linux' }), /No Chromium at/);
  assert.throws(() => resolveChromiumExecutable({ env: { CHICKPEA_LANE_CHROME_EXECUTABLE: dir }, platform: 'linux' }), /no Chromium binary/);
  assert.equal(resolveChromiumExecutable({ env: {}, platform: 'darwin' }), undefined);

  assert.equal(headlessDefault({ env: {}, platform: 'linux' }), true);
  assert.equal(headlessDefault({ env: { DISPLAY: ':1' }, platform: 'linux' }), false);
  assert.equal(headlessDefault({ env: { DISPLAY: ':1', CHICKPEA_LANE_CHROME_HEADLESS: '1' }, platform: 'linux' }), true);
  assert.equal(headlessDefault({ env: {}, platform: 'darwin' }), false);

  const entry = path.join(dir, 'entry.js');
  assert.deepEqual(serverCommand({ env: { CHICKPEA_LANE_CHROME_SERVER: entry }, repositoryRoot: dir, execPath: '/usr/bin/node' }), { command: '/usr/bin/node', args: [entry] });
  assert.deepEqual(serverCommand({ env: { CHICKPEA_LANE_CHROME_SERVER: 'chrome-devtools-mcp@latest' }, repositoryRoot: dir }), { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] });
  assert.deepEqual(serverCommand({ env: {}, repositoryRoot: dir }), { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.10.1'] });
  const local = path.join(dir, 'node_modules', 'chrome-devtools-mcp', 'build', 'src', 'bin');
  mkdirSync(local, { recursive: true });
  writeFileSync(path.join(local, 'chrome-devtools-mcp.js'), '');
  assert.deepEqual(serverCommand({ env: {}, repositoryRoot: dir, execPath: '/usr/bin/node' }), { command: '/usr/bin/node', args: [path.join(local, 'chrome-devtools-mcp.js')] });
});

test('cookie payloads round-trip; rejections name a position and field, never a value', () => {
  const text = payloadFor('amber');
  const decoded = decodeCookiePayload(`${text.slice(0, 20)}\n${text.slice(20)}`, { lane: 'amber' }) as { lane: string; exportedAt: string; cookies: Cookie[] };
  assert.equal(decoded.lane, 'amber');
  assert.equal(decoded.exportedAt, '2026-09-25T00:00:00.000Z');
  assert.deepEqual(decoded.cookies.map(({ name, domain, expires }) => [name, domain, expires === null]), [['d', '.slack.com', false], ['better-auth.session_token', 'lane.example.workers.dev', false], ['x', '.slack.com', true]]);
  assert.equal(decoded.cookies[0]!.value, VALUES.slack);
  assert.equal(payloadDigest(text), payloadDigest(`${text.slice(0, 5)} \n ${text.slice(5)}`));
  assert.throws(() => decodeCookiePayload(text, { lane: 'cobalt' }), /exported for the amber lane, not cobalt/);
  assert.throws(() => decodeCookiePayload('not base64 at all!!', { lane: 'amber' }), /not base64/);
  assert.throws(() => decodeCookiePayload(Buffer.from('{"schemaVersion":"other"}').toString('base64')), /needs schemaVersion "chickpea-lane-cookies\/v1"/);
  assert.throws(() => decodeCookiePayload(encodeCookiePayload({ lane: 'amber', cookies: [] })), /holds no cookies/);
  const bad = (cookie: Record<string, unknown>) => {
    try {
      decodeCookiePayload(encodeCookiePayload({ lane: 'amber', cookies: [cookies()[0], cookie] }), { lane: 'amber' });
    } catch (error) {
      const message = (error as Error).message;
      assertNoValues(message);
      assert.equal(message.includes('leak'), false);
      return message;
    }
    throw new Error('expected a rejection');
  };
  assert.match(bad({ name: 'd', value: 'leak;value', domain: '.slack.com' }), /cookie 2 has an invalid value/);
  assert.match(bad({ name: 'bad name', value: 'leak', domain: '.slack.com' }), /cookie 2 has an invalid name/);
  assert.match(bad({ name: 'd', value: 'leak', domain: 'not a host' }), /cookie 2 has an invalid domain/);
  assert.match(bad({ name: 'd', value: 'leak', domain: 'slack.com', expires: 'soon' }), /cookie 2 has an invalid expires/);
  assert.match(bad({ name: 'd', value: 'leak', domain: 'slack.com', sameSite: 'Sometimes' }), /cookie 2 has an invalid sameSite/);
  assert.equal(cookieMatchesHosts({ domain: '.edgeapi.slack.com' }, ['slack.com']), true);
  assert.equal(cookieMatchesHosts({ domain: 'notslack.com' }, ['slack.com']), false);
});

test('import seeds a fresh profile over the DevTools pipe and never logs, passes, or records a cookie value', (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const env = { CHICKPEA_LANE_CHROME_ROOT: root, CHICKPEA_LANE_CHROME_EXECUTABLE: fakeChromium(dir), CHICKPEA_LANE_COOKIES_AMBER: payloadFor('amber') };
  const first = run(['import', 'amber'], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stderr, /chrome-amber: seeded: 2 cookies for \.slack\.com, lane\.example\.workers\.dev \(better-auth\.session_token, d\); skipped 0 expired, 1 session-only; digest sha256:[0-9a-f]{64}/);
  const profile = path.join(root, 'amber');
  const stored = readJson<Cookie[]>(path.join(profile, 'fake-cookies.json'));
  assert.deepEqual(stored.map(({ name, value, domain, secure, httpOnly, sameSite }) => [name, value, domain, secure, httpOnly, sameSite ?? null]), [
    ['d', VALUES.slack, '.slack.com', true, true, 'Lax'],
    ['better-auth.session_token', VALUES.admin, 'lane.example.workers.dev', true, true, null],
  ]);
  const argv = readJson<string[]>(path.join(profile, 'fake-argv.json'));
  assert.deepEqual(argv.slice(0, 3), ['--remote-debugging-pipe', '--headless', `--user-data-dir=${profile}`]);
  assert.ok(argv.includes('--hide-crash-restore-bubble'));
  const childVariables = readJson<string[]>(path.join(profile, 'fake-env.json'));
  assert.ok(childVariables.includes('CHICKPEA_LANE_CHROME_ROOT'));
  assert.equal(childVariables.some((name) => name.startsWith('CHICKPEA_LANE_COOKIES_')), false, 'the browser must not inherit the payload');
  const marker = readJson<Marker>(path.join(profile, SEED_MARKER_FILE));
  assert.equal(marker.schemaVersion, 'chickpea-lane-seed/v1');
  assert.equal(marker.payloadDigest, payloadDigest(env.CHICKPEA_LANE_COOKIES_AMBER));
  assert.deepEqual([marker.cookieCount, marker.names, marker.domains, marker.skipped], [2, ['better-auth.session_token', 'd'], ['.slack.com', 'lane.example.workers.dev'], { expired: 0, sessionOnly: 1 }]);
  if (POSIX) {
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(statSync(profile).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(profile, SEED_MARKER_FILE)).mode & 0o777, 0o600);
  }

  rmSync(path.join(profile, 'fake-argv.json'));
  const again = run(['import', 'amber'], env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /already seeded/);
  assert.equal(existsSync(path.join(profile, 'fake-argv.json')), false, 'an unchanged payload must not relaunch the browser');
  const replaced = run(['import', 'amber', '--replace'], env);
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.match(replaced.stderr, /reseeded/);
  assert.ok(existsSync(path.join(profile, 'fake-argv.json')));

  const file = path.join(dir, 'cobalt.b64');
  writeFileSync(file, payloadFor('cobalt'));
  const fromFile = run(['import', 'cobalt', '--from-file', file], { ...env, CHICKPEA_LANE_COOKIES_AMBER: '' });
  assert.equal(fromFile.status, 0, fromFile.stderr);
  assert.ok(existsSync(path.join(root, 'cobalt', SEED_MARKER_FILE)));
  const none = run(['import', 'violet'], { CHICKPEA_LANE_CHROME_ROOT: root, CHICKPEA_LANE_CHROME_EXECUTABLE: env.CHICKPEA_LANE_CHROME_EXECUTABLE });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /set CHICKPEA_LANE_COOKIES_VIOLET or pass --from-file/);
});

test('serve seeds before printing its plan; a rejected payload, refused cookies, or a crash leaves no marker', (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const executable = fakeChromium(dir);
  const env = { CHICKPEA_LANE_CHROME_ROOT: root, CHICKPEA_LANE_CHROME_EXECUTABLE: executable, CHICKPEA_LANE_COOKIES_VIOLET: payloadFor('violet') };
  const dry = run(['serve', 'violet', '--dry-run'], env);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout) as Plan & { seed: string; marker: Marker; url: string; daemon: { state: string; launchArgs: string[] } };
  assert.equal(plan.seed, 'seeded');
  assert.deepEqual(plan.marker.names, ['better-auth.session_token', 'd']);
  assert.equal(plan.profile, path.join(root, 'violet'));
  assert.equal(plan.executable, executable);
  assert.equal(plan.daemon.state, 'stopped', 'a dry run launches nothing');
  assert.equal(plan.url, 'http://127.0.0.1:65433');
  assert.ok(plan.args.includes('--browserUrl'), 'serve attaches to the daemon');
  assert.equal(plan.args.includes('--userDataDir'), false, 'serve never launches Chromium through the server');
  assert.ok(plan.daemon.launchArgs.includes('--hide-crash-restore-bubble'));
  assert.ok(plan.daemon.launchArgs.includes(`--user-data-dir=${path.join(root, 'violet')}`));
  assert.equal((JSON.parse(run(['serve', 'violet', '--dry-run'], env).stdout) as { seed: string }).seed, 'already_seeded');
  assert.equal((JSON.parse(run(['serve', 'violet', '--dry-run', '--no-seed'], env).stdout) as { seed: string }).seed, 'skipped');

  const garbage = run(['serve', 'amber', '--dry-run'], { ...env, CHICKPEA_LANE_COOKIES_AMBER: 'garbage payload ###' });
  assert.equal(garbage.status, 1);
  assert.match(garbage.stderr, /Cookie payload rejected: it is not base64\./);
  assert.equal(garbage.stderr.includes('garbage'), false);
  assert.equal(existsSync(path.join(root, 'amber', SEED_MARKER_FILE)), false);

  const refused = run(['serve', 'amber', '--dry-run'], { ...env, CHICKPEA_LANE_COOKIES_AMBER: payloadFor('amber'), FAKE_CHROMIUM_REJECT_COOKIES: '1' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Storage\.setCookies failed: Invalid cookie fields/);
  assert.equal(existsSync(path.join(root, 'amber', SEED_MARKER_FILE)), false);

  const crashed = run(['import', 'amber'], { ...env, CHICKPEA_LANE_COOKIES_AMBER: payloadFor('amber'), FAKE_CHROMIUM_CRASH: '1' });
  assert.equal(crashed.status, 1);
  assert.match(crashed.stderr, /Chromium exited before answering\. fake chromium: crashed on purpose/);
  assert.equal(existsSync(path.join(root, 'amber', SEED_MARKER_FILE)), false);

  const optOut = run(['serve', 'amber', '--dry-run'], { CHICKPEA_LANE_CHROME_EXECUTABLE: executable });
  assert.equal(optOut.status, 1);
  assert.match(optOut.stderr, /CHICKPEA_LANE_CHROME_ROOT is not set\. Lane browsers are opt-in/);
  const usage = run(['serve', 'amber', '--bogus'], env);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Unknown argument "--bogus"/);
  assert.equal(run(['serve', 'teal', '--dry-run'], env).status, 1);
});

test('export writes an owner-only payload of the selected hosts, prints no value, and refuses to overwrite', (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const profile = path.join(root, 'cobalt');
  mkdirSync(profile, { recursive: true });
  const expires = Math.floor(Date.now() / 1000) + 3600;
  writeFileSync(path.join(profile, 'fake-cookies.json'), JSON.stringify([
    { name: 'd', value: VALUES.slack, domain: '.slack.com', path: '/', expires, secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'x', value: VALUES.session, domain: 'app.slack.com', path: '/', expires: -1, secure: true, httpOnly: true },
    { name: 'better-auth.session_token', value: VALUES.admin, domain: 'lane.example.workers.dev', path: '/', expires, secure: true, httpOnly: true },
    { name: 'NID', value: 'unrelated-google-value', domain: '.google.com', path: '/', expires, secure: true, httpOnly: true },
  ]));
  const env = { CHICKPEA_LANE_CHROME_ROOT: root, CHICKPEA_LANE_CHROME_EXECUTABLE: fakeChromium(dir) };
  const file = path.join(dir, 'cobalt.b64');
  const exported = run(['export', 'cobalt', '--to-file', file, '--host', 'Lane.example.workers.dev'], env);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stderr, /chrome-cobalt: exported 3 cookies \(2 persistent\) for \.slack\.com, app\.slack\.com, lane\.example\.workers\.dev \(better-auth\.session_token, d, x\)/);
  assert.match(exported.stderr, /CHICKPEA_LANE_COOKIES_COBALT/);
  assert.equal(exported.stdout, '');
  if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
  const payload = decodeCookiePayload(readFileSync(file, 'utf8'), { lane: 'cobalt' }) as { cookies: Cookie[] };
  assert.deepEqual(payload.cookies.map(({ name, value, domain, expires: at }) => [name, value, domain, at === null]), [
    ['d', VALUES.slack, '.slack.com', false],
    ['x', VALUES.session, 'app.slack.com', true],
    ['better-auth.session_token', VALUES.admin, 'lane.example.workers.dev', false],
  ]);
  const clash = run(['export', 'cobalt', '--to-file', file], env);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /exists; pass --replace/);
  assert.equal(run(['export', 'cobalt', '--to-file', file, '--replace'], env).status, 0);
  assert.equal(run(['export', 'cobalt'], env).status, 2);
  const empty = run(['export', 'amber', '--to-file', path.join(dir, 'amber.b64')], env);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /No amber profile at/);
});

// @ts-expect-error Executable helpers are JavaScript, shared with the launcher.
import { attachPlan, DAEMON_PORTS, daemonLaunchArguments, daemonPort, daemonRecordPath, daemonStatus, evidenceWorkspaces, startDaemon, stopDaemon } from '../scripts/lib/lane-browser.mjs';
import { createServer } from 'node:net';

const DAEMON_FIXTURE = path.join(ROOT, 'tests', 'lane-browser-daemon.fixture.mjs');

function fakeDaemonChromium(dir: string): string {
  const wrapper = path.join(dir, 'fake-daemon-chromium');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${DAEMON_FIXTURE}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

type DaemonStatus = { state: string; port: number; url: string; browser: string | null; record: { pid: number } | null; holder: { pid: number } | null };

test('the attach plan targets the lane daemon port and allows evidence roots outside the temp directory', () => {
  assert.deepEqual(DAEMON_PORTS, { amber: 9331, cobalt: 9332, violet: 9333 });
  assert.equal(daemonPort('cobalt', {}), 9332);
  assert.equal(daemonPort('cobalt', { CHICKPEA_LANE_CHROME_PORT_COBALT: '9444' }), 9444);
  assert.throws(() => daemonPort('cobalt', { CHICKPEA_LANE_CHROME_PORT_COBALT: '80' }), /between 1024 and 65535/);
  assert.throws(() => daemonPort('teal', {}), /Choose a lane/);
  const roots = evidenceWorkspaces({ root: '/private/home/qa/browsers', workspaces: ['/private/home/qa/runs'], platform: 'linux', temp: '/tmp' }) as string[];
  assert.deepEqual(roots, ['/private/home/qa/verification', '/private/home/qa/qa-runs', '/private/home/qa/reviews', '/tmp', '/private/home/qa/runs']);
  assert.equal(roots.includes('/private/home/qa'), false, 'the parent holds lane secrets and cookie payloads, so it is never a workspace');
  assert.ok((evidenceWorkspaces({ root: '/home/qa/.chickpea/browsers', platform: 'darwin', temp: '/var/folders/x' }) as string[]).includes('/private/tmp'));

  const plan = attachPlan({ lane: 'violet', root: '/private/home/qa/browsers', env: {}, platform: 'linux', repositoryRoot: '/nowhere', execPath: '/usr/bin/node' }) as { url: string; port: number; command: string; args: string[]; profile: string };
  assert.equal(plan.port, 9333);
  assert.equal(plan.url, 'http://127.0.0.1:9333');
  assert.equal(plan.profile, '/private/home/qa/browsers/violet');
  assert.equal(plan.command, 'npx');
  const joined = plan.args.join('\0');
  assert.ok(joined.includes(['--browserUrl', 'http://127.0.0.1:9333'].join('\0')));
  assert.ok(joined.includes(['--workspace', '/private/home/qa/verification'].join('\0')));
  for (const flag of ['--userDataDir', '--executablePath', '--headless', '--viewport']) assert.equal(plan.args.includes(flag), false, `${flag} belongs to a launch, not an attach`);
  assert.ok(plan.args.includes('--redactNetworkHeaders'));

  const launch = daemonLaunchArguments({ profile: '/p/amber', port: 9331, platform: 'darwin', uid: 501 }) as string[];
  assert.ok(launch.includes('--user-data-dir=/p/amber'));
  assert.ok(launch.includes('--remote-debugging-port=9331'));
  assert.ok(launch.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(launch.includes('--hide-crash-restore-bubble'));
  assert.equal(launch.includes('--use-mock-keychain'), false, 'macOS lane profiles use the keychain');
  assert.equal(launch.includes('--headless'), false, 'the daemon is a real window');
  assert.ok((daemonLaunchArguments({ profile: '/p/amber', port: 9331, platform: 'linux', uid: 0 }) as string[]).includes('--no-sandbox'));
  assert.ok((daemonLaunchArguments({ profile: '/p/amber', port: 9331, headless: true, platform: 'linux', uid: 0 }) as string[]).includes('--headless'));
});

test('start launches one daemon per lane, status reports it, a second start reuses it, and stop ends only that process', async (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const port = await freePort();
  const env = { CHICKPEA_LANE_CHROME_PORT_AMBER: String(port), CHICKPEA_LANE_CHROME_EXECUTABLE: fakeDaemonChromium(dir), CHICKPEA_LANE_COOKIES_AMBER: payloadFor('amber') };
  const stopped = await daemonStatus({ lane: 'amber', root, env }) as DaemonStatus;
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.port, port);

  const started = await startDaemon({ lane: 'amber', root, env, timeoutMs: 15_000 }) as { status: string; browser: string; record: { pid: number; port: number } };
  context.after(() => { try { process.kill(started.record.pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.equal(started.status, 'started');
  assert.equal(started.browser, 'FakeChrome/1.0');
  assert.equal(started.record.port, port);
  const record = readJson<{ schemaVersion: string; lane: string; pid: number }>(daemonRecordPath(root, 'amber') as string);
  assert.equal(record.schemaVersion, 'chickpea-lane-daemon/v1');
  assert.equal(record.pid, started.record.pid);
  assert.equal((statSync(path.join(root, 'amber')).mode & 0o077), 0, 'the profile stays owner-only');
  const argv = readJson<string[]>(path.join(root, 'amber', 'fake-daemon-argv.json'));
  assert.ok(argv.includes(`--remote-debugging-port=${port}`));
  assert.ok(argv.includes(`--user-data-dir=${path.join(root, 'amber')}`));
  const daemonEnv = readJson<string[]>(path.join(root, 'amber', 'fake-daemon-env.json'));
  assert.equal(daemonEnv.some((name) => name.startsWith('CHICKPEA_LANE_COOKIES_')), false, 'no cookie payload reaches the daemon');
  assert.equal(existsSync(path.join(root, 'amber.daemon.log')), true, 'the daemon writes an owner-only log');
  assert.equal((statSync(path.join(root, 'amber.daemon.log')).mode & 0o077), 0);

  const running = await daemonStatus({ lane: 'amber', root, env }) as DaemonStatus;
  assert.equal(running.state, 'running');
  assert.equal(running.browser, 'FakeChrome/1.0');
  assert.equal(running.record?.pid, started.record.pid);
  const again = await startDaemon({ lane: 'amber', root, env }) as { status: string };
  assert.equal(again.status, 'running', 'a second start attaches to the same daemon instead of launching another');

  const status = run(['status', 'all', '--root', root], env);
  assert.equal(status.status, 0, 'a completed report exits 0 even when lanes are stopped');
  assert.match(status.stdout, new RegExp(`chrome-amber: running: FakeChrome/1.0 on http://127.0.0.1:${port}`));
  assert.match(status.stdout, /chrome-cobalt: stopped/);
  const json = run(['status', 'amber', '--root', root, '--json'], env);
  assert.equal(json.status, 0);
  assert.equal((JSON.parse(json.stdout) as DaemonStatus).state, 'running');

  // Seeding, import and export refuse a profile the daemon has open; Chrome would hand off and exit.
  const importing = run(['import', 'amber', '--root', root], env);
  assert.equal(importing.status, 1);
  assert.match(importing.stderr, /The amber daemon is running .* Stop it first/);
  const exporting = run(['export', 'amber', '--root', root, '--to-file', path.join(dir, 'out.b64')], env);
  assert.equal(exporting.status, 1);
  assert.match(exporting.stderr, /Stop it first/);
  const serving = JSON.parse(run(['serve', 'amber', '--root', root, '--dry-run'], env).stdout) as { seed: string; daemon: { state: string } };
  assert.equal(serving.seed, 'profile_running', 'serve never seeds under a running daemon');
  assert.equal(serving.daemon.state, 'running');

  const ended = await stopDaemon({ lane: 'amber', root, env }) as { status: string; pid: number };
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.pid, started.record.pid);
  assert.equal(existsSync(daemonRecordPath(root, 'amber') as string), false, 'stop removes the record');
  const after = await daemonStatus({ lane: 'amber', root, env }) as DaemonStatus;
  assert.equal(after.state, 'stopped');
  await assert.rejects(stopDaemon({ lane: 'amber', root, env }), /No amber daemon record/);
});

test('start refuses a profile a per-session browser still holds, and stop never signals a process the record does not describe', async (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const port = await freePort();
  const env = { CHICKPEA_LANE_CHROME_PORT_COBALT: String(port), CHICKPEA_LANE_CHROME_EXECUTABLE: fakeDaemonChromium(dir), FAKE_DAEMON_SILENT: '1' };
  // A Chrome that holds the profile lock but answers on no port: the old launch-per-server mode.
  const profile = path.join(root, 'cobalt');
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  const holder = spawnSync('/bin/sh', ['-c', `"${env.CHICKPEA_LANE_CHROME_EXECUTABLE}" --user-data-dir=${profile} --remote-debugging-port=${port} >/dev/null 2>&1 & echo $!`], { encoding: 'utf8', env: { ...process.env, ...env } });
  const holderPid = Number(holder.stdout.trim());
  context.after(() => { try { process.kill(holderPid, 'SIGKILL'); } catch { /* already gone */ } });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const held = await daemonStatus({ lane: 'cobalt', root, env }) as DaemonStatus;
  assert.equal(held.state, 'held');
  assert.equal(held.holder?.pid, holderPid);
  await assert.rejects(startDaemon({ lane: 'cobalt', root, env, timeoutMs: 2_000 }), new RegExp(`held by pid ${holderPid}`));

  process.kill(holderPid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 300));
  // A lock left behind by a crash, now naming an unrelated live process (this test runner), holds nothing.
  rmSync(path.join(profile, 'SingletonLock'), { force: true });
  symlinkSync(`somehost-${process.pid}`, path.join(profile, 'SingletonLock'));
  assert.equal(((await daemonStatus({ lane: 'cobalt', root, env })) as DaemonStatus).state, 'stopped', 'a stale lock with a reused pid is not a holder');
  // A sibling profile such as cobalt-old never counts as cobalt.
  assert.equal(((await daemonStatus({ lane: 'cobalt', root: path.join(dir, 'other-root'), env })) as DaemonStatus).state, 'stopped');

  // A record naming a live process that is not the daemon (this test runner) is refused, not killed.
  writeFileSync(daemonRecordPath(root, 'cobalt') as string, JSON.stringify({ schemaVersion: 'chickpea-lane-daemon/v1', lane: 'cobalt', port, pid: process.pid }));
  await assert.rejects(stopDaemon({ lane: 'cobalt', root, env }), /is not the cobalt daemon/);
  // A record whose process is gone is cleared without a signal.
  writeFileSync(daemonRecordPath(root, 'cobalt') as string, JSON.stringify({ schemaVersion: 'chickpea-lane-daemon/v1', lane: 'cobalt', port, pid: 2 ** 22 - 1 }));
  assert.equal(((await stopDaemon({ lane: 'cobalt', root, env })) as { status: string }).status, 'not_running');
  assert.equal(existsSync(daemonRecordPath(root, 'cobalt') as string), false);

  // The CLI's attach plan is printable without a daemon, and points at the same port.
  const plan = run(['attach', 'cobalt', '--root', root, '--workspace', dir, '--dry-run'], env);
  assert.equal(plan.status, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout) as { url: string; args: string[] };
  assert.equal(parsed.url, `http://127.0.0.1:${port}`);
  assert.ok(parsed.args.includes(dir), 'an extra --workspace is passed through');
  assert.equal(run(['attach', 'cobalt', '--root', root, '--workspace', 'relative'], env).status, 2);
  assert.equal(run(['status', 'teal', '--root', root], env).status, 2);
});

test('a daemon Chrome that cannot be executed is reported, not thrown', async (context) => {
  const dir = scratch(context);
  const root = path.join(dir, 'browsers');
  const port = await freePort();
  const notExecutable = path.join(dir, 'chrome-without-exec-bit');
  writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(notExecutable, 0o644);
  const env = { CHICKPEA_LANE_CHROME_PORT_VIOLET: String(port), CHICKPEA_LANE_CHROME_EXECUTABLE: notExecutable };
  await assert.rejects(startDaemon({ lane: 'violet', root, env, timeoutMs: 5_000 }), /Chrome could not start from .*EACCES/);
  assert.equal(existsSync(daemonRecordPath(root, 'violet') as string), false, 'no record for a daemon that never ran');
});
