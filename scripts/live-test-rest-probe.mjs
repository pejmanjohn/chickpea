import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Disposable provider witness. Never records headers, query strings, or bodies. */
export async function startRestProbe({ logPath, bearer, port = 0, timeoutMs = 600_000 }) {
  if (!isAbsolute(logPath)) throw new Error('Use an absolute private log path.');
  const directory = realpathSync(dirname(logPath));
  let inRepository = false;
  try {
    execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' });
    inRepository = true;
  } catch { /* A private directory outside Git is expected. */ }
  if (inRepository) throw new Error('Probe logs must be outside Git repositories.');
  if (!/^qa-synthetic-[A-Za-z0-9_-]{8,100}$/.test(bearer ?? '')) throw new Error('Use a qa-synthetic- test bearer, never a real credential.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new Error('Probe lifetime must be at most 30 minutes.');
  const fd = openSync(logPath, 'wx', 0o600);
  let requests = 0;
  let stopped = false;
  let timer;
  const server = createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];
    const marker = /^\/probe\/([A-Za-z0-9_-]{1,80})$/.exec(path)?.[1];
    const method = request.method ?? 'UNKNOWN';
    const authorizationMatchesFixture = request.headers.authorization === `Bearer ${bearer}`;
    const status = !marker ? 404 : !authorizationMatchesFixture ? 401 : !['GET', 'HEAD'].includes(method) ? 405 : 200;
    const nonce = status === 200 ? randomUUID() : undefined;
    try {
      appendFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), method, marker: marker ?? null, status, authorizationPresent: !!request.headers.authorization, authorizationMatchesFixture, ...(nonce ? { nonce } : {}) })}\n`);
    } catch {
      response.writeHead(500).end();
      void stop();
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(method === 'HEAD' ? undefined : JSON.stringify(nonce ? { nonce, method, marker } : { error: status === 401 ? 'unauthorized' : status === 405 ? 'method_not_allowed' : 'not_found' }));
    request.resume();
    if (++requests >= 100) void stop();
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 16;
  const stop = () => new Promise((resolve) => {
    if (stopped) return resolve();
    stopped = true;
    clearTimeout(timer);
    server.close(() => { closeSync(fd); resolve(); });
    server.closeAllConnections();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  timer = setTimeout(() => void stop(), timeoutMs);
  timer.unref();
  return { origin: `http://127.0.0.1:${server.address().port}`, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { log: { type: 'string' }, 'expect-bearer': { type: 'string' }, port: { type: 'string', default: '0' } } });
  const probe = await startRestProbe({ logPath: values.log ?? '', bearer: values['expect-bearer'], port: Number(values.port) });
  console.log(JSON.stringify({ origin: probe.origin, lifetimeMs: 600_000, maxRequests: 100 }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void probe.stop());
}
