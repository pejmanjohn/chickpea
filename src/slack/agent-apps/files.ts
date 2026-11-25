import type { RuntimePlanV2 } from '../../agents/runtime-plan.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import { createSlackAttachmentClient, readDirectSlackAttachment } from '../attachment-client.ts';
import type { GatewayAttachmentClient } from '../gateway/client.ts';
import { ownBotClient } from './live.ts';
import { storedRunSpeaker } from './place.ts';

/**
 * Reads a run's Slack files as the bot the run speaks as. A file shared in an
 * Agent app's own DM, or in a private Channel only that app's bot is in, is
 * visible to that bot alone, so a run whose admission chose it reads with its
 * token, and fails as its run does when that app can no longer answer. Every
 * other run reads through the installation, as before.
 */
export function runAttachmentClient(
  env: PlatformEnv | undefined,
  plan: Pick<RuntimePlanV2, 'agentId' | 'conversation'>,
  turnJobId: string | undefined,
): GatewayAttachmentClient {
  const { agentId, conversation: { workspaceId } } = plan;
  const installation = createSlackAttachmentClient(env);
  return {
    async readAttachment(fileId, maxBytes, signal, accept) {
      const speaker = turnJobId ? await storedRunSpeaker(env, turnJobId) : undefined;
      const token = (await ownBotClient(env, workspaceId, agentId, speaker))?.token;
      if (!token) return installation.readAttachment(fileId, maxBytes, signal, accept);
      return readDirectSlackAttachment({
        fileId, maxBytes, token, workspaceId, ...(signal ? { signal } : {}), ...(accept ? { accept } : {}),
      });
    },
  };
}
