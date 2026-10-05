/**
 * Advisory liveness for lane claims. The holder's claim, restamp, deploy,
 * attestation and a `wait-claim` that reuses its own claim refresh it, and
 * release removes it; the kickoff doctor and `env status` report how long a
 * holder has been silent. This heartbeat, like the host reservation's
 * long-hold warning, only reports: nothing reads either to take, expire,
 * release or adopt a claim or the host slot. That stays an operator decision
 * (qa/live/operator/environments.md, host-checks.md).
 *
 * The heartbeat lives beside the claim, in the lane's evidence root, not in
 * the registry's claim record: older pinned checkouts validate claims by exact
 * keys and share this registry. Those checkouts never write a heartbeat, so a
 * claim without one shows its claim time only and is never called silent. The
 * file names the claim's lease nonce, so a heartbeat left by an earlier claim
 * never vouches for a later one. This module only reads and stays free of
 * imports beyond Node built-ins.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CLAIM_HEARTBEAT_SCHEMA = 'chickpea-environment-claim-heartbeat/v1';
export const CLAIM_HEARTBEAT_FILE = 'claim-heartbeat.json';
/** Silence longer than this gets a doctor warning. */
export const CLAIM_SILENT_WARN_MS = 30 * 60 * 1000;

export function claimHeartbeatPath(evidenceRoot) {
  return join(evidenceRoot, CLAIM_HEARTBEAT_FILE);
}

/**
 * The claim's latest heartbeat, written for this exact lease, or null when the
 * lane holds none for it: the holder is an older checkout, or its advisory
 * write failed. Null means "no heartbeat", never "silent".
 */
export function claimHeartbeatAt(claim, evidenceRoot) {
  if (typeof evidenceRoot !== 'string') return null;
  let beat;
  try {
    const file = claimHeartbeatPath(evidenceRoot);
    if (lstatSync(file).isFile()) beat = JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
  const at = Date.parse(beat?.heartbeatAt ?? '');
  if (beat?.schemaVersion !== CLAIM_HEARTBEAT_SCHEMA || beat.target !== claim?.target
    || beat.leaseNonce !== claim?.leaseNonce || !Number.isFinite(at)) return null;
  const claimedAt = Date.parse(claim.claimedAt ?? '');
  return new Date(Number.isFinite(claimedAt) ? Math.max(at, claimedAt) : at).toISOString();
}

/** How long the holder has been silent at `now`, or null without a heartbeat. */
export function claimSilentMs(heartbeatAt, now) {
  const at = Date.parse(heartbeatAt ?? '');
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
