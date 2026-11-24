/** The Owner-facing copy for an Agent's own Slack app in Slack: DMs and App Home lines, each table keyed by outcome. */
import type { AgentAppAttention } from '../../config/types.ts';
import { clampDisplay, escapeMrkdwn } from '../ui/text.ts';

export const YOUR_APPS_URL = 'https://api.slack.com/apps';
/** Slack refuses a button whose text is longer, and with it the whole message or view. */
const BUTTON_TEXT_MAX = 75;

/** Admin's page where an Owner pastes the workspace's configuration token. */
export const TOKEN_PAGE_PATH = '/admin/destinations/slack/connection/token';

/** Admin's Slack connection section, where an Owner pressing in Admin lands after Slack's Allow. */
export const SLACK_CONNECTION_PATH = '/admin/destinations/slack/connection';

/** Where Admin shows its Slack permissions bar with Update in Slack; the bar is on every Admin page. */
export const ADMIN_PATH = '/admin';
export const TRY_AGAIN_ACTION = 'agent_app_try_again';

export interface AgentAppNames {
  name: string;
  handle: string;
  /** The Agent's handle Slack would not give its user group, which answers to `handle` instead. */
  refusedHandle?: string;
}

export interface AgentAppLinks {
  agentId: string;
  allowUrl?: string;
  /** The hand-off page whose press starts, resumes or finishes adding the Agent, then opens Slack's Allow. */
  addUrl?: string;
  tokenPageUrl?: string;
  adminUrl?: string;
}

export type AgentAppMessageKind =
  | 'allow'
  | 'archived_left'
  | 'archived_not_found'
  | 'cancel_left'
  | 'cancel_not_found'
  | 'cancel_unfinished'
  | 'archived_installed'
  | 'permission_needed'
  | 'app_removed_handle_kept'
  | 'app_removed_unreachable'
  | 'app_removed_permission'
  | 'recreated'
  | 'app_limit'
  | 'handle_taken'
  | 'update_refused'
  | 'update_failed'
  | 'follow_token_needed'
  | AgentAppAttention;

type Button =
  | { label: string; url: string }
  | { label: string; action: string; value: string };

interface Copy {
  text(names: AgentAppNames): string;
  buttons(links: AgentAppLinks, names: AgentAppNames): Button[];
}

/** Try again on something that is not an add: a Cancel's removal, or turning a removed app's group back on. */
const tryAgain = (links: AgentAppLinks): Button => ({ label: 'Try again', action: TRY_AGAIN_ACTION, value: links.agentId });
/** Picks an add up where it stopped and goes on to Slack's Allow. */
const add = (links: AgentAppLinks, label: string): Button[] => links.addUrl ? [{ label, url: links.addUrl }] : [];
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
    buttons: (links) => add(links, 'Try again'),
  },
  ambiguous_create: {
    text: ({ name }) =>
      `Slack may have created an app for ${name}, but Chickpea didn't hear back. Open Your Apps in Slack and delete any ${name} app you don't recognize, then choose Try again.`,
    buttons: (links) => [yourApps, ...add(links, 'Try again')],
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
    buttons: (links) => add(links, 'Try again'),
  },
  /** The app exists; Slack refused the update that points its events and clicks at Chickpea. */
  urls_refused: {
    text: ({ name }) => `Slack didn't finish connecting ${name}'s app to Chickpea. Wait a minute, then choose Try again.`,
    buttons: (links) => add(links, 'Try again'),
  },
  slack_busy: {
    text: () => 'Slack is limiting how fast apps are set up. Wait a minute, then choose Try again.',
    buttons: (links) => add(links, 'Try again'),
  },
  permission_needed: {
    text: permissionNeededCopy,
    buttons: (links) => openAdmin(links.adminUrl),
  },
  config_token_needed: {
    text: ({ name }) => `Chickpea needs a new Slack refresh token to finish ${name}'s app. Paste one, then choose Continue.`,
    buttons: (links) => [...(links.tokenPageUrl ? [{ label: 'Paste a new token', url: links.tokenPageUrl }] : []), ...add(links, 'Continue')],
  },
  /** A live app: Slack refused the definition made from the Agent's new name, handle or description, so the app shows the earlier ones. */
  update_refused: {
    text: ({ name }) =>
      `Slack didn't accept the changes to ${name}, so its Slack app still shows its earlier name, handle or description. ${name} keeps answering as before. Change ${name} in Chickpea Admin, or choose Try again.`,
    buttons: (links) => [...openAdmin(links.adminUrl), tryAgain(links)],
  },
  /** A live app: Slack refused the update for another reason, or kept not answering. */
  update_failed: {
    text: ({ name }) =>
      `Chickpea couldn't update ${name}'s Slack app with its latest name, handle or picture. ${name} keeps answering as before. Choose Try again.`,
    buttons: (links) => [tryAgain(links)],
  },
  /** Live apps wait for the workspace's token. Told once for all of them, so it names no Agent. */
  follow_token_needed: {
    text: () =>
      "Chickpea needs a Slack token to update your Agents' Slack apps with their latest names, handles and pictures. They keep answering as before. Paste a new token, and Chickpea updates them.",
    buttons: (links) => links.tokenPageUrl ? [{ label: 'Paste a new token', url: links.tokenPageUrl }] : [],
  },
  /** Another Agent in Slack holds the handle, so nothing was created. */
  handle_taken: {
    text: ({ name, handle }) =>
      `Another Agent is using @${handle} in Slack, or is being added with it, so Chickpea didn't create ${name}'s app. Rename ${name} in Chickpea Admin, then add it again.`,
    buttons: (links) => openAdmin(links.adminUrl),
  },
  /** Removed, and its user group is back on. */
  app_removed: {
    text: ({ name, handle }) =>
      `${name}'s Slack app was removed from this workspace. People can still mention @${handle}, and ${name} answers through Chickpea. Choose Add ${name} to Slack to add the app back.`,
    buttons: (links, names) => add(links, `Add ${names.name} to Slack`),
  },
  /** Removed, and its user group is back on under the handle it had, refused the Agent's: the Agent needs another handle, or its app back. */
  app_removed_handle_kept: {
    text: ({ name, handle, refusedHandle }) =>
      `${name}'s Slack app was removed from this workspace. Its user group couldn't take the handle @${refusedHandle}, so people can mention @${handle} instead, and ${name} answers through Chickpea. Give ${name} another handle in Chickpea Admin, or choose Add ${name} to Slack to add the app back.`,
    buttons: (links, names) => [...add(links, `Add ${names.name} to Slack`), ...openAdmin(links.adminUrl)],
  },
  /** Removed, with no user group to answer @handle: none to turn back on, or Slack refused. */
  app_removed_unreachable: {
    text: (names) => `${removedUnreachable(names)} Choose Add ${names.name} to Slack to add the app back.`,
    buttons: (links, names) => add(links, `Add ${names.name} to Slack`),
  },
  /** Removed, and Slack refused to turn the user group back on for want of the Owner's permission. */
  app_removed_permission: {
    text: (names) =>
      `${removedUnreachable(names)} To bring back @${names.handle} without the app, choose Update in Slack in Chickpea Admin, then choose Try again. Or choose Add ${names.name} to Slack to add the app back.`,
    buttons: (links, names) => [...add(links, `Add ${names.name} to Slack`), ...openAdmin(links.adminUrl), tryAgain(links)],
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
  /** Slack refused the delete and says the app does not exist, as when someone already deleted it in Slack. */
  archived_not_found: {
    text: ({ name }) =>
      `${name} is archived. Chickpea couldn't find its Slack app to delete it. If ${name} still appears in Your Apps in Slack, you can delete it there.`,
    buttons: () => [yourApps],
  },
  /** An Owner cancelled before Allow and Chickpea could not delete the app it had created. */
  cancel_left: {
    text: ({ name }) =>
      `Chickpea couldn't delete the Slack app it made for ${name}, so delete ${name} in Your Apps in Slack. ${name} keeps answering as it did before.`,
    buttons: () => [yourApps],
  },
  /** An Owner cancelled before Allow, and Slack refused the delete and says the app it made does not exist. */
  cancel_not_found: {
    text: ({ name }) =>
      `Chickpea couldn't find the Slack app it made for ${name} to delete it. If ${name} still appears in Your Apps in Slack, you can delete it there. ${name} keeps answering as it did before.`,
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

/**
 * The private answer to Add to Slack on a message an earlier build posted,
 * whose button was an action: an Owner gets the link that adds the Agent now.
 * Mrkdwn; the name is escaped.
 */
export function addPressReply(kind: 'gone' | 'owner_needed' | 'link', names?: AgentAppNames, addUrl?: string): string {
  const name = escapeMrkdwn(names?.name ?? '');
  switch (kind) {
    case 'gone':
      return 'That Agent no longer exists.';
    case 'owner_needed':
      return `A workspace Owner needs to add ${name} to Slack.`;
    case 'link':
      return `<${addUrl}|Add ${name} to Slack>`;
  }
}

/** Finish setting up pressed while the host does not let Chickpea create or change apps: nothing was done. */
export function pausedReply(names: Pick<AgentAppNames, 'name'>): string {
  const name = escapeMrkdwn(names.name);
  return `Adding Slack apps is paused, so Chickpea can't finish ${name}'s Slack app now. ${name} keeps answering as it does now.`;
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

/** Add to Slack as an action, on messages posted before it became a link; it is answered with the link. */
export const START_APP_ACTION = 'agent_app_start';
export const FINISH_APP_ACTION = 'agent_app_finish';
/** A link button's own ID: Slack still reports its press, which nothing acts on. */
export const ADD_LINK_ACTION = 'agent_app_add_link';
/** A sequence that has not moved for this long shows "Finish setting up". */
export const STALLED_AFTER_MS = 2 * 60_000;

export type AgentAppHomeRow =
  | { kind: 'setting_up' }
  /** `add` for an add on its way to Allow, which the hand-off page picks up; otherwise a switch or a removal. */
  | { kind: 'stalled'; add?: true }
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
  waiting: ({ handle }: AgentAppNames) => `@${handle}'s Slack app is ready to add. Choose Allow in Slack to finish.`,
  active: ({ handle }: AgentAppNames) => `@${handle} has its own Slack app. People can message @${handle} directly.`,
  attention: ({ handle }: AgentAppNames) => `@${handle}'s Slack app needs your attention. Open your messages with Chickpea for details.`,
  removing: ({ handle }: AgentAppNames) => `Removing the Slack app Chickpea made for @${handle}.`,
  removing_stalled: ({ handle }: AgentAppNames) => `Removing the Slack app Chickpea made for @${handle} stopped partway.`,
} satisfies Record<Exclude<AgentAppHomeRow['kind'], 'active_untold'>, (names: AgentAppNames) => string>;

/** The Owner's App Home line under an Agent, with its one control: a link to the hand-off page for an add. */
export function agentAppHomeBlocks(row: AgentAppHomeRow, names: AgentAppNames, agentId: string, addUrl?: string): object[] {
  const button = (text: string, extra: Record<string, unknown>) => ({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text: clampDisplay(text, BUTTON_TEXT_MAX) }, ...extra }],
  });
  const text = row.kind === 'active_untold' ? agentAppSwitchedMessage(names, row.report).text : escapeMrkdwn(HOME_COPY[row.kind](names));
  const line = { type: 'context', elements: [{ type: 'mrkdwn', text }] };
  if (addUrl && row.kind === 'waiting') return [line, button('Allow in Slack', { action_id: ADD_LINK_ACTION, url: addUrl })];
  if (addUrl && row.kind === 'stalled' && row.add) return [line, button('Finish setting up', { action_id: ADD_LINK_ACTION, url: addUrl })];
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
