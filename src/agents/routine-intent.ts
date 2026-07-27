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
      'Classify and normalize one Slack message that may create or edit a scheduled Chickpea routine.',
      'You have no tools and must never execute, promise, or simulate the requested task.',
      'Return exactly one JSON object and no Markdown.',
      'Use action "none" for questions, examples, quoted text, vague discussion, one-time reminders, or any message that is not a clear request to create/edit recurring work.',
      'For create/edit, preserve the user task faithfully. Do not add actions or side effects they did not request.',
      'Translate recurrence to a standard five-field cron expression. Never use seconds, macros, or a frequency shorter than one hour.',
      'Use an explicit IANA time zone when supplied; otherwise use UTC and set timezoneWasDefaulted true.',
      'outputPolicy is "post_on_change" only when the user explicitly asks to post only when something changed; otherwise use "post".',
      'Shape: {"action":"none"|"create"|"edit","routineId"?:string,"name"?:string,"description"?:string,"taskText"?:string,"scheduleExpression"?:string,"timezone"?:string,"timezoneWasDefaulted"?:boolean,"outputPolicy"?:"post"|"post_on_change"}.',
    ].join('\n'),
  };
});
