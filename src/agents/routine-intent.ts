import { defineAgent, type AgentRouteHandler, type AgentRuntimeConfig } from '@flue/runtime';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { applyResolvedProviderKeys } from '../config/provider-keys.ts';
import { getConfigStore, type PlatformEnv } from '../config/state-backend.ts';
import { INTERNAL_AGENT_TOKEN_HEADER, isValidInternalAgentToken } from '../slack/internal-auth.ts';

const INTENT_ID = /^routine-intent:([A-Za-z0-9_-]{1,200}):([A-Za-z0-9_-]{1,200}):/;

export const route: AgentRouteHandler = async (c, next) => {
  if (!isValidInternalAgentToken(c.req.header(INTERNAL_AGENT_TOKEN_HEADER))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
};

export default defineAgent(async ({ id, env }): Promise<AgentRuntimeConfig> => {
  const match = id.match(INTENT_ID);
  if (!match) throw new Error('Routine intent scope is invalid.');
  const platformEnv = env as PlatformEnv;
  await applyResolvedProviderKeys(platformEnv);
  const store = getConfigStore(platformEnv);
  const config = await resolveEffectiveSlackConfig(match[1]!, match[2]!, {
    agents: store,
    assignments: store,
  });
  return {
    model: config.model,
    tools: [],
    instructions: [
      'Classify and normalize one Slack message that may create, edit, or manage scheduled Chickpea work.',
      'You have no tools and must never execute, promise, or simulate the requested task.',
      'Return exactly one JSON object and no Markdown.',
      'Use action "none" for questions, examples, vague discussion, or any message that is not a clear request to create, edit, or manage scheduled work.',
      'For create/edit, taskText must be copied verbatim as one contiguous span of the current Slack message (apart from surrounding whitespace). Do not paraphrase, change identifiers, append actions, or discard a negation or negative directive. A scheduling wrapper such as "Every day," may remain outside taskText.',
      'For recurring work, set triggerKind to "schedule" and translate recurrence to a standard five-field cron expression. Never use seconds, macros, or a frequency shorter than one hour.',
      'For one-time future work, set triggerKind to "once" and normalize scheduleExpression to an exact local YYYY-MM-DDTHH:mm value.',
      'Use an explicit IANA time zone when supplied; otherwise use the Default IANA time zone from the message and set timezoneWasDefaulted true.',
      'outputPolicy is "post_on_change" only when the user explicitly asks to post only when something changed; otherwise use "post".',
      'For show, pause, resume, disable, run, clone, or delete, return routineName exactly as the user wrote it and no task or schedule fields.',
      'Only return routineId when that literal ID appears in the current Slack message. Never guess or select an ID.',
      'For edit, omit taskText unless the user asked to change the task. Use routineName when the user identified the routine by name.',
      'Shape: {"action":"none"|"create"|"edit"|"show"|"pause"|"resume"|"disable"|"run"|"clone"|"delete","routineId"?:string,"routineName"?:string,"name"?:string,"description"?:string,"taskText"?:string,"triggerKind"?:"schedule"|"once","scheduleExpression"?:string,"timezone"?:string,"timezoneWasDefaulted"?:boolean,"outputPolicy"?:"post"|"post_on_change"}.',
    ].join('\n'),
  };
});
