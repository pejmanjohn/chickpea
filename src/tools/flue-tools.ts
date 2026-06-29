import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

import { seededChannelBriefs } from '../config/seed.ts';

export function createLookupChannelBriefTool() {
  return defineTool({
    name: 'lookup_channel_brief',
    description: 'Look up the configured brief for the Slack channel bound to this agent session.',
    input: v.object({
      channelId: v.string(),
    }),
    output: v.object({
      brief: v.string(),
    }),
    async run({ input }) {
      return {
        brief: seededChannelBriefs[input.channelId] ?? 'No configured channel brief is available.',
      };
    },
  });
}
