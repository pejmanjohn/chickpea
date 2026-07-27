import { getRun, listRuns } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

const SPIKE_TOKEN = 'routine-spike-internal-token';

const app = new Hono();

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

app.route('/', flue());

export default app;
