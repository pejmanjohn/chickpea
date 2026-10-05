/**
 * Advisory liveness for lane claims. The holder's claim, restamp, deploy,
 * attestation and a `wait-claim` that reuses its own claim refresh it; the
 * kickoff doctor and `env status` report how long a holder has been silent.
 * It is never used to take, expire or adopt a claim: that stays an operator
 * decision (qa/live/operator/environments.md).
 *
 * The heartbeat lives beside the claim, in the lane's evidence root, not in
 * the registry's claim record: older pinned checkouts validate claims by exact
 * keys and share this registry. It names the claim's lease nonce, so a
 * heartbeat left by an earlier claim never vouches for a later one. This
 * module only reads and stays free of imports beyond Node built-ins.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLAIM_HEARTBEAT_SCHEMA = 'chickpea-environment-claim-heartbeat/v1';
export const CLAIM_HEARTBEAT_FILE = 'claim-heartbeat.json';
/** Silence longer than this gets a doctor warning; nothing else changes. */
export const CLAIM_SILENT_WARN_MS = 30 * 60 * 1000;

export function claimHeartbeatPath(evidenceRoot) {
  return join(evidenceRoot, CLAIM_HEARTBEAT_FILE);
}

/** The claim's latest heartbeat: its own claim time, or a later heartbeat written for this exact lease. */
export function claimHeartbeatAt(claim, evidenceRoot) {
  const claimedAt = Date.parse(claim?.claimedAt ?? '');
  if (!Number.isFinite(claimedAt)) return null;
  let latest = claimedAt;
  if (typeof evidenceRoot === 'string') {
    try {
      const file = claimHeartbeatPath(evidenceRoot);
      if (!lstatSync(file).isFile()) throw new Error('not a file');
      const beat = JSON.parse(readFileSync(file, 'utf8'));
      const at = Date.parse(beat?.heartbeatAt ?? '');
      if (beat?.schemaVersion === CLAIM_HEARTBEAT_SCHEMA && beat.target === claim.target
        && beat.leaseNonce === claim.leaseNonce && Number.isFinite(at) && at > latest) latest = at;
    } catch { /* No readable heartbeat for this lease: the claim time stands. */ }
  }
  return new Date(latest).toISOString();
}

/** How long the holder has been silent at `now`, or null without a readable claim time. */
export function claimSilentMs(heartbeatAt, now) {
  const at = Date.parse(heartbeatAt ?? '');
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
