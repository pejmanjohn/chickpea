/** The Owner-facing copy for an Agent's own Slack app: DMs, consent pages and App Home lines, each table keyed by outcome. */
import type { AgentAppAttention } from '../../config/types.ts';
import { escapeHtml } from '../../security/html-escape.ts';
import { clampDisplay, escapeMrkdwn } from '../ui/text.ts';

export const YOUR_APPS_URL = 'https://api.slack.com/apps';
/** Slack refuses a button whose text is longer, and with it the whole message or view. */
const BUTTON_TEXT_MAX = 75;

/** Admin's page where an Owner pastes the workspace's configuration token. */
export const TOKEN_PAGE_PATH = '/admin/destinations/slack/connection/token';

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

export type AgentAppMessageKind =
  | 'allow'
  | 'archived_left'
  | 'cancel_left'
  | 'cancel_unfinished'
  | 'archived_installed'
  | 'permission_needed'
  | 'app_removed_unreachable'
  | 'app_removed_permission'
  | 'recreated'
  | 'app_limit'
  | 'config_token_missing'
  | AgentAppAttention;

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
  return `Chickpea needs one more Slack permission to give @${handle} its own Slack app. In Chickpea Admin, choose Update in Slack, then try again.`;
}

function removedUnreachable({ name, handle }: AgentAppNames): string {
  return `${name}'s Slack app was removed from this workspace, so people can't mention @${handle} for now. ${name} still answers through Chickpea in its threads and in messages with Chickpea.`;
}

const DM_COPY = {
  allow: {
    text: ({ name, handle }) =>
      `${name}'s Slack app is ready. Choose Allow to add it to this workspace. After that, people can message @${handle} directly and mention it in channels it's in.`,
    buttons: allow,
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
  /** Chickpea created again because it kept no record of an app it made: two apps share the name, and one is unused. */
  recreated: {
    text: ({ name }) =>
      `Chickpea made a second ${name} app in Slack because it lost track of the first. Keep the one you allow from Chickpea's next message; after you allow it, Your Apps in Slack shows it as installed. Delete the other ${name} app there.`,
    buttons: () => [yourApps],
  },
  /** Nothing was created, and the Agent is as it was before the press. */
  app_limit: {
    // Which refusal Slack sends, and on which plans, is not yet seen: the sentence names neither a plan nor a number.
    text: ({ name }) =>
      `Slack wouldn't create another app for this workspace, which may have reached Slack's limit on apps. Deleting an app you no longer need in Slack and adding ${name} again may help.`,
    buttons: () => [],
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
  /** Add to Slack pressed in a workspace that has never kept a token, or removed it. */
  config_token_missing: {
    text: ({ name }) => `Chickpea needs a Slack refresh token to add ${name} to Slack.`,
    buttons: (links) => links.tokenPageUrl ? [{ label: 'Paste a token', url: links.tokenPageUrl }] : [],
  },
  /** Removed, and its user group is back on. */
  app_removed: {
    text: ({ name, handle }) =>
      `${name}'s Slack app was removed from this workspace. People can still mention @${handle}, and ${name} answers through Chickpea. Choose Allow to add the app back.`,
    buttons: allow,
  },
  /** Removed, with no user group to answer @handle: none to turn back on, or Slack refused. */
  app_removed_unreachable: {
    text: (names) => `${removedUnreachable(names)} Choose Allow to add the app back.`,
    buttons: allow,
  },
  /** Removed, and Slack refused to turn the user group back on for want of the Owner's permission. */
  app_removed_permission: {
    text: (names) =>
      `${removedUnreachable(names)} To bring back @${names.handle} without the app, choose Update in Slack in Chickpea Admin, then choose Try again. Or choose Allow to add the app back.`,
    buttons: (links, names) => [...allow(links, names), ...openAdmin(links.adminUrl), tryAgain(links)],
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
  /** An Owner cancelled before Allow and Chickpea could not delete the app it had created. */
  cancel_left: {
    text: ({ name }) =>
      `Chickpea couldn't delete the Slack app it made for ${name}, so delete ${name} in Your Apps in Slack. ${name} keeps answering as it did before.`,
    buttons: () => [yourApps],
  },
  /** An Owner cancelled before Allow and Slack refused to uninstall the app; the next Cancel or Try again picks it up. */
  cancel_unfinished: {
    text: ({ name }) =>
      `Chickpea couldn't finish removing the Slack app it made for ${name}. Choose Try again in a minute. ${name} keeps answering as it did before.`,
    buttons: (links) => [tryAgain(links)],
  },
  /** Archived with the app still installed: no record proved it was the Agent's, so Chickpea neither uninstalled nor deleted it. */
  archived_installed: {
    text: ({ name }) =>
      `${name} is archived. Chickpea couldn't remove its Slack app from this workspace, so delete ${name} in Your Apps in Slack.`,
    buttons: () => [yourApps],
  },
} satisfies Record<AgentAppMessageKind, Copy>;

/** What the person who pressed Add to Slack sees when the press starts nothing. */
export function addPressReply(
  kind: 'gone' | 'owner_needed' | 'archived' | 'in_slack' | 'already_started',
  names?: AgentAppNames,
): string {
  const name = names?.name ?? '';
  switch (kind) {
    case 'gone':
      return 'That Agent no longer exists.';
    case 'owner_needed':
      return `A workspace Owner needs to add ${name} to Slack.`;
    case 'archived':
      return `${name} is archived, so it can't be added to Slack.`;
    case 'in_slack':
      return `${name} is already in Slack.`;
    case 'already_started':
      return `Chickpea is already adding ${name} to Slack. Its latest message to you says what's next.`;
  }
}

/** Where an Agent's own bot is after the switch, by Channel ID. */
export interface AgentAppSwitchReport {
  /** Granted Channels its bot is in. */
  joined: readonly string[];
  /** Granted Channels its bot is not in, where it answers through Chickpea. */
  throughChickpea: readonly string[];
  /** Slack refused to turn the user group off, so it still answers too. */
  groupStillOn: boolean;
  /** The Agent was not in Slack before its app: an add, not a move of a handle people already use. */
  added: boolean;
}

const CHANNEL_ID = /^[CG][A-Z0-9]{2,}$/;

/**
 * The Owner's one message once an Agent is its own app: one added to Slack,
 * or one whose handle moved there.
 * Channels are named with Slack's `<#C…>` reference, which Slack shows as the
 * Channel's name to anyone who can see it; everything else is escaped.
 */
export function agentAppSwitchedMessage(names: AgentAppNames, report: AgentAppSwitchReport): { text: string; blocks: unknown[] } {
  const { name, handle } = names;
  const channels = (ids: readonly string[]) => listed(ids.filter((id) => CHANNEL_ID.test(id)).map((id) => `<#${id}>`));
  const joined = channels(report.joined);
  const elsewhere = channels(report.throughChickpea);
  const text = [
    escapeMrkdwn(report.added
      ? `${name} is now in Slack as its own app. People can message it and mention @${handle}.`
      : `${name} is now its own Slack app. People keep using @${handle}.`),
    ...(joined ? [`${escapeMrkdwn('It joined')} ${joined}.`] : []),
    ...(elsewhere ? [`In ${elsewhere} ${escapeMrkdwn('it keeps answering through Chickpea until someone there adds it.')}`] : []),
    ...(report.groupStillOn
      ? [escapeMrkdwn(`Slack didn't let Chickpea turn off the @${handle} user group, so people may see @${handle} twice when they mention it. Both reach ${name}.`)]
      : []),
  ].join(' ');
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/** Slack caps a section's text at 3,000 characters; a long list names this many and counts the rest. */
const LISTED_MAX = 20;

function listed(items: readonly string[]): string {
  if (items.length > LISTED_MAX) return `${items.slice(0, LISTED_MAX).join(', ')} and ${items.length - LISTED_MAX} more`;
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

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
  | { kind: 'setting_up' }
  | { kind: 'stalled' }
  | { kind: 'waiting' }
  | { kind: 'active' }
  /** Live, and the Owner never got the switch's result message: the row says what it would have. */
  | { kind: 'active_untold'; report: AgentAppSwitchReport }
  | { kind: 'attention' }
  /** An Owner's Cancel is deleting the app Chickpea made; the Agent answers as it did before. */
  | { kind: 'removing' }
  | { kind: 'removing_stalled' };

const HOME_COPY = {
  setting_up: ({ handle }: AgentAppNames) => `Setting up @${handle}'s own Slack app.`,
  stalled: ({ handle }: AgentAppNames) => `Setting up @${handle}'s Slack app stopped partway.`,
  waiting: ({ handle }: AgentAppNames) => `@${handle}'s Slack app is ready to add. Open your messages with Chickpea to allow it.`,
  active: ({ handle }: AgentAppNames) => `@${handle} has its own Slack app. People can message @${handle} directly.`,
  attention: ({ handle }: AgentAppNames) => `@${handle}'s Slack app needs your attention. Open your messages with Chickpea for details.`,
  removing: ({ handle }: AgentAppNames) => `Removing the Slack app Chickpea made for @${handle}.`,
  removing_stalled: ({ handle }: AgentAppNames) => `Removing the Slack app Chickpea made for @${handle} stopped partway.`,
} satisfies Record<Exclude<AgentAppHomeRow['kind'], 'active_untold'>, (names: AgentAppNames) => string>;

/** The Owner's App Home line under an Agent, with its one control. */
export function agentAppHomeBlocks(row: AgentAppHomeRow, names: AgentAppNames, agentId: string): object[] {
  const button = (text: string, extra: Record<string, unknown>) => ({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: clampDisplay(text, BUTTON_TEXT_MAX) }, ...extra }],
  });
  const text = row.kind === 'active_untold' ? agentAppSwitchedMessage(names, row.report).text : escapeMrkdwn(HOME_COPY[row.kind](names));
  const line = { type: 'context', elements: [{ type: 'mrkdwn', text }] };
  if (row.kind === 'stalled') return [line, button('Finish setting up', { action_id: FINISH_APP_ACTION, value: agentId })];
  if (row.kind === 'removing_stalled') return [line, button('Finish removing', { action_id: FINISH_APP_ACTION, value: agentId })];
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
