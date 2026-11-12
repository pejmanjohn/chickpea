import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import { resolveSlackPublicUrl } from '../slack/credentials.ts';
import type { SlackCredentialResolutionDependencies } from '../slack/installation-credentials.ts';
import { resolveSlackInstallationExecutionContext } from '../slack/installation-execution.ts';
import type { WorkspaceManagementServiceInput } from './service.ts';

/**
 * A DM schedule's Slack, through the installation bot every DM schedule run
 * posts with (routines/runtime.ts): the same DM, then the same name and
 * picture its runs post under (routines/delivery.ts). The bot token comes
 * from `credentials`, the store the deployment keeps it in; a settings store
 * holds none on a direct installation, which every hosted one is.
 */
export function liveScheduleThreads(
  env: PlatformEnv | undefined,
  config: ConfigStore,
  settings: SettingsStore,
  credentials: SlackCredentialResolutionDependencies,
): NonNullable<WorkspaceManagementServiceInput['directScheduleThreads']> {
  const client = async (workspaceId: string) => {
    const execution = await resolveSlackInstallationExecutionContext(workspaceId, env, {
      config,
      settings,
      credentialDependencies: credentials,
    });
    if (execution.workspaceId !== workspaceId) throw new Error('The Slack installation is for another workspace.');
    return execution.client;
  };
  return {
    async open({ workspaceId, slackUserId }) {
      const opened = await (await client(workspaceId)).conversations.open({ users: slackUserId });
      const channel = opened.channel as { id?: unknown; is_im?: unknown; is_mpim?: unknown } | undefined;
      if (!opened.ok || typeof channel?.id !== 'string' || channel.is_im === false || channel.is_mpim === true) {
        throw new Error('Slack did not open the DM.');
      }
      return channel.id;
    },
    async start({ workspaceId, conversationId, agent, text }) {
      const avatarUrl = agentAvatarUrlForPresentation(
        agent,
        await resolveSlackPublicUrl(env, settings).catch(() => undefined),
        agentAvatarInstallation(env),
      );
      const posted = await (await client(workspaceId)).chat.postMessage({
        channel: conversationId,
        text,
        username: agent.name,
        ...(avatarUrl ? { icon_url: avatarUrl } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!posted.ok || !posted.ts) throw new Error('Slack did not post the schedule thread.');
      return posted.ts;
    },
    async withdraw({ workspaceId, conversationId, threadTs }) {
      await (await client(workspaceId)).chat.delete({ channel: conversationId, ts: threadTs });
    },
  };
}
