import type {
  AgentAppLifecycle,
  AgentAppPresence,
  AgentPresenceDesiredState,
  AgentPresenceHealth,
  AgentSlackPresence,
} from '../../config/types.ts';

export type {
  AgentAppAttention,
  AgentAppIcon,
  AgentAppLifecycle,
  AgentAppPresence,
  AgentAppRecord,
  AgentAppResume,
} from '../../config/types.ts';

export type ActiveAgentApp = Extract<AgentAppLifecycle, { state: 'active' }>;

function desiredStateOf(app: AgentAppLifecycle): AgentPresenceDesiredState {
  switch (app.state) {
    case 'uninstalling':
      return 'disabled';
    case 'needs_attention':
      return app.resume === 'uninstalling' ? 'disabled' : 'active';
    default:
      return 'active';
  }
}

function healthOf(app: AgentAppLifecycle): AgentPresenceHealth {
  switch (app.state) {
    case 'active':
      return 'healthy';
    case 'needs_attention':
      return 'needs_attention';
    default:
      return 'pending';
  }
}

/** Read boundary: the stored flags never outrank the lifecycle they summarize. */
export function normalizeAgentAppPresence(stored: AgentAppPresence): AgentAppPresence {
  return { ...stored, desiredState: desiredStateOf(stored.app), health: healthOf(stored.app) };
}

export function agentAppIsLive(
  presence: AgentSlackPresence | undefined,
): presence is AgentAppPresence & { app: ActiveAgentApp } {
  return presence?.kind === 'agent_app' && presence.app.state === 'active';
}
