import { resolveGithubAppBotUser } from '../config/github-app.ts';
import type { SettingsStore } from '../config/settings-store.ts';

/**
 * The Git author and committer a coding workspace commits as. It is preset by
 * the Sandbox Durable Object whenever a workspace activates, so a model never
 * invents one. It is identity only: credentials stay at the egress boundary
 * and never enter Git configuration.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Used when no GitHub App bot user resolves (no App connected yet, or GitHub
 * could not be reached). The reserved `.invalid` domain can never belong to a
 * GitHub account, so these commits are never attributed to a stranger.
 */
export const NEUTRAL_GIT_IDENTITY: GitIdentity = {
  name: 'Chickpea',
  email: 'chickpea@noreply.invalid',
};

// GitHub App slugs are lowercase alphanumerics and hyphens.
const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;

/**
 * The GitHub App's bot account as a Git identity. GitHub links a commit to the
 * bot (its login and the App's logo as avatar) only through the
 * `<user id>+<login>@users.noreply.github.com` address.
 */
export function githubAppBotGitIdentity(slug: string, botUserId: number): GitIdentity {
  if (!GITHUB_APP_SLUG_PATTERN.test(slug)) throw new Error('Invalid GitHub App slug');
  if (!Number.isSafeInteger(botUserId) || botUserId < 1) {
    throw new Error('Invalid GitHub App bot user id');
  }
  const login = `${slug}[bot]`;
  return { name: login, email: `${botUserId}+${login}@users.noreply.github.com` };
}

/** One shell command that writes the identity to the container's global Git config. */
export function gitIdentityConfigCommand(identity: GitIdentity): string {
  return [
    `git config --global user.name ${shellQuote(identity.name)}`,
    `git config --global user.email ${shellQuote(identity.email)}`,
  ].join(' && ');
}

function shellQuote(value: string): string {
  // Control characters could break out of a config value; no valid identity has one.
  if (value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid Git identity value');
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The installation's workspace identity: the GitHub App bot when it resolves,
 * otherwise the neutral Chickpea identity. Never throws.
 */
export async function resolveWorkspaceGitIdentity(
  settings: SettingsStore,
  fetchImpl: typeof fetch = fetch,
): Promise<GitIdentity> {
  try {
    const botUser = await resolveGithubAppBotUser(settings, fetchImpl);
    if (botUser) return githubAppBotGitIdentity(botUser.slug, botUser.id);
  } catch {
    // Settings or a malformed slug: commit under the neutral identity.
  }
  return NEUTRAL_GIT_IDENTITY;
}
