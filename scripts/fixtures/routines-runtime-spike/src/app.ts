import { getRun, listRuns } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const SPIKE_TOKEN = 'routine-spike-internal-token';

interface RoutineStateSpikeStub {
  exercise(suffix: string, at: number): Promise<{
    routineId: string;
    version: number;
    auditCount: number;
    revisionCount: number;
  }>;
}

interface SpikeBindings {
  ROUTINE_STATE_SPIKE: {
    getByName(name: string): RoutineStateSpikeStub;
  };
}

const app = new Hono<{ Bindings: SpikeBindings }>();

app.use('/spike/*', async (c, next) => {
  if (c.req.header('x-routine-spike-token') !== SPIKE_TOKEN) {
    return c.json({ error: 'not_found' }, 404);
  }
  await next();
});

app.get('/spike/runs', async (c) => {
  const runs = await listRuns({ workflowName: 'routine-spike', limit: 100 });
  return c.json(runs);
});

app.get('/spike/runs/:runId', async (c) => {
  const run = await getRun(c.req.param('runId'));
  return run ? c.json(run) : c.json({ error: 'not_found' }, 404);
});

app.post('/spike/state', async (c) => {
  try {
    const body = await c.req.json<{ suffix: string; at: number }>();
    const result = await c.env.ROUTINE_STATE_SPIKE.getByName('singleton').exercise(
      body.suffix,
      body.at,
    );
    return c.json(result);
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});

app.route('/', flue());

export default app;
