import type { WebClient } from '@slack/web-api';

import {
  getConfigStore,
  getSettingsStore,
  getSlackCredentialResolutionDependencies,
  getSlackStateStore,
  type PlatformEnv,
} from '../../config/state-backend.ts';
import { storedRunSpeaker, withAgentAppExecution } from '../agent-apps/index.ts';
import { resolveSlackInstallationExecutionContext } from '../installation-execution.ts';
import { createSlackReadGate } from '../read-budget.ts';
import { readCardSetMessage, redrawCardSet } from './card-set-message.ts';
import type { UiSurfaceRecord } from './surface.ts';

/**
 * update_card's redraw, from inside the Agent's run (`turnJobId`). It edits
 * as the bot that posted the answer: the speaker of the run that posted the
 * card while that run is pending, else this run's, which answers the same
 * Agent in the same thread and so was chosen by the same place. It redraws
 * from the set's copy of the answer, or reads it back within the shared read
 * budget when it has none.
 */
export async function redrawCardSetAsAgent(
  env: PlatformEnv | undefined,
  agentId: string,
  surface: UiSurfaceRecord,
  turnJobId: string,
): Promise<boolean> {
  const installation = (workspaceId: string) => resolveSlackInstallationExecutionContext(workspaceId, env, {
    config: getConfigStore(env),
    settings: getSettingsStore(env),
    credentialDependencies: getSlackCredentialResolutionDependencies(env),
    rejectRateLimitedCalls: true,
  });
  const speaker = await storedRunSpeaker(env, surface.turnJobId) ??
    (turnJobId === surface.turnJobId ? undefined : await storedRunSpeaker(env, turnJobId));
  const bot = await withAgentAppExecution(installation, env, { rejectRateLimitedCalls: true })(
    surface.workspaceId,
    { agentId, ...(speaker ? { speaker } : {}) },
  );
  const state = getSlackStateStore(env);
  return redrawCardSet({
    state,
    surface,
    read: () => readCardSetMessage(
      bot.client,
      createSlackReadGate({ state, workspaceId: surface.workspaceId, gated: bot.sharedAppReads }),
      surface,
    ),
    update: async (ts, rendered) => {
      await bot.client.chat.update({
        channel: surface.channelId, ts, ...rendered,
      } as unknown as Parameters<WebClient['chat']['update']>[0]);
    },
  });
}
