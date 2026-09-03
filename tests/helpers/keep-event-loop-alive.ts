import type { TestContext } from 'node:test';

// AbortSignal.timeout uses an unreferenced timer. A mocked pending request has
// no socket to keep Node 22 alive until that signal fires. Pair this helper
// with a finite test timeout so a missing abort still fails the test.
export function keepEventLoopAlive(context: TestContext): void {
  const timer = setInterval(() => {}, 1_000);
  context.after(() => clearInterval(timer));
}
