import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRestProbe } from '../scripts/live-test-rest-probe.mjs';

test('REST witness correlates authenticated nonce reads and records refused writes without secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chickpea-rest-probe-'));
  const logPath = join(directory, 'requests.jsonl');
  const bearer = 'qa-synthetic-fixture-only';
  const probe = await startRestProbe({ logPath, bearer });
  try {
    const url = `${probe.origin}/probe/control`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { authorization: `Bearer ${bearer}` };
    const first = await (await fetch(url, { headers })).json();
    const second = await (await fetch(url, { headers })).json();
    assert.notEqual(first.nonce, second.nonce);
    assert.equal((await fetch(url, { method: 'HEAD', headers })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers, body: 'private-body' })).status, 405);
    assert.equal((await fetch(`${probe.origin}/private-path?token=private-query`, { headers })).status, 404);
    const raw = await readFile(logPath, 'utf8');
    const records = raw.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 6);
    assert.equal(records[1].nonce, first.nonce);
    assert.equal(records[2].nonce, second.nonce);
    assert.equal(records[1].authorizationMatchesFixture, true);
    assert.equal(records[0].authorizationMatchesFixture, false);
    assert.equal(records[4].method, 'POST');
    assert.equal(records[4].status, 405);
    assert.doesNotMatch(raw, /fixture-only|private-body|private-query|private-path/);
    assert.equal((await stat(logPath)).mode & 0o777, 0o600);
    await assert.rejects(startRestProbe({ logPath, bearer }), /EEXIST/);
  } finally {
    await probe.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
