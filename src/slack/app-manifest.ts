import { createHash } from 'node:crypto';

export const SLACK_APP_NAME_MAX_LENGTH = 35;
export const SLACK_BOT_DISPLAY_NAME_MAX_LENGTH = 80;
export const SLACK_BOT_OAUTH_CALLBACK_PATH = '/auth/slack/install/callback';
/**
 * Credential recovery's bot authorization returns here. Slack accepts a
 * redirect at or below a registered Redirect URL, so this sits under the bot
 * callback every app made from this manifest registers: an app that needs
 * recovery is one made before today, and a URL of its own would not be there.
 */
export const SLACK_RECOVERY_CALLBACK_PATH = `${SLACK_BOT_OAUTH_CALLBACK_PATH}/recovery`;
export const SLACK_OIDC_CALLBACK_PATH = '/auth/slack/oidc/callback';
export const SLACK_EVENTS_PATH = '/channels/slack/events';
export const SLACK_INTERACTIONS_PATH = '/channels/slack/interactions';
export const SLACK_REFERENCE_ORIGIN = 'https://chickpea.example';

export const SLACK_BOT_SCOPES = Object.freeze([
  'app_mentions:read', 'assistant:write', 'channels:history', 'channels:join',
  'channels:read', 'chat:write', 'chat:write.customize', 'files:read', 'files:write',
  'groups:history', 'groups:read',
  'im:history', 'im:write', 'mpim:read', 'reactions:read', 'reactions:write', 'users:read',
  'usergroups:read', 'usergroups:write', 'users:read.email',
  'lists:read', 'lists:write',
] as const);

const SHARED_BOT_EVENTS = Object.freeze([
  'agent_session_stopped',
  'app_context_changed', 'app_home_opened', 'app_mention', 'member_joined_channel',
  'message.channels', 'message.groups', 'message.im', 'reaction_added',
] as const);

/**
 * Bot events an app created from an earlier manifest may lack. Slack draws
 * the Stop button on a working Agent Session only for an app subscribed to
 * `agent_session_stopped` (it needs only `chat:write`); an app without it
 * keeps passing setup and recovery, and its people stop a run by typing
 * (R25). Recovery never adds one.
 */
export const SLACK_OPTIONAL_BOT_EVENTS: readonly string[] = Object.freeze(['agent_session_stopped']);

const CONTROL_PLANE_EVENTS = Object.freeze([
  ...SHARED_BOT_EVENTS, 'app_uninstalled', 'tokens_revoked', 'user_change',
] as const);

interface SlackAppManifestShape<Settings> {
  display_information: { name: string; description: string; background_color: string };
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    bot_user: { display_name: string; always_online: boolean };
    agent_view: {
      agent_description: string;
      suggested_prompts: Array<{ title: string; message: string }>;
    };
  };
  oauth_config: {
    redirect_urls?: string[];
    scopes: { bot: string[]; user?: string[] };
  };
  settings: Settings & {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    is_mcp_enabled: boolean;
  };
}

export interface SlackAppRequestUrls {
  events: string;
  interactions: string;
}

/** An app with its Request URLs, which Slack requires for event subscriptions and interactivity (Socket Mode is never on). */
export type SlackAppManifest = SlackAppManifestShape<{
  event_subscriptions: { request_url: string; bot_events: string[] };
  interactivity: { is_enabled: boolean; request_url: string };
}>;

/**
 * What creates an Agent's app. Its Request URLs name the app's ID, which only
 * the create answers, so it carries neither section; the first update adds both.
 */
export type SlackAppCreateManifest = SlackAppManifestShape<{ event_subscriptions?: never; interactivity?: never }>;

/** What an Agent's own Slack app subscribes to: its mentions, its DMs, its bot joining a Channel, and its own end. */
export const AGENT_APP_BOT_EVENTS: readonly string[] = Object.freeze([
  'app_mention', 'member_joined_channel', 'message.im', 'app_uninstalled', 'tokens_revoked',
]);
export const SLACK_APP_DESCRIPTION_MAX_LENGTH = 140;

/** One Agent's own app: no sign-in, its handle as the bot's name, its own scopes and events, no Home tab. */
export interface AgentAppManifestIntent {
  appName: string;
  /** The Agent's handle, which Slack's bot name allows (a-z, 0-9, `-`, `_`, `.`). */
  botDisplayName: string;
  description: string;
  redirectUri: string;
  scopes: readonly string[];
  events: readonly string[];
}

export type SlackAppManifestIntent =
  | {
      kind: 'workspace_app';
      origin: string;
      appName?: string;
      botDisplayName?: string;
    }
  | ({ kind: 'agent_app'; urls: SlackAppRequestUrls } & AgentAppManifestIntent);

/** Sole typed builder for the native Slack apps Chickpea creates: the workspace's, and an Agent's own. */
export function buildSlackAppManifest(intent: SlackAppManifestIntent): SlackAppManifest {
  if (intent.kind === 'agent_app') {
    return withRequestUrls(agentAppCreateManifest(intent), intent.urls, intent.events);
  }
  const origin = safeOrigin(intent.origin);
  return withRequestUrls(manifestCore({
    appName: requiredName(
      intent.appName ?? 'Chickpea', 'Slack app name', SLACK_APP_NAME_MAX_LENGTH,
    ),
    botDisplayName: requiredName(
      intent.botDisplayName ?? 'Chickpea',
      'Slack bot display name',
      SLACK_BOT_DISPLAY_NAME_MAX_LENGTH,
    ),
    description: 'A self-hosted, model-agnostic AI agent for Slack.',
    homeTab: true,
    includeOidc: true,
    redirectUrls: [
      `${origin}${SLACK_BOT_OAUTH_CALLBACK_PATH}`,
      `${origin}${SLACK_OIDC_CALLBACK_PATH}`,
    ],
  }), {
    events: `${origin}${SLACK_EVENTS_PATH}`,
    interactions: `${origin}${SLACK_INTERACTIONS_PATH}`,
  }, CONTROL_PLANE_EVENTS);
}

/** The manifest that creates an Agent's app, before its Request URLs exist. */
export function agentAppCreateManifest(intent: AgentAppManifestIntent): SlackAppCreateManifest {
  return manifestCore({
    appName: requiredName(intent.appName, 'Slack app name', SLACK_APP_NAME_MAX_LENGTH),
    botDisplayName: requiredName(intent.botDisplayName, 'Slack bot display name', SLACK_BOT_DISPLAY_NAME_MAX_LENGTH),
    description: requiredName(intent.description, 'Slack app description', SLACK_APP_DESCRIPTION_MAX_LENGTH),
    // Nothing publishes an Agent app's Home tab, so it would only ever be empty.
    homeTab: false,
    scopes: intent.scopes,
    includeOidc: false,
    redirectUrls: [intent.redirectUri],
  });
}

export function canonicalSlackAppManifest(): SlackAppManifest {
  return buildSlackAppManifest({ kind: 'workspace_app', origin: SLACK_REFERENCE_ORIGIN });
}

export function canonicalSlackAppManifestJson(): string {
  return `${JSON.stringify(canonicalSlackAppManifest(), null, 2)}\n`;
}

export function slackManifestPrefillUrl(manifest: SlackAppManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${
    encodeURIComponent(JSON.stringify(manifest))
  }`;
}

export function slackManifestFingerprint(manifest: SlackAppManifest | SlackAppCreateManifest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

/**
 * `manifest` subscribed to only those optional bot events that `subscribed`
 * names. Every other event keeps its place, so an earlier app's manifest (and
 * its stored fingerprint) is reproduced exactly.
 */
export function slackManifestWithOptionalEvents(
  manifest: SlackAppManifest,
  subscribed: readonly string[],
): SlackAppManifest {
  const result = structuredClone(manifest);
  result.settings.event_subscriptions.bot_events = result.settings.event_subscriptions.bot_events
    .filter((event) => !SLACK_OPTIONAL_BOT_EVENTS.includes(event) || subscribed.includes(event));
  return result;
}

/**
 * Validate the actual app contract without reflecting hostile manifest values.
 * An app may lack the optional bot events; the fingerprint is then that of the
 * expected manifest without them, which is what Slack holds.
 */
export function validateSlackAppManifest(
  actual: unknown,
  expected: SlackAppManifest,
): { fingerprint: string } {
  const held = slackManifestWithOptionalEvents(
    expected,
    stringArray(record(record(record(actual).settings).event_subscriptions).bot_events),
  );
  if (JSON.stringify(manifestContract(actual)) !== JSON.stringify(manifestContract(held))) {
    throw new Error('Slack app manifest does not match the expected callbacks, scopes, or events.');
  }
  return { fingerprint: slackManifestFingerprint(held) };
}

/** Recovery may change only this deployment's two OAuth URLs and Events URL. */
export function validateSlackAppManifestUrlRepair(
  actual: unknown,
  expected: SlackAppManifest,
): void {
  const candidate = structuredClone(actual) as Record<string, unknown>;
  const oauth = record(candidate.oauth_config);
  oauth.redirect_urls = [...(expected.oauth_config.redirect_urls ?? [])];
  candidate.oauth_config = oauth;
  const settings = record(candidate.settings);
  const subscriptions = record(settings.event_subscriptions);
  subscriptions.request_url = expected.settings.event_subscriptions.request_url;
  settings.event_subscriptions = subscriptions;
  const interactivity = record(settings.interactivity);
  interactivity.request_url = expected.settings.interactivity?.request_url;
  settings.interactivity = interactivity;
  candidate.settings = settings;
  validateSlackAppManifest(candidate, expected);
}

function manifestCore(input: {
  appName: string;
  botDisplayName: string;
  description: string;
  homeTab: boolean;
  scopes?: readonly string[];
  includeOidc: boolean;
  redirectUrls?: string[];
}): SlackAppCreateManifest {
  return {
    display_information: {
      name: input.appName,
      description: input.description,
      background_color: '#bd5732',
    },
    features: {
      app_home: {
        home_tab_enabled: input.homeTab,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: input.botDisplayName, always_online: true },
      agent_view: {
        agent_description: input.description,
        suggested_prompts: [
          {
            title: 'Summarize supplied text',
            message: 'Summarize the conversation or material I paste here.',
          },
          {
            title: 'Investigate a question',
            message: 'Investigate this question using only material I supply or you are authorized to access:',
          },
          { title: 'Plan a task', message: 'Help me plan this task:' },
        ],
      },
    },
    oauth_config: {
      ...(input.redirectUrls ? { redirect_urls: input.redirectUrls } : {}),
      scopes: {
        ...(input.includeOidc ? { user: ['openid', 'profile', 'email'] } : {}),
        bot: [...(input.scopes ?? SLACK_BOT_SCOPES)],
      },
    },
    settings: {
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: false,
    },
  };
}

/** The two sections lead `settings`, as they always have, so a workspace app's stored fingerprint still matches. */
function withRequestUrls(
  manifest: SlackAppCreateManifest,
  urls: SlackAppRequestUrls,
  botEvents: readonly string[],
): SlackAppManifest {
  return {
    ...manifest,
    settings: {
      event_subscriptions: { request_url: urls.events, bot_events: [...botEvents] },
      interactivity: { is_enabled: true, request_url: urls.interactions },
      ...manifest.settings,
    },
  };
}

function manifestContract(value: unknown): unknown {
  const manifest = record(value);
  const display = record(manifest.display_information);
  const features = record(manifest.features);
  const botUser = record(features.bot_user);
  const oauth = record(manifest.oauth_config);
  const scopes = record(oauth.scopes);
  const settings = record(manifest.settings);
  const subscriptions = record(settings.event_subscriptions);
  const appHome = record(features.app_home);
  const interactivity = record(settings.interactivity);
  return {
    appName: stringValue(display.name),
    botDisplayName: stringValue(botUser.display_name),
    redirectUrls: stringArray(oauth.redirect_urls),
    userScopes: stringArray(scopes.user).sort(),
    botScopes: stringArray(scopes.bot).sort(),
    requestUrl: stringValue(subscriptions.request_url),
    botEvents: stringArray(subscriptions.bot_events).sort(),
    appHomeEnabled: appHome.home_tab_enabled === true,
    interactivityEnabled: interactivity.is_enabled === true,
    interactivityUrl: stringValue(interactivity.request_url),
    // Slack materializes the omitted, opt-in setting as false when exporting.
    pkceEnabled: oauth.pkce_enabled ?? false,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? [...value]
    : [];
}

function requiredName(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function safeOrigin(value: string): string {
  const parsed = new URL(safeHttpsUrl(value, 'Slack app origin'));
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Slack app origin must not include a path, query, or fragment');
  }
  return parsed.origin;
}

function safeHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid HTTPS URL`); }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return parsed.toString();
}
