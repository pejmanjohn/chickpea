/** The Owner-facing copy for an Agent's own Slack app: DMs, consent pages and App Home lines, each table keyed by outcome. */
import type { AgentAppAttention } from '../../config/types.ts';
import { escapeHtml } from '../../security/html-escape.ts';
import { clampDisplay, escapeMrkdwn } from '../ui/text.ts';

export const YOUR_APPS_URL = 'https://api.slack.com/apps';
/** Slack refuses a button whose text is longer, and with it the whole message or view. */
const BUTTON_TEXT_MAX = 75;

export function tokenPagePath(agentId: string): string {
  return `/admin/agents/${encodeURIComponent(agentId)}/slack-app`;
}

export function tokenApiPath(agentId: string): string {
  return `/admin/api/agents/${encodeURIComponent(agentId)}/slack-app/token`;
}

/** Where Admin shows its Slack permissions bar with Update in Slack; the bar is on every Admin page. */
export const ADMIN_PATH = '/admin';
export const TRY_AGAIN_ACTION = 'agent_app_try_again';

export interface AgentAppNames {
  name: string;
  handle: string;
}

export interface AgentAppLinks {
  agentId: string;
  allowUrl?: string;
  tokenPageUrl?: string;
  adminUrl?: string;
}

export type AgentAppMessageKind = 'allow' | 'ready' | 'archived_left' | 'permission_needed' | AgentAppAttention;

type Button =
  | { label: string; url: string }
  | { label: string; action: string; value: string };

interface Copy {
  text(names: AgentAppNames): string;
  buttons(links: AgentAppLinks, names: AgentAppNames): Button[];
}

const tryAgain = (links: AgentAppLinks): Button => ({ label: 'Try again', action: TRY_AGAIN_ACTION, value: links.agentId });
const yourApps: Button = { label: 'Open Your Apps in Slack', url: YOUR_APPS_URL };
const allow = (links: AgentAppLinks, names: AgentAppNames): Button[] =>
  links.allowUrl ? [{ label: `Allow ${names.name} in Slack`, url: links.allowUrl }] : [];
const openAdmin = (adminUrl: string | undefined): Button[] => adminUrl ? [{ label: 'Open Chickpea', url: adminUrl }] : [];

/**
 * Freeing an Agent's handle needs the Owner's user-group permission, which an
 * Owner adds with Admin's Update in Slack. Until then nothing starts, and
 * there is no Try again: it could not succeed.
 */
export function permissionNeededCopy({ handle }: Pick<AgentAppNames, 'handle'>): string {
  return `Chickpea needs one more Slack permission to give @${handle} its own Slack app. In Chickpea Admin, choose Update in Slack, then choose Give @${handle} its own Slack app in Chickpea's Home tab.`;
}

const DM_COPY = {
  allow: {
    text: ({ name, handle }) =>
      `${name}'s Slack app is ready. Choose Allow to add it to this workspace. After that, people can message @${handle} directly and mention it in channels it's in.`,
    buttons: allow,
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
  create_refused: {
    text: ({ name }) => `Slack didn't finish ${name}'s app. Choose Try again. If it keeps happening, check that your workspace allows new apps.`,
    buttons: (links) => [tryAgain(links)],
  },
  /** The app exists; Slack refused the update that points its events and clicks at Chickpea. */
  urls_refused: {
    text: ({ name }) => `Slack didn't finish connecting ${name}'s app to Chickpea. Wait a minute, then choose Try again.`,
    buttons: (links) => [tryAgain(links)],
  },
  slack_busy: {
    text: () => 'Slack is limiting how fast apps are set up. Wait a minute, then choose Try again.',
    buttons: (links) => [tryAgain(links)],
  },
  permission_needed: {
    text: permissionNeededCopy,
    buttons: (links) => openAdmin(links.adminUrl),
  },
  config_token_needed: {
    text: ({ name }) => `Chickpea needs a new Slack refresh token to finish ${name}'s app.`,
    buttons: (links) => links.tokenPageUrl ? [{ label: 'Paste a new token', url: links.tokenPageUrl }] : [],
  },
  app_removed: {
    text: ({ name, handle }) =>
      `${name}'s Slack app was removed from this workspace, so @${handle} can't answer there. Choose Allow to add it back.`,
    buttons: allow,
  },
  /** The archive refusal Admin shows, sent too because the Agent no longer answers. */
  uninstall_failed: {
    text: archiveRefusedCopy,
    buttons: () => [],
  },
  archived_left: {
    text: ({ name }) =>
      `${name} is archived and its Slack app is removed from this workspace. Chickpea couldn't delete the app itself, so delete ${name} in Your Apps in Slack.`,
    buttons: () => [yourApps],
  },
} satisfies Record<AgentAppMessageKind, Copy>;

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

/** The Expired page for a callback whose state names no Agent. */
export function unnamedExpiredPage(): Response {
  return noticePage('That link has expired. Open your messages with Chickpea and choose Allow again.', CONSENT_STATUS.expired);
}

/** A plain page with one sentence; nothing on it is a diagnostic. */
function noticePage(text: string, status: number): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Chickpea</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px 24px;max-width:36rem}</style></head>` +
    `<body><p>${escapeHtml(text)}</p></body></html>`;
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export const START_APP_ACTION = 'agent_app_start';
export const FINISH_APP_ACTION = 'agent_app_finish';
/** A sequence that has not moved for this long shows "Finish setting up". */
export const STALLED_AFTER_MS = 2 * 60_000;

export type AgentAppHomeRow =
  | { kind: 'offer'; tokenPageUrl: string | undefined }
  | { kind: 'permission_needed'; adminUrl: string | undefined }
  | { kind: 'setting_up' }
  | { kind: 'stalled' }
  | { kind: 'waiting' }
  | { kind: 'active' }
  | { kind: 'attention' };

const HOME_COPY = {
  permission_needed: ({ handle }: AgentAppNames) =>
    `Chickpea needs one more Slack permission to give @${handle} its own Slack app. In Chickpea Admin, choose Update in Slack.`,
  setting_up: ({ handle }: AgentAppNames) => `Setting up @${handle}'s own Slack app.`,
  stalled: ({ handle }: AgentAppNames) => `Setting up @${handle}'s Slack app stopped partway.`,
  waiting: ({ handle }: AgentAppNames) => `@${handle}'s Slack app is ready to add. Open your messages with Chickpea to allow it.`,
  active: ({ handle }: AgentAppNames) => `@${handle} has its own Slack app. People can message @${handle} directly.`,
  attention: ({ handle }: AgentAppNames) => `@${handle}'s Slack app needs your attention. Open your messages with Chickpea for details.`,
} satisfies Record<Exclude<AgentAppHomeRow['kind'], 'offer'>, (names: AgentAppNames) => string>;

/** The Owner's App Home line under an Agent, with its one control. */
export function agentAppHomeBlocks(row: AgentAppHomeRow, names: AgentAppNames, agentId: string): object[] {
  const button = (text: string, extra: Record<string, unknown>) => ({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: clampDisplay(text, BUTTON_TEXT_MAX) }, ...extra }],
  });
  if (row.kind === 'offer') {
    const label = escapeMrkdwn(`Give @${names.handle} its own Slack app`);
    return [row.tokenPageUrl
      ? button(label, { url: row.tokenPageUrl, action_id: `agent_app_link_${agentId}` })
      : button(label, { action_id: START_APP_ACTION, value: agentId })];
  }
  const line = { type: 'context', elements: [{ type: 'mrkdwn', text: escapeMrkdwn(HOME_COPY[row.kind](names)) }] };
  if (row.kind === 'stalled') return [line, button('Finish setting up', { action_id: FINISH_APP_ACTION, value: agentId })];
  if (row.kind === 'permission_needed' && row.adminUrl) {
    return [line, button('Open Chickpea', { url: row.adminUrl, action_id: `agent_app_admin_${agentId}` })];
  }
  return [line];
}

export function archiveRefusedCopy(names: Pick<AgentAppNames, 'name'>): string {
  return `Chickpea couldn't remove ${names.name}'s Slack app, so ${names.name} is not archived. Try again in a minute.`;
}

/**
 * The DM for one outcome. The copy is prose with no markup of its own, so the
 * whole sentence is escaped once: an Agent's name can hold mention or link
 * syntax, and a bare `@handle` would otherwise ping a user group of that name.
 * Button labels are plain text.
 */
export function agentAppMessage(
  kind: AgentAppMessageKind,
  names: AgentAppNames,
  links: AgentAppLinks,
): { text: string; blocks: unknown[] } {
  const copy = DM_COPY[kind];
  const text = escapeMrkdwn(copy.text(names));
  const buttons = copy.buttons(links, names);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text } }];
  if (buttons.length > 0) {
    blocks.push({
      type: 'actions',
      elements: buttons.map((button) => ({
        type: 'button',
        text: { type: 'plain_text', text: clampDisplay(button.label, BUTTON_TEXT_MAX) },
        ...('url' in button
          ? { url: button.url, action_id: `agent_app_link_${button.label.toLowerCase().replace(/[^a-z]+/g, '_')}` }
          : { action_id: button.action, value: button.value }),
      })),
    });
  }
  return { text, blocks };
}
