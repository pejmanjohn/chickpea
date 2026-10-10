/**
 * The manifest rules Slack documents for `apps.manifest.create` and
 * `apps.manifest.update`, so a fake refuses what Slack refuses, in Slack's
 * words: `invalid_manifest` with an `errors` list of `{ message, pointer }`.
 */
import { SlackRefused } from '../../src/slack/agent-apps/slack-api.ts';

export interface SlackManifestError {
  message: string;
  pointer: string;
}

export function slackManifestErrors(manifest: unknown): SlackManifestError[] {
  const settings = record(record(manifest).settings);
  const errors: SlackManifestError[] = [];
  if ('event_subscriptions' in settings && settings.socket_mode_enabled !== true && !url(record(settings.event_subscriptions).request_url)) {
    errors.push({ message: 'Event Subscription requires either Request URL or Socket Mode Enabled', pointer: '/settings/event_subscriptions' });
  }
  const interactivity = record(settings.interactivity);
  if (interactivity.is_enabled === true && !url(interactivity.request_url)) {
    errors.push({ message: 'Interactivity requires a Request URL', pointer: '/settings/interactivity' });
  }
  return errors;
}

/** Slack's answer body to a manifest it refuses; undefined when it would accept it. */
export function slackManifestRefusal(manifest: unknown): { ok: false; error: 'invalid_manifest'; errors: SlackManifestError[] } | undefined {
  const errors = slackManifestErrors(manifest);
  return errors.length ? { ok: false, error: 'invalid_manifest', errors } : undefined;
}

/** What the agent-app Slack client throws for that answer. */
export function refuseLikeSlack(method: 'apps.manifest.create' | 'apps.manifest.update', manifest: unknown): void {
  const errors = slackManifestErrors(manifest);
  if (errors.length) throw new SlackRefused(method, 'invalid_manifest', errors);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function url(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
