import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// @ts-expect-error The cross-platform executable .mjs intentionally has no declaration file.
import * as localWorkerLaneModule from '../scripts/lib/local-worker-lane.mjs';

const {
  DEFAULT_LOCAL_WORKER_MODEL,
  LOCAL_WORKER_RUNTIME,
  LOCAL_WORKER_TRANSPORT,
  bindLocalLaneSlack,
  createLocalTimingObserver,
  createLocalLaneManifest,
  initializeLocalLane,
  localWorkerViteSettings,
  readLocalLaneManifest,
  relocateUnboundLocalLane,
  renewLocalLaneSetup,
  resolveLocalLanePaths,
  validateLocalPublicUrl,
} = localWorkerLaneModule;

test('local Worker lane records an explicit workerd, HTTP Events, state, and model tuple', () => {
  const root = path.join(tmpdir(), 'chickpea-local-lane-test');
  const manifest = createLocalLaneManifest({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.chickpea.co/',
    tunnelName: 'chickpea-local-a',
    port: 8787,
    createdAt: '2026-09-04T00:00:00.000Z',
  });
  assert.equal(manifest.runtime, LOCAL_WORKER_RUNTIME);
  assert.equal(manifest.transport, LOCAL_WORKER_TRANSPORT);
  assert.equal(manifest.publicUrl, 'https://local-a.chickpea.co');
  assert.equal(manifest.statePath, path.join(root, '.chickpea-local-worker', 'local-a', 'state'));
  assert.match(manifest.d1DatabaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(manifest.model, DEFAULT_LOCAL_WORKER_MODEL);
  assert.equal(manifest.slack, null);
});

test('local Worker init creates private reusable state without exposing setup material in the manifest', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-init-'));
  const initialized = await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  const paths = resolveLocalLanePaths(root, 'local-a');
  assert.equal(initialized.created, true);
  assert.doesNotMatch(readFileSync(paths.manifest, 'utf8'), /CHICKPEA_AUTH_SECRET|setup=/);
  assert.match(readFileSync(paths.devVars, 'utf8'), /^CHICKPEA_AUTH_SECRET=[A-Za-z0-9_-]{43}$/m);
  assert.match(readFileSync(paths.setupLink, 'utf8'), /#setup=[A-Za-z0-9_-]{43}/);
  const repeated = await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  assert.equal(repeated.created, false);
  assert.equal(readFileSync(paths.setupLink, 'utf8'), readFileSync(repeated.paths.setupLink, 'utf8'));

  const oldSetupLink = readFileSync(paths.setupLink, 'utf8');
  const oldAuthSecret = readFileSync(paths.devVars, 'utf8').match(/^CHICKPEA_AUTH_SECRET=(.+)$/m)?.[1];
  await renewLocalLaneSetup(root, 'local-a');
  assert.notEqual(readFileSync(paths.setupLink, 'utf8'), oldSetupLink);
  assert.equal(readFileSync(paths.devVars, 'utf8').match(/^CHICKPEA_AUTH_SECRET=(.+)$/m)?.[1], oldAuthSecret);
});

test('local Worker init repairs only a dangling legacy lane link', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-link-'));
  symlinkSync(path.join('.wrangler-state', 'local', 'local-a', 'dev.vars'), path.join(root, '.dev.vars'));
  await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  assert.equal(
    readlinkSync(path.join(root, '.dev.vars')),
    path.join('.chickpea-local-worker', 'local-a', 'dev.vars'),
  );
});

test('Slack binding requires immutable workspace and app IDs and remains lane-local', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-bind-'));
  await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  const bound = bindLocalLaneSlack(root, 'local-a', {
    workspaceId: 'T0LOCAL123',
    workspaceLabel: 'Chickpea Local A',
    appId: 'A0LOCAL123',
    appLabel: 'Chickpea',
  });
  assert.deepEqual(readLocalLaneManifest(root, 'local-a').slack, bound.slack);
  assert.throws(() => bindLocalLaneSlack(root, 'local-a', {
    workspaceId: 'wrong', workspaceLabel: 'Wrong', appId: 'A0LOCAL123', appLabel: 'Chickpea',
  }), /immutable Slack IDs/);
  assert.throws(() => bindLocalLaneSlack(root, 'local-a', {
    workspaceId: 'T0OTHER123', workspaceLabel: 'Other', appId: 'A0OTHER123', appLabel: 'Chickpea',
  }), /already bound to a different immutable Slack workspace\/app pair/);
});

test('manifest validation rejects ownership tuple drift', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-drift-'));
  const initialized = await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  const original = JSON.parse(readFileSync(initialized.paths.manifest, 'utf8'));
  for (const drift of [
    { runtime: 'node' },
    { transport: 'socket-mode' },
    { model: 'different/model' },
    { d1DatabaseId: '00000000-0000-4000-8000-000000000001' },
  ]) {
    assert.throws(
      () => localWorkerLaneModule.validateLocalLaneManifest({ ...original, ...drift }, root, 'local-a'),
      /drifted|D1 identity/,
    );
  }
});

test('an unbound lane can rotate a failed endpoint without rotating durable credentials', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-relocate-'));
  const initialized = await initializeLocalLane({
    projectRoot: root,
    lane: 'local-a',
    publicUrl: 'https://stale.example.com',
    tunnelName: 'local-a-tunnel',
    port: 8787,
  });
  const oldVars = readFileSync(initialized.paths.devVars, 'utf8');
  const oldAuthSecret = oldVars.match(/^CHICKPEA_AUTH_SECRET=(.+)$/m)?.[1];
  const relocated = await relocateUnboundLocalLane(root, 'local-a', {
    publicUrl: 'https://fresh.example.com',
  });
  const newVars = readFileSync(relocated.paths.devVars, 'utf8');
  assert.equal(relocated.manifest.publicUrl, 'https://fresh.example.com');
  assert.equal(newVars.match(/^CHICKPEA_AUTH_SECRET=(.+)$/m)?.[1], oldAuthSecret);
  assert.match(newVars, /^SLACK_TAG_PUBLIC_URL=https:\/\/fresh\.example\.com$/m);
  assert.match(readFileSync(relocated.paths.setupLink, 'utf8'), /^https:\/\/fresh\.example\.com\/admin\/setup#setup=/);

  bindLocalLaneSlack(root, 'local-a', {
    workspaceId: 'T0LOCAL123', workspaceLabel: 'Local A', appId: 'A0LOCAL123', appLabel: 'Chickpea',
  });
  await assert.rejects(() => relocateUnboundLocalLane(root, 'local-a', {
    publicUrl: 'https://another.example.com',
  }), /already Slack-bound/);
});

test('Vite settings require the complete local ownership tuple', () => {
  assert.equal(localWorkerViteSettings({}), undefined);
  assert.deepEqual(localWorkerViteSettings({
    CHICKPEA_LOCAL_LANE: 'local-a',
    CHICKPEA_LOCAL_PUBLIC_URL: 'https://local-a.example.com',
    CHICKPEA_LOCAL_TUNNEL_NAME: 'local-a-tunnel',
    CHICKPEA_LOCAL_STATE_PATH: '/tmp/chickpea-local-a',
    CHICKPEA_LOCAL_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
    CHICKPEA_LOCAL_PORT: '8787',
    CHICKPEA_LOCAL_SOURCE_SHA: 'abc123',
  }), {
    lane: 'local-a',
    publicUrl: 'https://local-a.example.com',
    tunnelName: 'local-a-tunnel',
    statePath: '/tmp/chickpea-local-a',
    d1DatabaseId: '00000000-0000-4000-8000-000000000001',
    port: 8787,
    sourceSha: 'abc123',
  });
  assert.throws(() => validateLocalPublicUrl('http://local-a.example.com'), /HTTPS origin/);
  assert.throws(() => validateLocalPublicUrl('https://local-a.example.com/path'), /must not include a path/);
});

test('local timing observer separates startup and reload metrics', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chickpea-local-metrics-'));
  const metrics = path.join(root, 'metrics.jsonl');
  const observe = createLocalTimingObserver(metrics, 'local-a', 'abc123', Date.now() - 50);
  observe('\u001b[32mVITE v8.2.0  ready in 9384 ms\u001b[0m\n');
  observe('src/cloudflare.ts changed, restarting server...\n');
  observe('[vite] server restarted.\n');
  observe.noteSourceChange(Date.now() - 20);
  observe('10:37:58 AM [vite] (chickpea) hmr update /@id/virtual:cloudflare/worker-entry\n');
  const events = readFileSync(metrics, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].kind, 'startup');
  assert.equal(events[0].viteReportedMs, 9384);
  assert.equal(events[1].kind, 'reload');
  assert.equal(typeof events[1].elapsedMs, 'number');
  assert.equal(events[2].kind, 'reload');
  assert.equal(events[2].mode, 'hot-update');
  assert.ok(events[2].elapsedMs >= 20);
});

test('Cloudflare smoke cleanup cannot erase persistent local lane state', () => {
  const smoke = readFileSync(path.resolve(process.cwd(), 'scripts/verify-cf-smoke.mjs'), 'utf8');
  assert.match(smoke, /const PERSIST_DIR = mkdtempSync\(join\(tmpdir\(\), 'chickpea-cf-smoke-'\)\);/);
  assert.doesNotMatch(smoke, /const PERSIST_DIR = join\(REPO_ROOT,/);
});
