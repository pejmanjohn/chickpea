interface SlackIdentityProfile {
  displayName: string | undefined;
  avatarUrl: string | undefined;
  appId: string | undefined;
}

/** Presentation-only fields from a Slack users.info user payload. */
export function readSlackIdentityProfile(rawUser: unknown): SlackIdentityProfile {
  const user = recordValue(rawUser);
  const profile = recordValue(user.profile);
  return {
    displayName:
      stringValue(profile.display_name) ??
      stringValue(profile.real_name) ??
      stringValue(user.name),
    avatarUrl:
      stringValue(profile.image_512) ??
      stringValue(profile.image_192) ??
      stringValue(profile.image_72),
    appId: stringValue(profile.api_app_id),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
