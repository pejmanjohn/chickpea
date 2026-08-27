import type { SlackUserFacts } from './credentials.ts';

export type MemorySlackUserClass =
  | 'eligible_human'
  | 'chickpea_bot'
  | 'guest'
  | 'foreign'
  | 'bot_or_app'
  | 'deleted'
  | 'unknown';

export function classifyMemorySlackUser(
  user: SlackUserFacts | undefined,
  workspaceId: string,
  botUserId: string,
): MemorySlackUserClass {
  if (!user) return 'unknown';
  if (user.deleted) return 'deleted';
  if (user.id === botUserId && (user.bot || user.appUser)) return 'chickpea_bot';
  if (user.restricted || user.ultraRestricted || user.stranger) return 'guest';
  if (user.teamId !== undefined && user.teamId !== workspaceId) return 'foreign';
  if (user.bot || user.appUser) return 'bot_or_app';
  return 'eligible_human';
}

/**
 * Admission is stricter than memory's legacy classifier: the installing
 * workspace must be positively verified rather than inferred from a missing
 * team_id. Keeping this separate avoids changing existing memory semantics.
 */
export function classifySlackUserForAdmission(
  user: SlackUserFacts | undefined,
  workspaceId: string,
  botUserId: string,
): MemorySlackUserClass {
  const classified = classifyMemorySlackUser(user, workspaceId, botUserId);
  if (classified !== 'eligible_human') return classified;
  if (!user?.teamId) return 'unknown';
  return user.teamId === workspaceId ? 'eligible_human' : 'foreign';
}

/** Normalize the subset of a Web API users.info payload used for admission. */
export function slackWebClientUserFacts(raw: unknown): SlackUserFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const user = raw as Record<string, unknown>;
  if (typeof user.id !== 'string') return undefined;
  const profile = user.profile && typeof user.profile === 'object' && !Array.isArray(user.profile)
    ? user.profile as Record<string, unknown>
    : {};
  return {
    id: user.id,
    teamId: typeof user.team_id === 'string' ? user.team_id : undefined,
    ...(typeof profile.display_name === 'string' ? { displayName: profile.display_name } : {}),
    ...(typeof profile.email === 'string' ? { email: profile.email } : {}),
    ...(typeof user.tz === 'string' ? { timezone: user.tz } : {}),
    deleted: user.deleted === true,
    bot: user.is_bot === true,
    appUser: user.is_app_user === true,
    restricted: user.is_restricted === true,
    ultraRestricted: user.is_ultra_restricted === true,
    stranger: user.is_stranger === true,
  };
}
