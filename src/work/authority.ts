import { envValue } from '../config/env-value.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import type { EgressPolicy } from '../config/egress.ts';
import type { RunCoordinatorKind, RunExecutionAuthority } from './types.ts';

export const LEDGER_CANARY_CHANNELS_KEY = 'SLACK_TAG_LEDGER_CANARY_CHANNELS';

const SLACK_ID = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const MAX_CANARY_BINDINGS = 20;

export interface InteractiveExecutionAuthority {
  authority: RunExecutionAuthority;
  coordinatorKind: Extract<RunCoordinatorKind, 'interactive'>;
  authorityEpoch: number;
}

export interface SlackExecutionAuthorityInput {
  workspaceId: string;
  channelId: string;
  assignment: ResolvedAssignment;
  /** Live installation-wide network policy. Missing policy must never opt in. */
  egressPolicy?: EgressPolicy;
  /** Explicit Memory/Routine controls still use their established legacy coordinators. */
  legacyOnlyTurn?: boolean;
  env?: Record<string, unknown>;
}

/**
 * Exact, default-off selector for the internal ledger canary. The setting is
 * intentionally deployment-owned rather than mutable agent/profile state so
 * removing it is an immediate future-admission rollback. Existing Runs retain
 * their immutable authority and drain under the artifact that admitted them.
 */
export function selectSlackExecutionAuthority(
  input: SlackExecutionAuthorityInput,
): InteractiveExecutionAuthority {
  const legacy: InteractiveExecutionAuthority = {
    authority: 'legacy',
    coordinatorKind: 'interactive',
    authorityEpoch: 1,
  };
  if (input.legacyOnlyTurn) return legacy;
  if (!input.egressPolicy ||
      !ledgerCanarySupportsAssignment(input.assignment, input.egressPolicy)) return legacy;
  const configured = envValue(input.env, LEDGER_CANARY_CHANNELS_KEY);
  if (!configured) return legacy;
  const selected = configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_CANARY_BINDINGS)
    .some((entry) => {
      const [workspaceId, channelId, extra] = entry.split('/');
      return extra === undefined &&
        SLACK_ID.test(workspaceId ?? '') &&
        SLACK_ID.test(channelId ?? '') &&
        workspaceId === input.workspaceId &&
        channelId === input.channelId;
    });
  return selected
    ? { authority: 'ledger', coordinatorKind: 'interactive', authorityEpoch: 1 }
    : legacy;
}

/**
 * U8 canaries stay read-only until both Agent and Workflow tool paths emit
 * paired durable action receipts. The receipt boundary exists, but enabling a
 * connector or coding workspace before it is wired would make recovery unsafe.
 */
export function ledgerCanarySupportsAssignment(
  assignment: ResolvedAssignment,
  egressPolicy: EgressPolicy,
): boolean {
  const agent = assignment.agent;
  // Any configured internet reach can cross an unreceipted external effect
  // boundary (the base network includes POST in open mode). Keep the v1 canary
  // limited to the default empty allowlist or fully-off network policy.
  return egressPolicy.mode !== 'open' && egressPolicy.domains.length === 0 &&
    !agent.mcpServers.some((connection) =>
    connection.enabled && connection.allowedTools.length > 0
  ) &&
    !agent.apiConnections.some((connection) => connection.enabled) &&
    !agent.repositories.some((repository) => repository.enabled);
}
