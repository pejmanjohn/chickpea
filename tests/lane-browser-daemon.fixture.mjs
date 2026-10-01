/**
 * A fake Chrome daemon for lane-browser tests. It takes Chrome's launch
 * arguments, marks the profile the way Chrome does (a SingletonLock symlink
 * named host-pid), answers `/json/version` on the requested debugging port,
 * and quits on SIGTERM. FAKE_DAEMON_SILENT=1 keeps the process alive without
 * ever listening, which is what a Chrome that failed to open its port looks like.
 */
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const read = (prefix) => args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const dataDir = read('--user-data-dir=');
const port = Number(read('--remote-debugging-port='));
if (!dataDir || !Number.isInteger(port)) { process.stderr.write('fake daemon: missing --user-data-dir or --remote-debugging-port\n'); process.exit(3); }
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'fake-daemon-argv.json'), JSON.stringify(args));
writeFileSync(join(dataDir, 'fake-daemon-env.json'), JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith('CHICKPEA_')).sort()));
const lock = join(dataDir, 'SingletonLock');
rmSync(lock, { force: true });
symlinkSync(`${hostname()}-${process.pid}`, lock);

const quit = () => { rmSync(lock, { force: true }); process.exit(0); };
process.on('SIGTERM', quit);
process.on('SIGINT', quit);

if (process.env.FAKE_DAEMON_SILENT === '1') {
  setTimeout(quit, 60_000);
} else {
  const server = createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ Browser: 'FakeChrome/1.0', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(port, '127.0.0.1');
}
