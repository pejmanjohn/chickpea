export const SLACK_APP_NAME_MAX_LENGTH = 35;
export const SLACK_BOT_DISPLAY_NAME_MAX_LENGTH = 80;

interface SlackManifestCore {
  display_information: { name: string; [key: string]: unknown };
  features: {
    bot_user: { display_name: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  oauth_config: unknown;
  settings: {
    event_subscriptions: {
      request_url: string;
      bot_events: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type SlackManifestSource = SlackManifestCore & { $schema?: string };

export type SlackIdentityManifest = SlackManifestCore & {
  $schema?: never;
};

export interface SlackIdentityManifestIntent {
  appName: string;
  botDisplayName: string;
  requestUrl: string;
}

/**
 * Clone the committed Slack manifest and change only the fields that make one
 * dedicated app distinct. The committed file remains the single source for
 * scopes, Agent View, App Home, and every other Slack capability.
 */
export function buildSlackIdentityManifest(
  source: SlackManifestSource,
  intent: SlackIdentityManifestIntent,
): SlackIdentityManifest {
  const appName = requiredName(
    intent.appName,
    'Slack app name',
    SLACK_APP_NAME_MAX_LENGTH,
  );
  const botDisplayName = requiredName(
    intent.botDisplayName,
    'Slack bot display name',
    SLACK_BOT_DISPLAY_NAME_MAX_LENGTH,
  );
  const requestUrl = safeRequestUrl(intent.requestUrl);
  const cloned = structuredClone(source);
  delete cloned.$schema;

  cloned.display_information.name = appName;
  cloned.features.bot_user.display_name = botDisplayName;
  cloned.settings.event_subscriptions.request_url = requestUrl;
  const events = cloned.settings.event_subscriptions.bot_events;
  for (const lifecycleEvent of ['app_uninstalled', 'tokens_revoked']) {
    if (!events.includes(lifecycleEvent)) events.push(lifecycleEvent);
  }

  return cloned as SlackIdentityManifest;
}

export function slackManifestPrefillUrl(manifest: SlackIdentityManifest): string {
  const json = JSON.stringify(manifest);
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(json)}`;
}

function requiredName(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function safeRequestUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Slack Request URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Slack Request URL must use HTTPS');
  }
  return parsed.toString();
}
