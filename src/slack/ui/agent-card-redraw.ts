import type { WebClient } from '@slack/web-api';

import {
  getConfigStore,
  getSettingsStore,
  getSlackCredentialResolutionDependencies,
  getSlackStateStore,
  type PlatformEnv,
} from '../../config/state-backend.ts';
import { withAgentAppExecution } from '../agent-apps/index.ts';
import { resolveSlackInstallationExecutionContext } from '../installation-execution.ts';
import { createSlackReadGate } from '../read-budget.ts';
import { readCardSetMessage, redrawCardSet } from './card-set-message.ts';
import type { UiSurfaceRecord } from './surface.ts';

/**
 * update_card's redraw, from inside the Agent's run. It edits as the bot that
 * posted the answer (the Agent's own app while it is live, else the
 * installation's), reads the answer back within the shared read budget, and
 * binds the message it found so a later redraw reads it by timestamp.
 */
export async function redrawCardSetAsAgent(
  env: PlatformEnv | undefined,
  agentId: string,
  surface: UiSurfaceRecord,
): Promise<boolean> {
  const installation = (workspaceId: string) => resolveSlackInstallationExecutionContext(workspaceId, env, {
    config: getConfigStore(env),
    settings: getSettingsStore(env),
    credentialDependencies: getSlackCredentialResolutionDependencies(env),
    rejectRateLimitedCalls: true,
  });
  const bot = await withAgentAppExecution(installation, env, { rejectRateLimitedCalls: true })(surface.workspaceId, agentId);
  const state = getSlackStateStore(env);
  const gate = createSlackReadGate({ state, workspaceId: surface.workspaceId, gated: bot.sharedAppReads });
  return redrawCardSet({
    surface,
    message: async () => {
      const message = await readCardSetMessage(bot.client, gate, surface);
      if (message && !surface.messageTs) {
        await state.executeUiSurface?.({ kind: 'bind_surface_message', id: surface.id, messageTs: message.ts });
      }
      return message;
    },
    update: async (ts, rendered) => {
      await bot.client.chat.update({
        channel: surface.channelId, ts, ...rendered,
      } as unknown as Parameters<WebClient['chat']['update']>[0]);
    },
  });
}
