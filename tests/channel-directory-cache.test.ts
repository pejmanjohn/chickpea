import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelDirectoryCache } from '../src/slack/channel-directory-cache.ts';

test('directory cache coalesces loads, isolates installation keys, expires and refreshes', async () => {
  let now = 0;
  let calls = 0;
  const cache = new ChannelDirectoryCache<number>(() => now, 60);
  const load = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('workspace:a:1', load), cache.get('workspace:a:1', load)]), [1, 1]);
  assert.equal(await cache.get('workspace:b:1', load), 2);
  assert.equal(await cache.get('workspace:a:2', load), 3);
  assert.equal(await cache.get('workspace:a:1', load, true), 4);
  assert.equal(await cache.get('workspace:a:1', load), 4);
  now = 61;
  assert.equal(await cache.get('workspace:a:1', load), 5);
});

test('failed discovery can retry and an older load cannot replace a forced refresh', async () => {
  const cache = new ChannelDirectoryCache<number>();
  await assert.rejects(cache.get('a', async () => { throw new Error('unavailable'); }));
  let finish!: (value: number) => void;
  const pending = cache.get('a', () => new Promise<number>(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.equal(await cache.get('a', async () => 2, true), 2);
  finish(1);
  assert.equal(await pending, 1);
  assert.equal(await cache.get('a', async () => 3), 2);
});
