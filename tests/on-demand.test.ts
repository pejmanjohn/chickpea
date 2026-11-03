import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CapabilityNotLoadedError, onDemand, type Loaded } from '../src/runtime/on-demand.ts';

test('require() names the capability until a load resolves, then returns what loaded', async () => {
  const detail = onDemand('connector detail github', async () => ({ toolkit: 'github' }));
  assert.throws(() => detail.require(), (error: unknown) =>
    error instanceof CapabilityNotLoadedError && error.capability === 'connector detail github' &&
    /connector detail github/.test(error.message));
  const loading = detail.load();
  assert.throws(() => detail.require(), CapabilityNotLoadedError, 'a pending load is not loaded');
  const loaded = await loading;
  assert.equal(detail.require(), loaded);
  assert.equal(await detail.load(), loaded);
});

test('concurrent loads share one import', async () => {
  let imports = 0;
  const detail = onDemand('shared', async () => {
    imports += 1;
    return { imports };
  });
  const [first, second] = await Promise.all([detail.load(), detail.load()]);
  assert.equal(first, second);
  await detail.load();
  assert.equal(imports, 1);
});

test('a failed import is not cached, whether it rejects or throws', async () => {
  let attempts = 0;
  const detail = onDemand('flaky', () => {
    attempts += 1;
    if (attempts === 1) throw new Error('chunk fetch failed');
    if (attempts === 2) return Promise.reject(new Error('chunk evaluation failed'));
    return Promise.resolve({ attempts });
  });
  const thrown = detail.load();
  assert.ok(thrown instanceof Promise, 'a synchronous throw still rejects');
  await assert.rejects(thrown, /fetch failed/);
  assert.throws(() => detail.require(), CapabilityNotLoadedError);
  await assert.rejects(detail.load(), /evaluation failed/);
  assert.deepEqual({ ...await detail.load() }, { attempts: 3 });
});

test('synchronous code that takes Loaded<T> refuses a value that skipped the load', async () => {
  const detail = onDemand('typed', async () => ({ label: 'GitHub' }));
  const label = (value: Loaded<{ label: string }>) => value.label;
  const plain = { label: 'GitHub' };
  // @ts-expect-error A plain value never came from load() or require().
  label(plain);
  assert.equal(label(await detail.load()), 'GitHub');
});
