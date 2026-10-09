/**
 * Every word the Owner reads about an Agent's own Slack app: the DMs from
 * Chickpea, one table keyed by what happened.
 */
import type { AgentAppAttention } from '../../config/types.ts';
import { escapeMrkdwn } from '../ui/text.ts';

export const YOUR_APPS_URL = 'https://api.slack.com/apps';
export const TRY_AGAIN_ACTION = 'agent_app_try_again';

export interface AgentAppNames {
  name: string;
  handle: string;
}

export interface AgentAppLinks {
  agentId: string;
  allowUrl?: string;
  tokenPageUrl?: string;
}

export type AgentAppMessageKind = 'allow' | 'ready' | 'archived_left' | AgentAppAttention;

type Button =
  | { label: string; url: string }
  | { label: string; action: string; value: string };

interface Copy {
  text(names: AgentAppNames): string;
  buttons(links: AgentAppLinks): Button[];
}

const tryAgain = (links: AgentAppLinks): Button => ({ label: 'Try again', action: TRY_AGAIN_ACTION, value: links.agentId });
const yourApps: Button = { label: 'Open Your Apps in Slack', url: YOUR_APPS_URL };
const allow = (names: AgentAppNames, links: AgentAppLinks): Button[] =>
  links.allowUrl ? [{ label: `Allow ${names.name} in Slack`, url: links.allowUrl }] : [];

const refused: Copy = {
  text: ({ name }) => `Slack didn't finish ${name}'s app. Choose Try again. If it keeps happening, check that your workspace allows new apps.`,
  buttons: (links) => [tryAgain(links)],
};

const DM_COPY = {
  allow: {
    text: ({ name, handle }) =>
      `${name}'s Slack app is ready. Choose Allow to add it to this workspace. After that, people can message @${handle} directly and mention it in channels it's in.`,
    buttons: () => [],
  },
  ready: {
    text: ({ handle }) => `@${handle} is in Slack now. Message it directly, or add it to a channel from the channel's Add people or agents.`,
    buttons: () => [],
  },
  handle_release_failed: {
    text: ({ name, handle }) =>
      `Chickpea couldn't free the name @${handle} in Slack, so it didn't create ${name}'s app. In Chickpea Admin, choose Update in Slack, then choose Try again.`,
    buttons: (links) => [tryAgain(links)],
  },
  ambiguous_create: {
    text: ({ name }) =>
      `Slack may have created an app for ${name}, but Chickpea didn't hear back. Open Your Apps in Slack and delete any ${name} app you don't recognize, then choose Try again.`,
    buttons: (links) => [yourApps, tryAgain(links)],
  },
  create_refused: refused,
  urls_refused: refused,
  slack_busy: {
    text: () => 'Slack is limiting how fast apps are set up. Wait a minute, then choose Try again.',
    buttons: (links) => [tryAgain(links)],
  },
  config_token_needed: {
    text: ({ name }) => `Chickpea needs a new Slack refresh token to finish ${name}'s app.`,
    buttons: (links) => links.tokenPageUrl ? [{ label: 'Paste a new token', url: links.tokenPageUrl }] : [],
  },
  app_removed: {
    text: ({ name, handle }) =>
      `${name}'s Slack app was removed from this workspace, so @${handle} can't answer there. Choose Allow to add it back.`,
    buttons: () => [],
  },
  /** Shown in Admin as the archive refusal; no message. */
  uninstall_failed: undefined,
  archived_left: {
    text: ({ name }) =>
      `${name} is archived and its Slack app is removed from this workspace. Chickpea couldn't delete the app itself, so delete ${name} in Your Apps in Slack.`,
    buttons: () => [yourApps],
  },
} satisfies Record<AgentAppMessageKind, Copy | undefined>;

export type ConsentOutcome =
  | 'cancelled'
  | 'expired'
  | 'another_person'
  | 'other_workspace'
  | 'missing_permissions'
  | 'slack_down'
  | 'already_active';

const CONSENT_COPY = {
  cancelled: ({ name }) => `${name} wasn't added. You can choose Allow ${name} in Slack again from your messages with Chickpea.`,
  expired: ({ name }) => `That link has expired. Choose Allow ${name} in Slack again from your messages with Chickpea.`,
  another_person: ({ name }) => `Only the Owner who started this can finish it. Choose Allow ${name} in Slack from your own messages with Chickpea.`,
  other_workspace: ({ name }) => `That was a different Slack workspace. Choose Allow ${name} in Slack from your messages with Chickpea in this workspace.`,
  missing_permissions: ({ name }) => `${name} needs every permission it asked for. Choose Allow ${name} in Slack again and allow them all.`,
  slack_down: ({ name }) => `Slack didn't answer. Choose Allow ${name} in Slack again in a minute.`,
  already_active: ({ name }) => `${name} already has its own Slack app.`,
} satisfies Record<ConsentOutcome, (names: AgentAppNames) => string>;

const CONSENT_STATUS = {
  cancelled: 200,
  expired: 410,
  another_person: 403,
  other_workspace: 409,
  missing_permissions: 409,
  slack_down: 503,
  already_active: 409,
} satisfies Record<ConsentOutcome, number>;

export function consentPage(outcome: ConsentOutcome, names: AgentAppNames): Response {
  return noticePage(CONSENT_COPY[outcome](names), CONSENT_STATUS[outcome]);
}

/** A plain page with one sentence; nothing on it is a diagnostic. */
export function noticePage(text: string, status: number): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Chickpea</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;max-width:36rem}</style></head>` +
    `<body><p>${escapeHtml(text)}</p></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

export function archiveRefusedCopy(names: Pick<AgentAppNames, 'name'>): string {
  return `Chickpea couldn't remove ${names.name}'s Slack app, so ${names.name} is not archived. Try again in a minute.`;
}

/**
 * The DM for one outcome, or undefined when that outcome has no message. The
 * copy is prose with no markup of its own, so the whole sentence is escaped
 * once: an Agent's name can hold mention or link syntax, and a bare `@handle`
 * would otherwise ping a user group of that name. Button labels are plain text.
 */
export function agentAppMessage(
  kind: AgentAppMessageKind,
  names: AgentAppNames,
  links: AgentAppLinks,
): { text: string; blocks: unknown[] } | undefined {
  const copy = DM_COPY[kind];
  if (!copy) return undefined;
  const text = escapeMrkdwn(copy.text(names));
  const buttons = kind === 'allow' || kind === 'app_removed' ? allow(names, links) : copy.buttons(links);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (buttons.length > 0) {
    blocks.push({
      type: 'actions',
      elements: buttons.map((button) => ({
        type: 'button',
        text: { type: 'plain_text', text: button.label },
        ...('url' in button
          ? { url: button.url, action_id: `agent_app_link_${button.label.toLowerCase().replace(/[^a-z]+/g, '_')}` }
          : { action_id: button.action, value: button.value }),
      })),
    });
  }
  return { text, blocks };
}
