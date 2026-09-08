import { createServer } from 'node:net';

let cachedLoopbackSkipReason: Promise<string | undefined> | undefined;

// The loopback-dependent suites (Lane B parity, fake-Slack HTTP, live-identity)
// skip when a sandbox denies listen(127.0.0.1), so a local run stays green. That
// is dangerous in CI: a silently-skipped Lane B means a parity regression ships
// unnoticed. Set TAG_REQUIRE_LOOPBACK=1 in CI so a would-be skip becomes a hard
// failure instead — the suite must actually run where it can.
export async function loopbackListenSkipReason(): Promise<string | undefined> {
  cachedLoopbackSkipReason ??= probeLoopbackListen();
  const reason = await cachedLoopbackSkipReason;
  if (reason && process.env.TAG_REQUIRE_LOOPBACK === '1') {
    throw new Error(
      `TAG_REQUIRE_LOOPBACK=1 but ${reason}. These suites must run here — do not let them skip silently.`,
    );
  }
  return reason;
}

function probeLoopbackListen(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        resolve(`loopback listen unavailable in this environment (${err.code})`);
        return;
      }
      resolve(undefined);
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(undefined));
    });
  });
}
