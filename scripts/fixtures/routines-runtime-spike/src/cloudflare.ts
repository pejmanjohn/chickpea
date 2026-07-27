import { getRun, invoke, listRuns } from '@flue/runtime';

import routineSpike from './workflows/routine-spike.ts';

interface SpikeScheduledController {
  scheduledTime: number;
}

const VISIBILITY_TIMEOUT_MS = 5_000;

export default {
  async scheduled(controller: SpikeScheduledController): Promise<void> {
    const admittedAt = Date.now();
    const receipt = await invoke(routineSpike, {
      input: {
        occurrenceId: `scheduled-${controller.scheduledTime}`,
        scheduledAt: new Date(controller.scheduledTime).toISOString(),
      },
    });

    let record = await getRun(receipt.runId);
    let listed = false;
    while (Date.now() - admittedAt < VISIBILITY_TIMEOUT_MS) {
      const page = await listRuns({ workflowName: 'routine-spike', limit: 100 });
      listed = page.runs.some((run) => run.runId === receipt.runId);
      record ??= await getRun(receipt.runId);
      if (listed && record) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    console.log(
      'ROUTINE_SPIKE_RECEIPT',
      JSON.stringify({
        runId: receipt.runId,
        visibilityMs: Date.now() - admittedAt,
        listed,
        recordVisible: Boolean(record),
      }),
    );
  },
};
