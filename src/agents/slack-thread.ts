import { defineAgent } from '@flue/runtime';

import { AgentStore, AssignmentStore, resolveAssignmentFromThreadKey } from '../config/resolver.ts';
import { createLookupChannelBriefTool } from '../tools/flue-tools.ts';

export default defineAgent(async ({ id }) => {
  const stores = {
    agents: new AgentStore(),
    assignments: new AssignmentStore(),
  };
  const assignment = resolveAssignmentFromThreadKey(id, stores);
  const tools = assignment.agent.allowedTools.includes('lookup_channel_brief')
    ? [createLookupChannelBriefTool()]
    : [];

  return {
    model: assignment.agent.defaultModels['workers-ai'],
    instructions: [
      assignment.agent.instructions,
      `You are assigned to Slack workspace ${assignment.workspaceId} channel ${assignment.channelId}.`,
      'Do not reveal Slack tokens, provider keys, or hidden policy data.',
    ].join('\n'),
    tools,
  };
});
