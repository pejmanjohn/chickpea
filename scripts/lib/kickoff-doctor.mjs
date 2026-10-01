/**
 * The live verification kickoff doctor: one read-only pass over everything a
 * run needs before it claims a lane, so a run does not stall mid-journey on a
 * stale install, a signed-out browser, a held lane or a schema it cannot serve.
 * It claims, deploys, starts and changes nothing.
 *
 * `kickoffReport` is pure (facts in, verdicts out). `gatherKickoffFacts` does
 * the reads and takes injectable readers for tests.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const KICKOFF_SCHEMA = 'chickpea-kickoff-doctor/v1';
const LANES = ['amber', 'cobalt', 'violet'];

const check = (level, text, fix) => ({ level, text, ...(fix ? { fix } : {}) });

export function deployCommand(lane, profile) {
  const script = profile === 'sandbox' ? 'deploy:sandbox' : 'deploy';
  return `CHICKPEA_DEPLOY_TARGET=${lane} npm run verify:host -- --wait-ms 300000 npm run ${script}`;
}

/** Facts in, verdicts out. Levels: ok, info, warn, human (needs a person), block. */
export function kickoffReport(facts) {
  const host = [];
  const { node } = facts;
  if (node.version === `v${node.baseline}`) host.push(check('ok', `Node ${node.version} matches .nvmrc`));
  else if (node.supported) host.push(check('warn', `Node ${node.version} is supported but not the ${node.baseline} pin; release checkpoints need the pin`, 'Open a new shell (the profile puts the pinned Node first) or run nvm use.'));
  else host.push(check('block', `Node ${node.version} is outside the supported range (pin ${node.baseline})`, 'Open a new shell or run nvm use, then rerun.'));

  if (facts.dependencies.error) host.push(check('warn', `Could not compare node_modules with package-lock.json: ${facts.dependencies.error}`));
  else if (facts.dependencies.drift.length) {
    const sample = facts.dependencies.drift.slice(0, 3).map((d) => `${d.name} ${d.installed} (locked ${d.locked})`).join(', ');
    host.push(check('block', `node_modules differs from package-lock.json for ${facts.dependencies.drift.length} package(s): ${sample}`, 'npm ci --strict-allow-scripts'));
  } else host.push(check('ok', 'node_modules matches package-lock.json'));

  const owner = facts.hostReservation;
  if (!owner) host.push(check('ok', 'Host reservation is free'));
  else if (owner.alive) host.push(check('info', `Host checks are reserved by PID ${owner.pid} in ${owner.cwd} since ${owner.startedAt}; a guarded deploy waits for it with --wait-ms`));
  else host.push(check('human', `Host reservation names PID ${owner.pid} in ${owner.cwd}, which is no longer running`, 'Ask the maintainer before removing the stale reservation; never remove another task\'s lock on your own.'));

  const { source } = facts;
  if (source.status === 'current') host.push(check('ok', `Source contains remote main ${source.approvedTip.slice(0, 8)}`));
  else if (source.status === 'behind') host.push(check('block', 'Source is behind remote main, so a guarded deploy would refuse it', 'Rebase or merge origin/main, rerun the affected offline checks, then npm run env -- restamp <lane> if you hold one.'));
  else host.push(check('warn', `Source admission not confirmed (${source.code ?? 'unknown'}); the guarded deploy checks again`));

  const lanes = facts.lanes.map((lane) => laneVerdict(lane, facts));
  const needs = [
    ...host.filter((c) => c.level === 'human').map((c) => c.text),
    ...lanes.flatMap((lane) => lane.checks.filter((c) => c.level === 'human').map((c) => `${lane.target}: ${c.text}`)),
  ];
  const hostBlocked = host.some((c) => c.level === 'block');
  const ready = lanes.filter((lane) => lane.ready).map((lane) => lane.target);
  return {
    schemaVersion: KICKOFF_SCHEMA, generatedAt: facts.generatedAt, worktree: facts.worktree, localSchema: facts.localSchema,
    host, lanes, needs, ready, ok: !hostBlocked && ready.length > 0,
  };
}

function laneVerdict(lane, facts) {
  const checks = [];
  if (lane.health !== 'ready') checks.push(check('block', `Lane health is ${lane.health}`, 'npm run env -- status <lane> shows why; repair it or choose another lane.'));
  if (lane.readErrors?.length) checks.push(check('warn', `Live read errors: ${lane.readErrors.join('; ')}`));
  const version = lane.liveVersion ?? lane.servingVersion;
  if (lane.profile && lane.profile !== 'unknown') {
    checks.push(check(lane.profile === 'mixed' ? 'warn' : 'info', `${lane.profile} profile, serving ${version ? version.slice(0, 8) : 'unknown'}; deploy with: ${deployCommand(lane.target, lane.profile)}`));
  } else checks.push(check('warn', 'Deploy profile unknown (Wrangler could not read the live Worker)'));

  if (!lane.claim) checks.push(check('ok', 'Free'));
  else if (lane.claim.ownWorktree) checks.push(check('ok', `Claimed by this worktree (${lane.claim.branch ?? 'branch unknown'}) until ${lane.claim.expiresAt}`));
  else checks.push(check('block', `Held by another worktree${lane.claim.branch ? ` on ${lane.claim.branch}` : ''} until ${lane.claim.expiresAt}`, 'Use npm run env -- wait-claim <lane> or choose another lane; never take it.'));

  if (!facts.localSchema || !lane.schemaGeneration) checks.push(check('warn', `Schema generation unknown (lane ${lane.schemaGeneration ?? '?'}, candidate ${facts.localSchema ?? '?'})`));
  else if (lane.schemaGeneration === facts.localSchema) checks.push(check('ok', `Schema ${lane.schemaGeneration} matches the candidate`));
  else checks.push(check('human', `Lane serves schema ${lane.schemaGeneration}; the candidate needs ${facts.localSchema}`, 'Advancing is permanent: get the maintainer\'s approval for npm run env -- schema-advance <lane>, or choose a lane at the candidate\'s generation.'));

  if (lane.versionMatchesRegistry === false) checks.push(check('warn', `The live version differs from the registry's ${lane.servingVersion?.slice(0, 8) ?? 'record'}; someone deployed outside the guarded wrapper or a deploy is unreconciled`));
  if (lane.modelRoles) checks.push(check('info', `Models: ${lane.modelRoles}`));
  if (lane.providerKeys) checks.push(check('info', `Worker secrets present: ${lane.providerKeys.join(', ') || 'none'}`));
  if (lane.missingActorAliases?.length) checks.push(check('warn', `No registered actor for ${lane.missingActorAliases.join(', ')}; Member-view and denial cases need a second person`));
  if (lane.setupFlowUnprovenSince) checks.push(check('warn', `Setup flow unproven since ${lane.setupFlowUnprovenSince.slice(0, 8)}; report it in the run`));
  if (lane.telemetryReceipt) checks.push(check('ok', 'Telemetry isolation receipt exists for the serving version'));
  else checks.push(check('info', 'No telemetry receipt for the serving version yet; the guarded deploy writes one, or run npm run verify:telemetry -- --target <lane>'));

  const browser = lane.browser;
  if (!browser) checks.push(check('info', 'Browser not checked (--no-browser)'));
  else if (browser.state === 'stopped') checks.push(check('block', 'Lane browser is stopped', `npm run lane:browser -- start ${lane.target}`));
  else if (browser.state === 'held') checks.push(check('human', `Lane browser profile is held by another session's Chrome (PID ${browser.holderPid ?? '?'})`, 'Ask that session to quit its browser, then npm run lane:browser -- start <lane>.'));
  else {
    for (const [surface, label] of [['admin', 'Admin'], ['slack', 'Slack']]) {
      const state = browser[surface];
      if (state === 'signed_in') checks.push(check('ok', `${label} signed in through chrome-${lane.target}`));
      else if (state === 'signed_out') checks.push(check('human', `${label} is signed out in chrome-${lane.target}`, `Sign in to ${label} in that browser with the lane's test account.`));
      else if (state === 'other_workspace') checks.push(check('human', `Slack in chrome-${lane.target} is on a different workspace`, 'Sign in to the lane workspace in that browser.'));
      else checks.push(check('warn', `${label} sign-in could not be confirmed (${state ?? 'not probed'})`));
    }
  }
  const ready = !checks.some((c) => c.level === 'block' || c.level === 'human');
  return { target: lane.target, ready, checks };
}

const MARK = { ok: '✔', info: '·', warn: '!', human: '?', block: '✖' };
export function renderKickoff(report) {
  const lines = ['Kickoff doctor: read-only; it claims, deploys and changes nothing.', '', 'Host and source'];
  const line = (c) => `  ${MARK[c.level]} ${c.text}${c.fix ? `\n      fix: ${c.fix}` : ''}`;
  lines.push(...report.host.map(line), '', 'Lanes');
  for (const lane of report.lanes) {
    lines.push(`  ${lane.target}: ${lane.ready ? 'ready' : 'not ready'}`);
    lines.push(...lane.checks.map((c) => `  ${line(c)}`));
  }
  lines.push('');
  if (report.needs.length) lines.push('Needs a person (ask once, in one message):', ...report.needs.map((n) => `  - ${n}`), '');
  lines.push(report.ready.length
    ? `Ready: ${report.ready.join(', ')}. Next: npm run env -- wait-claim ${report.ready[0]} --timeout-ms 0 --poll-ms 1000 --worktree ${report.worktree}`
    : 'No lane is ready. Fix the blockers above, or record the run as blocked.');
  return `${lines.join('\n')}\n`;
}

/** Read every fact. Each reader is injectable; failures become facts, never crashes. */
export async function gatherKickoffFacts({
  root, lanes = LANES, env = process.env, providerContext, browser = true, now = Date.now,
  readers = {},
} = {}) {
  const load = async (name, fallback) => readers[name] ?? fallback();
  const nodeVersion = await import('./node-version.mjs');
  const facts = {
    generatedAt: new Date(now()).toISOString(),
    worktree: realpathSync(root),
    node: { version: readers.nodeVersion ?? process.version, baseline: nodeVersion.NODE_BASELINE,
      supported: nodeVersion.isSupportedNodeVersion(readers.nodeVersion ?? process.version) },
  };
  try {
    const drift = readers.lockfileDrift ? readers.lockfileDrift(root) : (await import('./installed-dependencies.mjs')).lockfileDrift(root);
    facts.dependencies = { drift };
  } catch (error) { facts.dependencies = { drift: [], error: error.message }; }

  facts.hostReservation = await load('hostReservation', async () => {
    const { HOST_CHECK_LOCK } = await import('./verification-host.mjs');
    let owner;
    try { owner = JSON.parse(readFileSync(HOST_CHECK_LOCK, 'utf8')); } catch { return null; }
    let alive = false;
    try { process.kill(owner.pid, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
    return { pid: owner.pid, cwd: owner.cwd, startedAt: owner.startedAt, alive };
  });

  facts.source = await load('source', async () => {
    try {
      const { admitQaCandidate } = await import('./qa-candidate.mjs');
      const admission = admitQaCandidate(root);
      return { status: 'current', approvedTip: admission.approvedTip };
    } catch (error) {
      return { status: error?.code === 'QA_SOURCE_BEHIND_MAIN' ? 'behind' : 'unknown', code: error?.code ?? 'UNKNOWN' };
    }
  });

  facts.localSchema = await load('localSchema', async () => {
    try { return (await import('./environment-preflight.mjs')).readLocalEnvironmentContract({ projectRoot: root }).schemaGeneration; }
    catch { return null; }
  });

  const rows = await load('capabilities', async () => {
    const { readEnvironmentCapabilities } = await import('./environment-capabilities.mjs');
    const report = await readEnvironmentCapabilities(lanes.length === 1 ? lanes[0] : 'all', { env, ...(providerContext ? { providerContext } : {}) });
    return report.lanes.filter((row) => lanes.includes(row.target));
  });
  const registry = await load('registry', async () => (await import('./environment-registry.mjs')).readEnvironmentRegistry());

  facts.lanes = [];
  for (const row of rows) {
    const registration = registry.targets?.[row.target] ?? {};
    const claim = registration.claim;
    let ownWorktree = false;
    try { ownWorktree = Boolean(claim?.canonicalWorktreePath) && realpathSync(claim.canonicalWorktreePath) === facts.worktree; } catch { ownWorktree = false; }
    const servingVersion = row.liveVersion ?? registration.servingVersion ?? null;
    facts.lanes.push({
      target: row.target, health: row.health, profile: row.profile, liveVersion: row.liveVersion,
      servingVersion: registration.servingVersion ?? null, schemaGeneration: row.schemaGeneration ?? registration.schemaGeneration ?? null,
      readErrors: row.errors ?? [], modelRoles: row.defaultChatModel || row.imageRole || row.codingRole ? row.modelRoles : null,
      providerKeys: row.secrets ? Object.entries(row.secrets).filter(([, present]) => present).map(([name]) => name) : null,
      versionMatchesRegistry: row.versionMatchesRegistry ?? null,
      missingActorAliases: row.missingActorAliases ?? [], setupFlowUnprovenSince: row.setupFlowUnprovenSince ?? null,
      claim: claim ? { ownWorktree, branch: claim.branch, expiresAt: claim.expiresAt } : null,
      telemetryReceipt: servingVersion ? hasTelemetryReceipt(registration.evidenceRoot, servingVersion) : false,
      browser: browser ? await (readers.browser ?? probeLaneBrowser)({ lane: row.target, registration, env }) : null,
    });
  }
  return facts;
}

function hasTelemetryReceipt(evidenceRoot, version) {
  try { return readdirSync(evidenceRoot).some((name) => name.startsWith(`telemetry-${version}`) && name.endsWith('.json')); }
  catch { return false; }
}

/** Daemon state, then Admin and Slack sign-in through one owned tab each. */
export async function probeLaneBrowser({ lane, registration, env = process.env }) {
  const browserApi = await import('./lane-browser.mjs');
  const conventional = path.join(homedir(), '.chickpea', 'browsers');
  const root = !env[browserApi.ROOT_VARIABLE]?.trim() && existsSync(conventional) ? conventional : browserApi.resolveProfileRoot({ env });
  const status = await browserApi.daemonStatus({ lane, root, env });
  if (status.state !== 'running') return { state: status.state, holderPid: status.holder?.pid ?? null };
  const probe = await import('./lane-browser-probe.mjs');
  const result = { state: 'running', admin: 'not_probed', slack: 'not_probed' };
  const origin = laneOrigin(lane, env);
  if (origin) {
    try {
      const page = await probe.probePage({ port: status.port, url: new URL('/admin', origin).href, settledWhen: probe.adminSettled });
      result.admin = probe.adminSession(page);
    } catch { result.admin = 'unknown'; }
  }
  if (registration.workspaceId) {
    try {
      const page = await probe.probePage({ port: status.port, url: `https://app.slack.com/client/${registration.workspaceId}`, settledWhen: probe.slackSettled(registration.workspaceId) });
      result.slack = probe.slackSession(page, registration.workspaceId);
    } catch { result.slack = 'unknown'; }
  }
  return result;
}

function laneOrigin(lane, env) {
  try {
    const directory = env.CHICKPEA_LANE_CREDENTIALS_DIR?.trim() || path.join(homedir(), '.chickpea', 'lane-credentials');
    const origin = new URL(JSON.parse(readFileSync(path.join(directory, `${lane}-live.json`), 'utf8')).origin);
    return origin.protocol === 'https:' && !origin.username && !origin.password ? origin.origin : null;
  } catch { return null; }
}
