import { createHash } from 'node:crypto';

import { resolveAgentModel } from '../config/model-policy.ts';
import type { AgentSnapshot, ResolvedAssignment } from '../config/types.ts';
import { effectiveSlackIdentityId } from '../slack/identity-admission.ts';
import type {
  SafeEffectiveConfigInput,
  SourceVisibility,
} from './types.ts';

export function safeConfigForAssignment(
  assignment: ResolvedAssignment,
  sourceVisibility: Exclude<SourceVisibility, 'unknown'>,
): SafeEffectiveConfigInput {
  const agent = assignment.agent;
  const skillNames = agent.skills.filter((skill) => skill.enabled).map((skill) => skill.name);
  const connectionIds = [
    ...agent.mcpServers
      .filter((connection) => connection.enabled && connection.lifecycleStatus === 'ready')
      .map((connection) => connection.id),
    ...agent.apiConnections
      .filter(
        (connection) =>
          connection.enabled &&
          (connection.lifecycleStatus === undefined || connection.lifecycleStatus === 'ready'),
      )
      .map((connection) => connection.id),
  ];
  const repositoryIds = agent.repositories
    .filter((repository) => repository.enabled)
    .map((repository) => repository.id);
  const configuredModel = assignment.model ?? resolveAgentModel(agent);
  const snapshotDigest = isSnapshot(assignment)
    ? assignment.snapshotHash
    : digest({
        profileId: assignment.agentId,
        configuredModel,
        instructions: agent.instructions,
        skillNames,
        connectionIds,
        repositoryIds,
      });
  const capabilityDigest = digest({ skillNames, connectionIds, repositoryIds });
  return {
    schemaVersion: 1,
    profileId: assignment.agentId,
    slackIdentityId: effectiveSlackIdentityId(assignment),
    configuredModel,
    snapshotDigest,
    capabilityDigest,
    skillNames,
    connectionIds,
    repositoryIds,
    memoryMode: sourceVisibility,
    ceilings: {
      maxModelAttempts: 20,
      maxToolCalls: 1_000,
      // U1 could not prove a universal side-effect interception/attempt bound.
      // Shadow admission therefore records the release-safe action ceiling.
      maxActionAttempts: 0,
      timeoutMs: 15 * 60_000,
    },
  };
}

export function opaqueId(prefix: string, value: string): string {
  return `${prefix}_${digest(value).slice(0, 40)}`;
}

function isSnapshot(assignment: ResolvedAssignment): assignment is AgentSnapshot {
  return typeof (assignment as Partial<AgentSnapshot>).snapshotHash === 'string';
}

function digest(value: unknown): string {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  return createHash('sha256').update(bytes).digest('hex');
}
