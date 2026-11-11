import type { SlackMember } from '../../src/slack/transport/types.ts';

/** Slack's record of a full member of `teamId`, as users.info gives it, with `extra` over it. */
export function slackMember(id: string, teamId: string, extra: Partial<SlackMember> = {}): SlackMember {
  return {
    id, teamId, deleted: false, bot: false, appUser: false, restricted: false, ultraRestricted: false, stranger: false,
    timezone: 'Europe/Paris', ...extra,
  };
}
