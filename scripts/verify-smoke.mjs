#!/usr/bin/env node
/**
 * Scripted live smoke for one QA lane, run once per merge batch on main.
 *
 *   npm run verify:smoke -- --lane amber --candidate /abs/clean/worktree
 *     [--cases id,id] [--skip-deploy] [--ledger FILE | --no-ledger] [--claim-timeout-ms MS]
 *
 * It claims the lane for the candidate worktree (waiting for a held lane, never
 * taking it), deploys the candidate with the lane's guarded deploy command,
 * runs the fixed cases in scripts/lib/smoke-cases.mjs as the lane's Owner
 * through the lane browser, cleans up what they created, appends one line to
 * the private smoke ledger (scripts/lib/smoke-ledger.mjs), and releases a
 * claim it took. Evidence goes to an owner-only run directory under
 * ~/.chickpea/verification/smoke/. Exit 0 when every case passed, 1 when any
 * failed or was blocked, 2 on a usage error.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deployScript } from './lib/kickoff-doctor.mjs';
import { QA_LANES } from './lib/qa-lanes.mjs';
import { SMOKE_CASES } from './lib/smoke-cases.mjs';
import { appendSmokeLedger, defaultSmokeLedger, SMOKE_LEDGER_SCHEMA } from './lib/smoke-ledger.mjs';

const USAGE = 'Usage: npm run verify:smoke -- --lane <amber|cobalt|violet> [--candidate ABS_WORKTREE] [--cases id,id] [--skip-deploy] [--ledger FILE | --no-ledger] [--claim-timeout-ms MS]\n';

export function parseArguments(argv, { cwd = process.cwd() } = {}) {
  const options = { lane: undefined, candidate: cwd, cases: SMOKE_CASES.map((entry) => entry.id), deploy: true, ledger: defaultSmokeLedger(), claimTimeoutMs: 600_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--skip-deploy') { options.deploy = false; continue; }
    if (flag === '--no-ledger') { options.ledger = null; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === '--lane') options.lane = value;
    else if (flag === '--candidate') options.candidate = value;
    else if (flag === '--ledger') options.ledger = value;
    else if (flag === '--claim-timeout-ms') options.claimTimeoutMs = Number(value);
    else if (flag === '--cases') options.cases = value.split(',').map((id) => id.trim()).filter(Boolean);
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if (!QA_LANES.includes(options.lane)) throw new Error(`Choose a lane: ${QA_LANES.join(', ')}.`);
  if (!path.isAbsolute(options.candidate)) throw new Error('--candidate must be an absolute worktree path.');
  if (options.ledger && !path.isAbsolute(options.ledger)) throw new Error('--ledger must be an absolute file path.');
  if (!Number.isSafeInteger(options.claimTimeoutMs) || options.claimTimeoutMs < 0) throw new Error('--claim-timeout-ms must be a whole number.');
  const unknown = options.cases.filter((id) => !SMOKE_CASES.some((entry) => entry.id === id));
  if (unknown.length || options.cases.length === 0) throw new Error(`Unknown cases: ${unknown.join(', ') || 'none chosen'}.`);
  return options;
}

/**
 * Runs the selected cases, each once its needs have settled; independent
 * cases run concurrently. A case whose need did not pass is blocked.
 */
export async function runCases(selected, world, { now = Date.now } = {}) {
  const shared = {};
  const results = new Map();
  const settle = async (entry) => {
    for (const need of entry.needs ?? []) {
      if (!selected.some((other) => other.id === need)) return { result: 'blocked', category: 'tool', summary: `Needs ${need}, which was not selected.`, durationMs: 0 };
      const outcome = await results.get(need);
      if (outcome.result !== 'pass') return { result: 'blocked', category: outcome.category, summary: `Needs ${need}, which did not pass.`, durationMs: 0 };
    }
    const startedAt = now();
    try {
      return { ...await entry.run(world, shared), durationMs: now() - startedAt };
    } catch (error) {
      return { result: 'fail', category: 'tool', summary: `The case threw: ${error instanceof Error ? error.message : String(error)}`, durationMs: now() - startedAt };
    }
  };
  for (const entry of selected) results.set(entry.id, settle(entry));
  const outcomes = [];
  for (const entry of selected) outcomes.push({ id: entry.id, ...await results.get(entry.id) });
  return outcomes;
}

function npmEnv(cwd, args, { env = process.env, timeoutMs = 120_000 } = {}) {
  const result = spawnSync('npm', ['run', '-s', 'env', '--', ...args], { cwd, env, encoding: 'utf8', timeout: timeoutMs });
  let body = null;
  try { body = JSON.parse(result.stdout); } catch { /* not JSON */ }
  let error = null;
  try { error = JSON.parse(result.stderr.trim().split('\n').at(-1) ?? '')?.error ?? null; } catch { /* not JSON */ }
  return { status: result.status, body, error };
}

const SETUP_LINK = /setup_[A-Za-z0-9_-]{20,}|capability=[A-Za-z0-9_-]+/gu;

/** Spawns the lane's guarded deploy; its own exit status decides, with output kept privately. */
function runDeploy({ cwd, lane, profile, logFile, env = process.env }) {
  const script = deployScript(profile);
  if (!script) return Promise.resolve({ status: 1, reason: `No deploy command for profile ${profile}.` });
  const log = createWriteStream(logFile, { mode: 0o600 });
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'verify:host', '--', '--wait-ms', '300000', 'npm', 'run', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...env,
        CHICKPEA_DEPLOY_TARGET: lane,
        // The guard reads remote main without credentials; HTTPS answers when the host's SSH route to GitHub stalls.
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
        GIT_CONFIG_VALUE_0: 'git@github.com:',
      },
    });
    const started = Date.now();
    let tail = '';
    let partial = '';
    // Each line carries its offset, so a slow phase (host wait, upload, readiness) shows in the log.
    const keep = (chunk) => {
      const lines = (partial + String(chunk)).split('\n');
      partial = lines.pop();
      for (const [index, line] of lines.entries()) {
        lines[index] = line.replace(SETUP_LINK, '<redacted>');
        log.write(`+${((Date.now() - started) / 1000).toFixed(1).padStart(6)} s ${lines[index]}\n`);
      }
      tail = (tail + lines.join('\n') + '\n').slice(-4000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('close', (status) => { keep('\n'); log.end(() => resolve({ status: status ?? 1, tail })); });
  });
}

async function openWorld({ lane, evidenceDir, env = process.env }) {
  const { readEnvironmentRegistry } = await import('./lib/environment-registry.mjs');
  const { ensureDaemon } = await import('./lib/lane-browser.mjs');
  const { laneCredentialsDirectory, readLaneSecretEntries, readLaneSeedToken } = await import('./lib/lane-secrets.mjs');
  const { readbackToken, readHistory, readThread, slackClient } = await import('./lib/slack-readback.mjs');
  const { adminSession, slackSession } = await import('./lib/lane-browser-tab.mjs');
  const registration = readEnvironmentRegistry().targets?.[lane] ?? {};
  const origin = new URL(JSON.parse(readFileSync(path.join(laneCredentialsDirectory(env), `${lane}-live.json`), 'utf8')).origin).origin;
  const token = readbackToken(readLaneSecretEntries({ env }), lane);
  if (!token) throw new Error(`${lane} has no readback token (qa/live/operator/hosts.md).`);
  const read = slackClient(token);
  const seedToken = readLaneSeedToken(lane, { env });
  const daemon = await ensureDaemon({ lane, env });
  if (daemon.state !== 'running') throw new Error(`chrome-${lane} is ${daemon.state}.`);
  const slack = await slackSession({ port: daemon.port, teamId: registration.workspaceId });
  const admin = await adminSession({ port: daemon.port, origin });
  const marker = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase();
  const world = {
    lane, origin, marker, botUserId: registration.botUserId, slack, admin, cleanup: [],
    word: (prefix) => `${prefix}${marker}`,
    reader: {
      thread: (channel, threadTs) => readThread(read, { channel, threadTs }),
      history: (channel, { oldest, limit }) => readHistory(read, { channel, oldest, limit }),
    },
    evidence: {
      write(name, value) {
        const file = path.join(evidenceDir, name);
        writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        return file;
      },
    },
    async markDueNow(routineId) {
      const response = await fetch(new URL('/internal/environment/routine-due', origin), {
        method: 'POST', headers: { authorization: `Bearer ${seedToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ routineId }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    close: async () => { await slack.close(); await admin.close(); },
  };
  const channels = await slack.call('users.conversations', { types: 'public_channel', limit: 200, exclude_archived: true });
  world.channel = (channels.channels ?? []).find((channel) => channel.name === `qa-${lane}`)?.id;
  if (!world.channel) throw new Error(`The Owner is in no #qa-${lane} channel.`);
  const dm = await slack.call('conversations.open', { users: registration.botUserId });
  world.dm = dm.channel?.id;
  if (!world.dm) throw new Error(`Could not open the DM with ${registration.botUserId}: ${dm.error ?? 'no channel'}.`);
  const agents = (await admin.call('GET', '/admin/api/agents')).body?.agents ?? [];
  const channelAgent = agents.find((agent) => agent.kind === 'user' && agent.lifecycle === 'active' && agent.id !== 'qa-fixtures' &&
    agent.slackPresence?.userGroupId && agent.whereItWorks?.channels?.some((entry) => entry.channelId === world.channel && entry.status === 'active'));
  if (channelAgent) world.channelAgent = { id: channelAgent.id, userGroupId: channelAgent.slackPresence.userGroupId };
  return world;
}

/** Deletes run-owned routines, then archives and deletes run-owned Agents, reading each back. */
async function cleanUp(world) {
  const report = [];
  for (const item of world.cleanup.filter((entry) => entry.kind === 'routine')) {
    // A completed one-time routine leaves its Agent's list but still exists; its own record is the readback.
    const read = () => world.admin.call('GET', `/admin/api/audit/scheduled_work/routines/${encodeURIComponent(item.id)}`);
    const routine = (await read()).body?.routine;
    if (routine && routine.state !== 'deleted') {
      await world.admin.call('POST', `${item.schedulesPath}/${encodeURIComponent(item.id)}/control`,
        { action: 'delete', expectedVersion: routine.version, acknowledgeIrreversible: true },
        { headers: { 'idempotency-key': `smoke:${world.marker}:${item.id}:delete` } });
    }
    const after = await read();
    report.push({ ...item, absent: after.status === 404 || after.body?.routine?.state === 'deleted' });
  }
  // An approval that lands after its case stopped polling still names the Agent with this run's marker.
  const listed = (await world.admin.call('GET', '/admin/api/agents')).body?.agents ?? [];
  for (const agent of listed.filter((entry) => entry.name === `Smoke ${world.marker}`)) {
    if (!world.cleanup.some((entry) => entry.kind === 'agent' && entry.id === agent.id)) world.cleanup.push({ kind: 'agent', id: agent.id });
  }
  for (const item of world.cleanup.filter((entry) => entry.kind === 'agent')) {
    const agentPath = `/admin/api/agents/${encodeURIComponent(item.id)}`;
    const read = async () => { const answer = await world.admin.call('GET', agentPath); return { status: answer.status, agent: answer.body?.agent ?? answer.body }; };
    let { status, agent } = await read();
    if (status === 200 && agent.lifecycle !== 'archived') {
      await world.admin.call('POST', `${agentPath}/archive`, { expectedRevision: agent.revision });
    }
    // Archiving turns the Slack handle off in the background and bumps the revision; delete once Admin allows it.
    const deadline = Date.now() + 90_000;
    while (status !== 404 && Date.now() < deadline) {
      ({ status, agent } = await read());
      if (status === 200 && agent.lifecycle === 'archived' && !agent.deletion?.blocked) {
        const deleted = await world.admin.call('DELETE', agentPath, { expectedRevision: agent.revision, credentialConfigurationBinding: agent.credentialConfigurationBinding });
        if (deleted.status === 204) continue;
      }
      if (status !== 404) await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    // Only Admin's 404 is an absence; a failed readback is not.
    report.push({ ...item, absent: status === 404 });
  }
  return report;
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.includes('--help')) { stdout.write(USAGE); return 0; }
  let options;
  try { options = parseArguments(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}`); return 2; }
  const startedAt = Date.now();
  const candidate = realpathSync(options.candidate);
  const { readEnvironmentRegistry } = await import('./lib/environment-registry.mjs');
  const registration = readEnvironmentRegistry().targets?.[options.lane] ?? {};
  // Without a deploy the cases grade whatever the lane already serves.
  const coreSha = options.deploy
    ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: candidate, encoding: 'utf8' }).stdout.trim()
    : registration.sourceRevision ?? '';
  if (!options.deploy && options.ledger && registration.sourceDirty) {
    stderr.write(`${options.lane} serves an uncommitted tree, and a ledger line names a commit. Deploy, or pass --no-ledger.\n`);
    return 2;
  }
  const evidenceDir = path.join(homedir(), '.chickpea', 'verification', 'smoke',
    `${new Date(startedAt).toISOString().replace(/[:.]/gu, '-')}-${options.lane}-${coreSha.slice(0, 8)}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const say = (line) => stdout.write(`[smoke ${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)} s] ${line}\n`);
  const selected = SMOKE_CASES.filter((entry) => options.cases.includes(entry.id));
  if (options.deploy && spawnSync('git', ['status', '--porcelain'], { cwd: candidate, encoding: 'utf8' }).stdout.trim()) {
    stderr.write(`The candidate ${candidate} has uncommitted changes; deploy a clean worktree.\n`);
    return 2;
  }

  const heldBefore = registration.claim?.canonicalWorktreePath === candidate;
  say(`claiming ${options.lane} for ${candidate} at ${coreSha.slice(0, 12)}`);
  // The candidate's own claim moves to its HEAD; anyone else's is waited out, never taken.
  const claim = heldBefore
    ? npmEnv(candidate, ['restamp', options.lane, '--worktree', candidate], { env })
    : npmEnv(candidate, ['wait-claim', options.lane, '--timeout-ms', String(options.claimTimeoutMs), '--poll-ms', '5000', '--worktree', candidate],
      { env, timeoutMs: options.claimTimeoutMs + 60_000 });
  if (claim.status !== 0) { stderr.write(`Could not claim ${options.lane}: ${claim.error ?? `exit ${claim.status}`}.\n`); return 1; }

  let deployMs = null;
  let outcomes = [];
  let cleanup = [];
  let workerVersion = null;
  const { readEnvironmentCapabilities } = await import('./lib/environment-capabilities.mjs');
  const profile = (await readEnvironmentCapabilities(options.lane, { env })).lanes[0]?.profile;
  const blocked = (summary) => selected.map((entry) => ({ id: entry.id, result: 'blocked', category: 'tool', summary, durationMs: 0 }));
  try {
    if (options.deploy) {
      say(`deploying (${profile} profile); log ${path.join(evidenceDir, 'deploy.log')}`);
      const deployStarted = Date.now();
      const deployed = await runDeploy({ cwd: candidate, lane: options.lane, profile, logFile: path.join(evidenceDir, 'deploy.log'), env });
      deployMs = Date.now() - deployStarted;
      if (deployed.status !== 0) {
        stderr.write(`The deploy exited ${deployed.status}${deployed.reason ? `: ${deployed.reason}` : ''}. Last output:\n${deployed.tail?.split('\n').slice(-8).join('\n') ?? ''}\n`);
        outcomes = blocked('The deploy failed.');
      }
      say(`deploy exited ${deployed.status} after ${(deployMs / 1000).toFixed(0)} s`);
      // The ledger line names coreSha, so the lane must register exactly that commit before a case runs.
      const served = readEnvironmentRegistry().targets?.[options.lane] ?? {};
      if (!outcomes.length && (served.sourceRevision !== coreSha || served.sourceDirty)) {
        stderr.write(`The deploy exited 0, but ${options.lane} registers ${served.sourceRevision ?? 'no revision'}${served.sourceDirty ? ' (dirty)' : ''}, not ${coreSha}.\n`);
        outcomes = blocked('The lane does not register the candidate.');
      }
    }
    workerVersion = (await readEnvironmentCapabilities(options.lane, { env })).lanes[0]?.liveVersion ?? null;
    if (!outcomes.length) {
      const world = await openWorld({ lane: options.lane, evidenceDir, env });
      try {
        say(`running ${selected.length} cases on ${workerVersion?.slice(0, 8) ?? 'unknown version'} as marker ${world.marker}`);
        outcomes = await runCases(selected, world);
        for (const outcome of outcomes) say(`${outcome.result.toUpperCase().padEnd(7)} ${outcome.id} (${(outcome.durationMs / 1000).toFixed(0)} s) ${outcome.summary}`);
        cleanup = await cleanUp(world);
        for (const item of cleanup) say(`cleanup ${item.kind} ${item.id}: ${item.absent ? 'absent on readback' : 'STILL PRESENT'}`);
      } finally {
        await world.close();
      }
    }
  } finally {
    if (!heldBefore) npmEnv(candidate, ['release', options.lane, '--worktree', candidate], { env });
  }

  const finishedAt = Date.now();
  const entry = {
    schema: SMOKE_LEDGER_SCHEMA, coreSha, lane: options.lane, profile: profile === 'sandbox' ? 'sandbox' : 'core', workerVersion,
    result: outcomes.every((outcome) => outcome.result === 'pass') && cleanup.every((item) => item.absent) ? 'pass' : 'fail',
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt, deployMs,
    cases: outcomes.map(({ id, result, category, durationMs }) => ({ id, result, category: result === 'pass' ? null : category ?? null, durationMs })),
    evidence: evidenceDir,
  };
  writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify({ ...entry, outcomes, cleanup }, null, 2)}\n`, { mode: 0o600 });
  if (options.ledger) say(`ledger ${appendSmokeLedger(entry, options.ledger)}${selected.length < SMOKE_CASES.length ? ' (a chosen subset, not a batch pass)' : ''}`);
  say(`${entry.result.toUpperCase()} in ${(entry.durationMs / 1000).toFixed(0)} s`);
  return entry.result === 'pass' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
