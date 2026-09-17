import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
// @ts-expect-error Installer runtime ships plain JavaScript.
import { checkPublicRoute, ngrokFailureHint, renderNgrokConfig, validateNgrokOrigin, watchNgrokOutput } from '../scripts/lib/node-ngrok.mjs';

test('ngrok only accepts a stable provider hostname and rejects credential/config injection', () => {
  assert.equal(validateNgrokOrigin('https://assigned.ngrok-free.app/'), 'https://assigned.ngrok-free.app');
  for (const value of ['https://localhost', 'https://ngrok-free.app.evil.test', 'https://',
    'https://assigned.ngrok-free.app/path', 'https://assigned.ngrok-free.app:4430',
    'https://name:secret@assigned.ngrok-free.app', 'https://assigned.ngrok-free.app?x=1']) {
    assert.throws(() => validateNgrokOrigin(value));
  }
  for (const token of ['', 'ngrok config add-authtoken abc', 'abc\nweb_addr: 0.0.0.0:4040', 'a'.repeat(513)]) {
    assert.throws(() => renderNgrokConfig(token), /authtoken/);
  }
  const config = renderNgrokConfig('test-token');
  assert.match(config, /web_addr: false/);
  assert.match(config, /remote_management: false/);
  assert.doesNotMatch(config, /endpoints:|tunnels:|traffic_policy:/);
});

test('provider output can echo secrets, but only recognized actionable messages leave the parser', () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages: string[] = [];
  watchNgrokOutput({ stdout, stderr }, (message: string) => messages.push(message));
  stdout.write('authtoken=do-not-print URL=https://private.example\nERR_NG');
  stdout.write('ROK_105\n');
  stderr.write('do-not-print ERR_NGROK_105 ERR_NGROK_334\n');
  stderr.write('ERR_NGROK_727 ERR_NGROK_725\n');
  stderr.write('unrecognized ERR_NGROK_99999 do-not-print\n');
  assert.equal(messages.length, 4);
  assert.match(messages.join('\n'), /authtoken is invalid/);
  assert.match(messages.join('\n'), /already online/);
  assert.match(messages.join('\n'), /usage or traffic limit/);
  assert.doesNotMatch(messages.join('\n'), /do-not-print|private.example|99999/);
  assert.equal(ngrokFailureHint('do-not-print'), undefined);
});

test('tunnel readiness requires the exact configured URL and upstream in this child output', () => {
  const stdout = new PassThrough();
  let ready = 0;
  watchNgrokOutput({ stdout }, () => undefined, { origin: 'https://assigned.ngrok-free.app', port: 39217,
    onReady: () => { ready++; } });
  stdout.write(JSON.stringify({ msg: 'started tunnel', url: 'https://other.ngrok-free.app', addr: 'http://127.0.0.1:39217' }) + '\n');
  stdout.write(JSON.stringify({ msg: 'started tunnel', url: 'https://assigned.ngrok-free.app', addr: 'http://127.0.0.1:3000' }) + '\n');
  assert.equal(ready, 0);
  const event = JSON.stringify({ msg: 'started tunnel', url: 'https://assigned.ngrok-free.app', addr: 'http://127.0.0.1:39217' });
  stdout.write(event.slice(0, 20));
  stdout.write(event.slice(20) + '\n');
  assert.equal(ready, 1);
});

test('ngrok 3.39.11 structured upstream logs identify only the configured loopback listener', () => {
  const stdout = new PassThrough();
  let ready = 0;
  watchNgrokOutput({ stdout }, () => undefined, { origin: 'https://assigned.ngrok-free.dev', port: 39217,
    onReady: () => { ready++; } });
  const upstream = { Scheme: 'http', Opaque: '', User: null, Host: '127.0.0.1:39217',
    Path: '', Fragment: '', RawQuery: '', RawPath: '', RawFragment: '', ForceQuery: false, OmitHost: false };
  const emit = (addr: unknown, url = 'https://assigned.ngrok-free.dev') => stdout.write(
    JSON.stringify({ msg: 'started tunnel', addr, url }) + '\n');
  emit({ ...upstream, Host: '127.0.0.1:3000' });
  emit({ ...upstream, Host: 'other.example:39217' });
  emit({ ...upstream, Scheme: 'https' });
  emit({ ...upstream, Path: '/other-service' });
  emit({ ...upstream, User: { Username: 'unexpected' } });
  emit({ ...upstream, RawQuery: 'unexpected=1' });
  emit(upstream, 'https://other.ngrok-free.dev');
  emit(null);
  assert.equal(ready, 0);
  emit(upstream);
  assert.equal(ready, 1);
});

test('public verification rejects HTML warnings, redirects, wrong services and provider quota errors', async () => {
  const installation = { origin: 'https://assigned.ngrok-free.app', port: 39217 };
  const requests: Array<{ url: string; options: RequestInit }> = [];
  let remote = () => new Response('asset', { headers: { 'content-type': 'text/javascript' } });
  const fetchImpl = async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    return url.startsWith('http:') ? new Response('asset', { headers: { 'content-type': 'text/javascript' } }) : remote();
  };
  assert.equal((await checkPublicRoute(installation, fetchImpl)).reachable, true);
  assert.equal(requests[0]!.url, 'http://127.0.0.1:39217/admin/setup/client.js');
  assert.equal(requests[1]!.options.redirect, 'manual');
  assert.equal((requests[1]!.options.headers as Record<string, string>)['ngrok-skip-browser-warning'], '1');
  for (const response of [
    () => new Response('<html>Visit Site</html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response('asset', { status: 302, headers: { location: 'https://unrelated.example' } }),
    () => new Response('not found', { status: 404 }),
    () => new Response('wrong asset', { headers: { 'content-type': 'text/javascript' } }),
    () => new Response('x'.repeat(256 * 1024 + 1)),
  ]) {
    remote = response;
    const result = await checkPublicRoute(installation, fetchImpl);
    assert.equal(result.localReachable, true);
    assert.equal(result.reachable, false);
  }
  remote = () => new Response('provider quota secret', { status: 429, headers: { 'ngrok-error-code': 'ERR_NGROK_727' } });
  const quota = await checkPublicRoute(installation, fetchImpl);
  assert.equal(quota.reachable, false);
  assert.match(quota.hint, /usage or traffic limit/);
  assert.doesNotMatch(quota.hint, /secret/);
});
