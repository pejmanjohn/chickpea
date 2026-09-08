import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { releaseTag, resolveOfficialRelease } from '../scripts/lib/upgrade-source.mjs';

test('only exact immutable official application releases are eligible', async () => {
  for (const tag of ['latest', 'cli-v0.1.0', 'v1.0.0-rc.1', 'v1.0.0;echo x', '../v1.0.0']) assert.throws(() => releaseTag(tag));
  const requests: string[] = [];
  const release = { tag_name: 'v0.1.1', immutable: true, draft: false, prerelease: false, html_url: 'https://github.com/pejmanjohn/chickpea/releases/tag/v0.1.1', published_at: '2026-09-07T00:00:00Z' };
  const fetchImpl = async (url: string, init: any) => {
    requests.push(url);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    return Response.json(url.includes('/releases/') ? release : { object: { type: 'commit', sha: 'a'.repeat(40) } });
  };
  assert.equal((await resolveOfficialRelease('v0.1.1', { fetchImpl })).commit, 'a'.repeat(40));
  assert.ok(requests.every((url) => url.startsWith('https://api.github.com/repos/pejmanjohn/chickpea/')));
  release.immutable = false;
  await assert.rejects(resolveOfficialRelease('v0.1.1', { fetchImpl }), /immutable/);
});
