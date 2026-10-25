/**
 * Run review: the hosted "Help improve Chickpea" setting. With it on, the
 * host keeps one scrubbed copy of each Agent run for the Chickpea team to
 * find and fix bugs. The host owns the setting, its authorization history,
 * and the stored copies; Core builds each copy and hands it over.
 *
 * The host installs one port at module scope. With no port, as on
 * standalone, nothing is read, built, collected or stored, and Admin shows
 * no setting.
 */

import type { RunReviewRecordV1 } from './record.ts';

/** Who changed the setting: an Owner or Admin, from Settings or onboarding. */
export interface RunReviewActor {
  readonly slackUserId: string;
  readonly membershipId: string;
}

export interface RunReviewPort {
  /** Current state for Admin. Absent installation or no row → false. */
  enabled(installationId: string): Promise<boolean>;
  /** Owner/Admin change from Settings or onboarding. `false` also queues a purge. Returns the new state. */
  setEnabled(
    installationId: string,
    change: { enabled: boolean; actor: RunReviewActor; textVersion: string },
  ): Promise<boolean>;
  /** Cached (≤30 s, ideally the same registry read as admission) check at run start. The only per-run registry read. */
  capturing(installationId: string): Promise<boolean>;
  /** Seal and store. No re-check: the purge job's delayed confirming pass closes the off→purge race. Never called with an unscrubbed record. */
  record(installationId: string, record: RunReviewRecordV1): Promise<void>;
  /** HTTPS URL for "Learn more". */
  readonly privacyUrl: string;
}

let port: RunReviewPort | undefined;

/** The composition seam: the host's port, installed once at module scope; undefined removes it. */
export function configureRunReview(next: RunReviewPort | undefined): void {
  if (next && !isHttpsUrl(next.privacyUrl)) {
    throw new Error('The run review port needs an absolute https: privacy URL.');
  }
  port = next;
}

export function runReview(): RunReviewPort | undefined {
  return port;
}

export function runReviewConfigured(): boolean {
  return port !== undefined;
}

function isHttpsUrl(value: unknown): boolean {
  return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:';
}
