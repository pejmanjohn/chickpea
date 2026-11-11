import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

import type { AgentObjectNamespace } from '../../src/slack/bounded-agent-observation.ts';

/**
 * An agent's Durable Object namespace whose instance was cut: the first stub
 * is bound to the cut instance, and its reads never answer until cancelled,
 * as `fetch` rejects then. Every later stub reaches the live instance, which
 * `serve` answers.
 */
export function cutAgentObject(serve: (request: Request) => Response | Promise<Response>) {
  let stubs = 0;
  const namespace: AgentObjectNamespace = {
    idFromName: (name) => name,
    get: () => {
      const cut = stubs === 0;
      stubs += 1;
      return {
        fetch: async (request) => {
          if (!cut) return serve(request);
          return new Promise<Response>((_, reject) => {
            request.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
          });
        },
      };
    },
  };
  return { namespace, stubs: () => stubs };
}

/**
 * Runs `call` with the timer clock under the test's control, and moves it
 * past the 10 s stalled-read deadline until the call settles: at most three
 * times, the reads a view keeps in flight.
 */
export async function acrossStalledReads<T>(t: TestContext, call: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = call();
  pending.then(() => { settled = true; }, () => { settled = true; });
  for (let stall = 0; stall < 3 && !settled; stall += 1) {
    t.mock.timers.tick(10_000);
    for (let turn = 0; turn < 50 && !settled; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(settled, 'a read through a new stub answered the stalled one');
  return pending;
}
