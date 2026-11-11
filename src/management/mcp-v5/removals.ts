import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

import { archiveBeforeDeleting } from '../../slack/agent-presence/left-slack.ts';
import { ManagementError, type ApplyWorkspaceChangesResult, type ManagementActorContext } from '../types.ts';
import { agentSummary, applyChange, changeResult, requireVersion, type ChangeResult } from './changes.ts';
import { fail } from './conventions.ts';
import { agentVersion, connectedAppsLink, requireAgent, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';
import { editableAgent, grantRevision, readSchedule, slackTeamId } from './writes.ts';

/**
 * The 5.0 removals. Each sends one operation through the service, so
 * policy.ts decides which ones wait for the person's confirmation.
 */

type In<T extends z.ZodType> = z.output<T>;

export async function deleteAgent(deps: FiveZeroDeps, input: In<typeof schemas.deleteAgentInput>): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'delete_agent',
    args: input,
    operations: async () => {
      const snapshot = await deps.service.inspectWorkspace(context);
      const agent = requireAgent(snapshot, input.agentId);
      requireVersion(agentVersion(snapshot, agent), input.version, agent.name, 'get_agent');
      // Deleting disconnects every connection, and a team one is an Owner's or Admin's to disconnect.
      const team = snapshot.caller.role === 'member'
        ? (agent.connections ?? []).filter(({ ownerKind }) => ownerKind === 'team')
        : [];
      if (team.length) {
        fail('not_allowed', `Only an Owner or Admin can delete ${agent.name}: deleting it disconnects its team connection${team.length === 1 ? '' : 's'}, ${team.map(({ label }) => label).join(', ')}.`, {
          nextStep: 'Tell the person an Owner or Admin can delete it.',
        });
      }
      return [{ itemId: 'delete_agent', kind: 'delete_agent', agentId: agent.id, expectedRevision: agent.revision }];
    },
  });
  await refuseWhatBlocksDeletion(deps, context, result, input.agentId);
  return changeResult(deps, context, result, { agentId: input.agentId, summary: 'Deleted the Agent.' });
}

/**
 * The service checks an Agent left Slack, and that no recent thread uses it,
 * before it previews a deletion. Its refusal is said here as still_in_use,
 * with the Channels it answers in, so nobody learns it after confirming.
 * Archiving is the person's choice, never a step the model takes on its way
 * to a deletion they have not agreed to.
 */
async function refuseWhatBlocksDeletion(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  result: ApplyWorkspaceChangesResult,
  agentId: string,
): Promise<void> {
  const blocked = 'outcomes' in result
    ? result.outcomes.find(({ disposition, code }) => disposition === 'failed' && (code === 'invalid_request' || code === 'still_referenced'))
    : undefined;
  if (!blocked) return;
  const snapshot = await deps.service.inspectWorkspace(context);
  const agent = snapshot.agents.find(({ id }) => id === agentId);
  const channels = snapshot.channels
    .filter(({ grants }) => grants.some((grant) => grant.agentId === agentId))
    .map(({ channelId, label }) => `#${label ?? channelId}`);
  const inUse = agent?.lifecycle === 'archived' ? undefined : agent;
  const inSlack = blocked.code === 'still_referenced' ||
    (agent !== undefined && blocked.instruction === archiveBeforeDeleting(agent.name));
  fail('still_in_use', [
    blocked.instruction ?? 'The Agent cannot be deleted yet.',
    ...(channels.length ? [`It answers in ${channels.join(', ')}.`] : []),
    'Nothing was deleted.',
  ].join(' '), inSlack
    ? inUse
      ? {
          nextStep: 'Tell the person it must be archived first, which takes it out of its Slack Channels until restore_agent brings it back. Archive it only if they agree, then call delete_agent again with the version archiving returns.',
          fix: {
            label: `Archive ${inUse.name}`,
            tool: 'archive_agent',
            arguments: { agentId, version: agentVersion(snapshot, inUse), idempotencyKey: randomUUID() },
          },
        }
      : {}
    : {
        // A recent thread blocks it: only time clears that, and archiving does not.
        nextStep: `Tell the person when it can be deleted.${inUse
          ? ' If they want it to stop answering until then, offer archive_agent instead of deleting; call it only if they agree.'
          : ''}`,
      });
}

export async function removeWebsiteLogin(
  deps: FiveZeroDeps,
  input: In<typeof schemas.removeWebsiteLoginInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'remove_website_login',
    args: input,
    operations: async () => {
      const agent = await editableAgent(deps, context, input.agentId);
      return [{ itemId: 'remove_website_login', kind: 'remove_website_login', agentId: agent.id, loginId: input.loginId }];
    },
  });
  return changeResult(deps, context, result, { agentId: input.agentId, summary: 'Removed the website login.' });
}

/** The server reads the grant's revision, as add_agent_to_channel does. */
export async function removeAgentFromChannel(
  deps: FiveZeroDeps,
  input: In<typeof schemas.removeAgentFromChannelInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'remove_agent_from_channel',
    args: input,
    operations: async () => {
      const agent = await editableAgent(deps, context, input.agentId);
      const snapshot = await deps.service.inspectWorkspace(context);
      const revision = grantRevision(snapshot, input.channelId, agent.id);
      if (revision === 0) {
        fail('not_found', `${agent.name} does not answer in that Channel.`, { nextStep: 'Call get_agent for the Channels it answers in.' });
      }
      return [{
        itemId: 'remove_agent_from_channel',
        kind: 'revoke_agent_channel',
        workspaceId: slackTeamId(snapshot),
        channelId: input.channelId,
        agentId: agent.id,
        expectedRevision: revision,
      }];
    },
  });
  return changeResult(deps, context, result, { agentId: input.agentId, summary: 'The Agent no longer answers in the Channel.' });
}

export async function deleteSchedule(deps: FiveZeroDeps, input: In<typeof schemas.deleteScheduleInput>): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'delete_schedule',
    args: input,
    operations: async () => {
      const { workspaceId, schedule } = await readSchedule(deps, context, input.scheduleId, input.version);
      return [{
        itemId: 'delete_schedule',
        kind: 'delete_routine',
        workspaceId,
        ...(schedule.channelId ? { channelId: schedule.channelId } : {}),
        routineId: schedule.id,
        expectedVersion: schedule.version,
      }];
    },
  });
  return changeResult(deps, context, result, { summary: 'Deleted the schedule.' });
}

export async function removeModelProviderKey(
  deps: FiveZeroDeps,
  input: In<typeof schemas.removeModelProviderKeyInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'remove_model_provider_key',
    args: input,
    operations: async () => [{ itemId: 'remove_model_provider_key', kind: 'remove_provider_credential', providerId: input.provider }],
  });
  return changeResult(deps, context, result, { summary: 'Removed the key.' });
}

/** Owners only. A member is named by their Slack user, never by an internal ID. */
export async function updateMember(deps: FiveZeroDeps, input: In<typeof schemas.updateMemberInput>): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'update_member',
    args: input,
    operations: async () => {
      const { team } = await deps.service.inspectWorkspace(context);
      if (!team) {
        fail('not_allowed', 'Only an Owner can change someone\'s role or access.', {
          nextStep: 'Tell the person an Owner can change it on Admin\'s Team page.',
        });
      }
      const member = team.members.find(({ slackUserId }) => slackUserId === input.slackUserId);
      if (!member) fail('not_found', 'No one in this workspace has that slackUserId.', { nextStep: 'Call list_members for the current slackUserIds.' });
      return [{
        itemId: 'update_member',
        kind: 'update_member',
        membershipId: member.id,
        ...(input.role ? { role: input.role } : {}),
        ...(input.status ? { status: input.status } : {}),
      }];
    },
  });
  return changeResult(deps, context, result, { summary: 'Saved the member\'s role and access.' });
}

export async function cancelSetupLink(
  deps: FiveZeroDeps,
  input: In<typeof schemas.cancelSetupLinkInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  try {
    const { revoked, replacement } = await deps.service.revokeSetupLink(context, input.setupToken, input.sendNewLink === true);
    const what = revoked.target.targetLabel;
    const { agent } = await agentSummary(deps, context, revoked.target.agentId);
    if (!replacement) return { status: 'done', summary: `Cancelled the link for ${what}; it no longer opens.`, ...(agent ? { agent } : {}) };
    return {
      status: 'needs_setup',
      summary: `Cancelled the old link for ${what}. Open the new one to finish.`,
      nextStep: 'Give the person the new link.',
      ...(agent ? { agent } : {}),
      setup: { url: replacement.setupUrl, setupToken: replacement.setupOperationId, what },
    };
  } catch (error) {
    if (!(error instanceof ManagementError)) throw error;
    if (error.code === 'setup_not_found') {
      fail('not_found', 'No setup link of yours has that setupToken.', { nextStep: 'Use the setupToken a setup link came with.' });
    }
    if (error.code === 'setup_unavailable' || error.code === 'setup_expired') {
      fail('setup_link_unusable', 'That link was already used, cancelled or expired, or is being finished, so it cannot be cancelled.', {
        nextStep: 'Call get_setup_status with its setupToken to see where it stands.',
      });
    }
    throw error;
  }
}

export async function disconnectApp(
  deps: FiveZeroDeps,
  input: In<typeof schemas.disconnectAppInput>,
): Promise<z.infer<typeof schemas.disconnectAppOutput>> {
  try {
    const revoked = await deps.service.revokeMcpClient(await deps.context(), input.appId);
    return {
      ...(revoked.name ? { name: revoked.name } : {}),
      thisApp: revoked.current,
      message: revoked.message,
      ...connectedAppsLink(deps),
    };
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'mcp_client_not_found') {
      fail('not_found', 'None of your connected apps has that appId.', { nextStep: 'Call list_connected_apps for the current appIds.' });
    }
    throw error;
  }
}
