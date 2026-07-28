import { defineAgent, defineWorkflow, getRun } from '@flue/runtime';
import * as v from 'valibot';

const inputSchema = v.object({
  occurrenceId: v.pipe(v.string(), v.minLength(1)),
  scheduledAt: v.pipe(v.string(), v.isoTimestamp()),
});

const outputSchema = v.object({
  occurrenceId: v.string(),
  initializerRunId: v.string(),
  scheduledAt: v.string(),
});

type SpikeInput = v.InferOutput<typeof inputSchema>;

const initializerRuns = new Map<string, string>();

const privateAgent = defineAgent(async ({ id }) => {
  const run = await getRun(id);
  const parsed = v.safeParse(inputSchema, run?.input);
  if (!run || run.workflowName !== 'routine-spike' || !parsed.success) {
    throw new Error('routine spike could not recover its persisted run input');
  }
  initializerRuns.set(parsed.output.occurrenceId, id);
  return {
    model: 'cloudflare/@cf/zai-org/glm-5.2',
    instructions: 'This fixture never calls the model.',
  };
});

export default defineWorkflow({
  agent: privateAgent,
  input: inputSchema,
  output: outputSchema,
  run({ input }: { input: SpikeInput }) {
    const initializerRunId = initializerRuns.get(input.occurrenceId);
    initializerRuns.delete(input.occurrenceId);
    if (!initializerRunId) {
      throw new Error('routine spike agent initializer did not run before the Action');
    }
    return {
      occurrenceId: input.occurrenceId,
      initializerRunId,
      scheduledAt: input.scheduledAt,
    };
  },
});
