import { createHash } from 'node:crypto';

export const SLACK_APP_NAME_MAX_LENGTH = 35;
export const SLACK_BOT_DISPLAY_NAME_MAX_LENGTH = 80;
export const SLACK_BOT_OAUTH_CALLBACK_PATH = '/auth/slack/install/callback';
export const SLACK_OIDC_CALLBACK_PATH = '/auth/slack/oidc/callback';
export const SLACK_EVENTS_PATH = '/channels/slack/events';
export const SLACK_REFERENCE_ORIGIN = 'https://chickpea.example';

export const SLACK_BOT_SCOPES = Object.freeze([
  'app_mentions:read', 'assistant:write', 'channels:history', 'channels:join',
  'channels:read', 'chat:write', 'files:write', 'groups:history', 'groups:read',
  'im:history', 'mpim:read', 'reactions:read', 'reactions:write', 'users:read',
] as const);

const SHARED_BOT_EVENTS = Object.freeze([
  'app_context_changed', 'app_home_opened', 'app_mention', 'member_joined_channel',
  'message.channels', 'message.groups', 'message.im', 'reaction_added',
] as const);
const CONTROL_PLANE_EVENTS = Object.freeze([
  ...SHARED_BOT_EVENTS, 'app_uninstalled', 'tokens_revoked', 'user_change',
] as const);
const DEDICATED_BOT_EVENTS = Object.freeze([
  ...SHARED_BOT_EVENTS, 'app_uninstalled', 'tokens_revoked',
] as const);

export interface SlackAppManifest {
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
  settings: {
    event_subscriptions: { request_url: string; bot_events: string[] };
    interactivity?: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
    is_mcp_enabled: boolean;
  };
}

export type SlackAppManifestIntent =
  | { kind: 'control_plane'; origin: string; appName?: string; botDisplayName?: string }
  | {
      kind: 'dedicated_bot';
      appName: string;
      botDisplayName: string;
      requestUrl: string;
    };

export interface SlackIdentityManifestIntent {
  appName: string;
  botDisplayName: string;
  requestUrl: string;
}
export type SlackIdentityManifest = SlackAppManifest;

/** Sole typed builder for both the control-plane app and dedicated bot apps. */
export function buildSlackAppManifest(intent: SlackAppManifestIntent): SlackAppManifest {
  if (intent.kind === 'dedicated_bot') {
    return manifestCore({
      appName: requiredName(intent.appName, 'Slack app name', SLACK_APP_NAME_MAX_LENGTH),
      botDisplayName: requiredName(
        intent.botDisplayName, 'Slack bot display name', SLACK_BOT_DISPLAY_NAME_MAX_LENGTH,
      ),
      description: 'A dedicated Chickpea identity for Slack.',
      requestUrl: safeHttpsUrl(intent.requestUrl, 'Slack Request URL'),
      botEvents: [...DEDICATED_BOT_EVENTS],
      includeOidc: false,
    });
  }

  const origin = safeOrigin(intent.origin);
  return manifestCore({
    appName: requiredName(
      intent.appName ?? 'Chickpea', 'Slack app name', SLACK_APP_NAME_MAX_LENGTH,
    ),
    botDisplayName: requiredName(
      intent.botDisplayName ?? 'Chickpea',
      'Slack bot display name',
      SLACK_BOT_DISPLAY_NAME_MAX_LENGTH,
    ),
    description: 'A self-hosted, model-agnostic AI agent for Slack.',
    requestUrl: `${origin}${SLACK_EVENTS_PATH}`,
    botEvents: [...CONTROL_PLANE_EVENTS],
    includeOidc: true,
    redirectUrls: [
      `${origin}${SLACK_BOT_OAUTH_CALLBACK_PATH}`,
      `${origin}${SLACK_OIDC_CALLBACK_PATH}`,
    ],
  });
}

/** Backwards-compatible name for existing dedicated-identity callers. */
export function buildSlackIdentityManifest(
  _source: unknown,
  intent: SlackIdentityManifestIntent,
): SlackIdentityManifest {
  return buildSlackAppManifest({ kind: 'dedicated_bot', ...intent });
}

export function canonicalSlackAppManifest(): SlackAppManifest {
  return buildSlackAppManifest({ kind: 'control_plane', origin: SLACK_REFERENCE_ORIGIN });
}

export function canonicalSlackAppManifestJson(): string {
  return `${JSON.stringify(canonicalSlackAppManifest(), null, 2)}\n`;
}

export function slackManifestPrefillUrl(manifest: SlackAppManifest): string {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${
    encodeURIComponent(JSON.stringify(manifest))
  }`;
}

export function slackManifestFingerprint(manifest: SlackAppManifest): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

/** Validate the actual app contract without reflecting hostile manifest values. */
export function validateSlackAppManifest(
  actual: unknown,
  expected: SlackAppManifest,
): { fingerprint: string } {
  if (JSON.stringify(manifestContract(actual)) !== JSON.stringify(manifestContract(expected))) {
    throw new Error('Slack app manifest does not match the expected callbacks, scopes, or events.');
  }
  return { fingerprint: slackManifestFingerprint(expected) };
}

function manifestCore(input: {
  appName: string;
  botDisplayName: string;
  description: string;
  requestUrl: string;
  botEvents: string[];
  includeOidc: boolean;
  redirectUrls?: string[];
}): SlackAppManifest {
  return {
    display_information: {
      name: input.appName,
      description: input.description,
      background_color: '#fffdf6',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
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
        ...(input.includeOidc ? { user: ['openid', 'profile'] } : {}),
        bot: [...SLACK_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: { request_url: input.requestUrl, bot_events: input.botEvents },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
      is_mcp_enabled: false,
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
  return {
    appName: stringValue(display.name),
    botDisplayName: stringValue(botUser.display_name),
    redirectUrls: stringArray(oauth.redirect_urls),
    userScopes: stringArray(scopes.user).sort(),
    botScopes: stringArray(scopes.bot).sort(),
    requestUrl: stringValue(subscriptions.request_url),
    botEvents: stringArray(subscriptions.bot_events).sort(),
    pkceEnabled: oauth.pkce_enabled ?? null,
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
