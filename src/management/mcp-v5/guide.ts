import { z } from 'zod';

import {
  PLAYBOOK_TOPIC_ABOUT,
  PLAYBOOK_TOPICS,
  playbookSection,
  playbookTopic,
} from '../playbook/index.ts';

/**
 * `get_guide`: one section of the playbook (management/playbook), for a
 * client with no Chickpea skill loaded. A tool reaches every host, where a
 * resource or a prompt does not. The section is both the text block and
 * `structuredContent.guide`: Claude Code and ChatGPT read only the
 * structured result, and a client that passes only `content` to its model
 * is the kind that most needs the guide. So one result, both blocks
 * together, stays within GUIDE_RESULT_MAX_CHARACTERS (probes 13 and 14).
 */
export const GUIDE_RESULT_MAX_CHARACTERS = 28_000;

const zTopic = z.enum(PLAYBOOK_TOPICS);

export const getGuideInput = z.strictObject({
  topic: z.string().max(80).optional()
    .describe(`One of ${PLAYBOOK_TOPICS.join(', ')}. Omit it for the list of topics.`),
});

/** One flat object, not a union: MCP clients handle a bare anyOf poorly. */
export const getGuideOutput = z.strictObject({
  topic: zTopic.optional(),
  title: z.string().optional(),
  guide: z.string().optional().describe('The section in Markdown, with the ground rules every section shares.'),
  topics: z.array(z.strictObject({ topic: zTopic, title: z.string(), about: z.string() })).optional()
    .describe('Every topic, when the call named none or one the guide does not have.'),
  nextStep: z.string(),
});
type GuideResult = z.output<typeof getGuideOutput>;

const LIST_NEXT_STEP = 'Call get_guide again with the topic that fits the job.';
const UNKNOWN_NEXT_STEP = `The guide has no such topic. ${LIST_NEXT_STEP}`;
const SECTION_NEXT_STEP = 'Follow it step by step. When it names another topic, call get_guide with that topic.';

export function getGuide(args: z.output<typeof getGuideInput>): GuideResult {
  const topic = playbookTopic(args.topic);
  if (topic) return { topic, ...playbookSection(topic), nextStep: SECTION_NEXT_STEP };
  return {
    topics: PLAYBOOK_TOPICS.map((each) => ({
      topic: each,
      title: playbookSection(each).title,
      about: PLAYBOOK_TOPIC_ABOUT[each],
    })),
    nextStep: args.topic?.trim() ? UNKNOWN_NEXT_STEP : LIST_NEXT_STEP,
  };
}

/** The section itself, or the topics one line each. */
export function guideText(output: GuideResult): string {
  if (output.guide !== undefined) return output.guide;
  return [
    ...(output.topics ?? []).map(({ topic, about }) => `- ${topic}: ${about}`),
    output.nextStep,
  ].join('\n');
}
