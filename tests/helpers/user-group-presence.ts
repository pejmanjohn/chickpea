import type { AgentSlackPresence, UserGroupPresence } from '../../src/config/types.ts';

/** The user-group presence a test stamps group fields over; an Agent that has its own Slack app fails the test. */
export function asUserGroup(presence: AgentSlackPresence | undefined): UserGroupPresence {
  if (!presence) throw new Error('expected a Slack presence');
  if (presence.kind === 'agent_app') throw new Error('expected a user-group presence, not an Agent app');
  return presence;
}
