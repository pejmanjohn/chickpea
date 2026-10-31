import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { AgentModelAttribution } from '../config/types.ts';
import { classifySkillReplacement } from '../slack/interaction-intent.ts';
import { recordSideCallUsage } from '../usage/runtime-recorder.ts';
import type { UsageStore } from '../usage/types.ts';

/** What the service asks: the person's message, the skills it would replace, and the turn that pays. */
export interface SkillReplacementQuestion {
  text: string;
  skillNames: string[];
  /** The routed Agent's model. */
  model: string;
  modelAttribution: AgentModelAttribution;
  turn: {
    workspaceId: string;
    channelId: string;
    eventId: string;
    messageTs?: string | undefined;
    conversationKind?: 'channel' | 'im' | 'mpim' | undefined;
    routedAgentId: string;
    routedAgentName: string;
    /** The Agent the upload changes; one judgment per message and target. */
    targetAgentId: string;
    requesterMembershipId: string;
  };
}

/**
 * One side call per question, metered against the Slack turn the way the
 * typed-approval judge is. A usage write that fails never changes the answer.
 */
export function createSkillReplacementJudge(dependencies: {
  env?: PlatformEnv | undefined;
  settings: SettingsStore;
  usage: () => UsageStore;
  classify?: typeof classifySkillReplacement;
}): (question: SkillReplacementQuestion) => Promise<boolean> {
  const { env, settings } = dependencies;
  const classify = dependencies.classify ?? classifySkillReplacement;
  return async ({ text, skillNames, model, modelAttribution, turn }) => {
    const judgment = await classify({ text, skillNames, requestedModel: model }, { env, settings });
    try {
      const store = dependencies.usage();
      const credential = await resolveModelCredentialAttribution(model, env, settings, store);
      const direct = turn.conversationKind === 'im' || turn.conversationKind === 'mpim';
      const startedAt = Number(turn.messageTs) * 1_000;
      await recordSideCallUsage({
        operationId: `skill_replacement:${turn.workspaceId}:${turn.channelId}:${turn.eventId}:${turn.targetAgentId}`,
        executionId: `skill_replacement-exec:${turn.eventId}:${turn.targetAgentId}`,
        startedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : Date.now(),
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        channelLabel: direct ? 'Direct message' : turn.channelId,
        conversationKind: direct ? 'direct_message' : 'named_channel',
        agentId: turn.routedAgentId,
        agentLabel: turn.routedAgentName,
        requestedModel: model,
        requesterMembershipId: turn.requesterMembershipId,
        executionPrincipalId: turn.routedAgentId,
        modelAttribution,
        credentialRefId: credential?.credentialRefId ?? null,
        credentialVersion: credential?.version ?? null,
        store,
        ...(env ? { platformEnv: env } : {}),
      }, judgment);
    } catch {
      console.warn('[chickpea] skill replacement judgment usage was not recorded');
    }
    return judgment.replace;
  };
}
