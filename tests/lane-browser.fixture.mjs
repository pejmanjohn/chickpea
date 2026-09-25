/**
 * A fake Chromium for lane-browser tests. It speaks the --remote-debugging-pipe
 * protocol (NUL-terminated JSON on fds 3 and 4), keeps cookies as plain JSON in
 * the user data directory so a test can read what was "persisted", and records
 * its argv and the CHICKPEA_* variable names it received.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dataDir = args.find((argument) => argument.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
if (!dataDir) { process.stderr.write('fake chromium: missing --user-data-dir\n'); process.exit(3); }
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'fake-argv.json'), JSON.stringify(args));
writeFileSync(join(dataDir, 'fake-env.json'), JSON.stringify(Object.keys(process.env).filter((name) => name.startsWith('CHICKPEA_')).sort()));
if (process.env.FAKE_CHROMIUM_CRASH === '1') { process.stderr.write('fake chromium: crashed on purpose\n'); process.exit(21); }

const store = join(dataDir, 'fake-cookies.json');
let cookies = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
// Replies are synchronous writes to fd 4, so exiting right after one can never lose it.
const reply = (id, body) => writeSync(4, `${JSON.stringify({ id, ...body })}\0`);

function handle({ id, method, params }) {
  if (method === 'Browser.getVersion') return reply(id, { result: { product: 'FakeChromium/1' } });
  if (method === 'Storage.setCookies') {
    if (process.env.FAKE_CHROMIUM_REJECT_COOKIES === '1') return reply(id, { error: { code: -32602, message: 'Invalid cookie fields' } });
    for (const cookie of params.cookies) {
      cookies = cookies.filter((existing) => !(existing.name === cookie.name && existing.domain === cookie.domain));
      cookies.push({ ...cookie, expires: cookie.expires ?? -1 });
    }
    writeFileSync(store, JSON.stringify(cookies));
    return reply(id, { result: {} });
  }
  if (method === 'Storage.getCookies') return reply(id, { result: { cookies } });
  if (method === 'Browser.close') {
    reply(id, { result: {} });
    process.exit(0);
  }
  return reply(id, { error: { code: -32601, message: `Unknown method ${method}` } });
}

let buffer = '';
createReadStream(null, { fd: 3 }).on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    handle(message);
  }
});
