import { readFileSync } from 'node:fs';

import type { BotIdentityConfig } from '../config/types.ts';

const DEFAULT_MANIFEST_URL = new URL('../../slack-app-manifest.json', import.meta.url);

export type IdentityNameState = 'match' | 'mismatch';
export type IdentityIconState = 'custom' | 'default' | 'unknown';

export interface IdentityCheckResult {
  name: IdentityNameState;
  icon: IdentityIconState;
  details: {
    appId?: string;
    botUserId: string;
    expectedName: string;
    liveName: string;
    iconUrl?: string;
    avatarPath: string;
    consoleUrl: string;
  };
}

export interface ManifestIdentity {
  name: string;
  description: string;
  botDisplayName: string;
}

interface IdentitySlackClient {
  auth: {
    test(): Promise<unknown>;
  };
  users: {
    info(args: { user: string }): Promise<unknown>;
  };
}

export function readManifestIdentity(manifestUrl: URL | string = DEFAULT_MANIFEST_URL): ManifestIdentity {
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as unknown;
  const displayInformation = getRecord(getRecord(manifest).display_information);
  const features = getRecord(getRecord(manifest).features);
  const botUser = getRecord(features.bot_user);

  const name = getString(displayInformation.name);
  const description = getString(displayInformation.description);
  const botDisplayName = getString(botUser.display_name);

  if (!name) {
    throw new Error('slack-app-manifest.json display_information.name is missing');
  }
  if (!description) {
    throw new Error('slack-app-manifest.json display_information.description is missing');
  }
  if (!botDisplayName) {
    throw new Error('slack-app-manifest.json features.bot_user.display_name is missing');
  }

  return { name, description, botDisplayName };
}

export function classifySlackIconUrl(iconUrl: string | undefined): IdentityIconState {
  if (!iconUrl) {
    return 'unknown';
  }

  let parsed: URL;
  try {
    parsed = new URL(iconUrl);
  } catch {
    return 'unknown';
  }

  if (parsed.hostname === 'avatars.slack-edge.com') {
    return 'custom';
  }
  if (
    parsed.hostname === 'a.slack-edge.com' &&
    (parsed.pathname.includes('/img/plugins/app/') || parsed.pathname.includes('/img/avatars/'))
  ) {
    return 'default';
  }
  if (parsed.hostname === 'secure.gravatar.com') {
    return 'default';
  }
  return 'unknown';
}

export async function checkIdentity(
  client: IdentitySlackClient,
  identity: BotIdentityConfig,
  expected: ManifestIdentity = readManifestIdentity(),
): Promise<IdentityCheckResult> {
  const auth = getRecord(await client.auth.test());
  const botUserId = getString(auth.user_id);
  if (!botUserId) {
    throw new Error('Slack auth.test did not return user_id');
  }

  const userInfo = getRecord(await client.users.info({ user: botUserId }));
  const user = getRecord(userInfo.user);
  const profile = getRecord(user.profile);
  const liveName = getString(profile.display_name) || getString(profile.real_name) || getString(user.name);
  const iconUrl =
    getString(profile.image_512) ||
    getString(profile.image_192) ||
    getString(profile.image_72) ||
    undefined;
  const appId = getString(auth.app_id) || getString(profile.api_app_id) || undefined;

  return {
    // Users see the bot-user display name on messages; the Slack app manifest's
    // display_information.name is a separate identity field.
    name: liveName === expected.botDisplayName ? 'match' : 'mismatch',
    icon: classifySlackIconUrl(iconUrl),
    details: {
      ...(appId ? { appId } : {}),
      botUserId,
      expectedName: expected.botDisplayName,
      liveName,
      ...(iconUrl ? { iconUrl } : {}),
      avatarPath: identity.avatarPath,
      consoleUrl: appId
        ? `https://api.slack.com/apps/${appId}/general`
        : 'https://api.slack.com/apps',
    },
  };
}

function getRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
