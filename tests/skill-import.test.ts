import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseSkillSource,
  parseFrontmatter,
  sanitizeSkillName,
  resolveSkillSource,
  SkillImportError,
} from '../src/config/skill-import.ts';

test('parseSkillSource accepts shorthand, GitHub URLs, and skills.sh links', () => {
  assert.deepEqual(parseSkillSource('acme/skills'), { owner: 'acme', repo: 'skills' });
  assert.deepEqual(parseSkillSource('acme/skills@triage'), {
    owner: 'acme',
    repo: 'skills',
    skillFilter: 'triage',
  });
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills'), {
    owner: 'acme',
    repo: 'skills',
  });
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills.git'), {
    owner: 'acme',
    repo: 'skills',
  });
  assert.deepEqual(parseSkillSource('https://github.com/acme/skills/tree/dev/skills/foo'), {
    owner: 'acme',
    repo: 'skills',
    ref: 'dev',
    skillPath: 'skills/foo',
  });
  assert.deepEqual(parseSkillSource('https://www.skills.sh/acme/skills/triage'), {
    owner: 'acme',
    repo: 'skills',
    skillFilter: 'triage',
  });
  assert.deepEqual(parseSkillSource('skills.sh/acme/skills'), { owner: 'acme', repo: 'skills' });
});

test('parseSkillSource rejects unrecognized inputs', () => {
  assert.equal(parseSkillSource(''), null);
  assert.equal(parseSkillSource('just some text'), null);
  assert.equal(parseSkillSource('https://example.com/foo/bar'), null);
  assert.equal(parseSkillSource('acme'), null);
});

test('parseFrontmatter extracts name/description and body', () => {
  const md = '---\nname: incident-scribe\ndescription: "Build a timeline."\n---\n\n# Body\n\ntext';
  const parsed = parseFrontmatter(md);
  assert.equal(parsed.name, 'incident-scribe');
  assert.equal(parsed.description, 'Build a timeline.');
  assert.match(parsed.body, /# Body/);
});

test('parseFrontmatter returns the whole document as body when there is no frontmatter', () => {
  const parsed = parseFrontmatter('# Just markdown');
  assert.equal(parsed.name, undefined);
  assert.equal(parsed.body, '# Just markdown');
});

test('sanitizeSkillName normalizes to the strict rule or empty', () => {
  assert.equal(sanitizeSkillName('Incident Scribe'), 'incident-scribe');
  assert.equal(sanitizeSkillName('grill_me'), 'grill-me');
  assert.equal(sanitizeSkillName('PR/Explainer!'), 'prexplainer');
  assert.equal(sanitizeSkillName('---'), '');
});

// A fetch mock: ordered [substring, response] pairs; first match wins.
function mockFetch(
  routes: Array<[string, { status?: number; json?: unknown; text?: string; headers?: HeadersInit }]>,
  requests?: Array<{ url: string; init?: RequestInit }>,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url: string }).url);
    requests?.push({ url, ...(init ? { init } : {}) });
    for (const [needle, res] of routes) {
      if (url.includes(needle)) {
        const status = res.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: new Headers(res.headers),
          async json() {
            return res.json;
          },
          async text() {
            return res.text ?? '';
          },
        } as Response;
      }
    }
    return { ok: false, status: 404, async json() {}, async text() { return ''; } } as unknown as Response;
  }) as typeof fetch;
}

const TREE = {
  tree: [
    { path: 'skills/foo/SKILL.md', type: 'blob' },
    { path: 'skills/foo/scripts/run.sh', type: 'blob' },
    { path: 'skills/bar/SKILL.md', type: 'blob' },
    { path: 'tests/fixtures/x/SKILL.md', type: 'blob' },
    { path: 'README.md', type: 'blob' },
  ],
};
const EXACT_OID = '3b3fad9abcdef0123456789abcdef0123456789a';

test('resolveSkillSource resolves candidates, flags scripts, and skips test fixtures', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = mockFetch([
    ['/git/trees/', { json: TREE }],
    ['/main/skills/foo/SKILL.md', { text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo body' }],
    ['/main/skills/bar/SKILL.md', { text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar body' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ], requests);

  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills' }, fetchImpl);

  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).has('authorization'), false, request.url);
  }
  assert.equal(result.ref, 'main');
  assert.deepEqual(result.source, { visibility: 'public', access: 'anonymous' });
  assert.equal(result.total, 2); // tests/fixtures/x is excluded from the count
  assert.equal(result.capped, false);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ['foo', 'bar'],
  );
  const foo = result.skills.find((skill) => skill.name === 'foo');
  assert.equal(foo?.description, 'The foo skill.');
  assert.match(String(foo?.instructions), /# Foo body/);
  assert.equal(foo?.hasScripts, true); // has scripts/run.sh sibling
  assert.equal(result.skills.find((skill) => skill.name === 'bar')?.hasScripts, false);
  assert.match(String(foo?.sourceUrl), /github\.com\/acme\/skills\/tree\/main\/skills\/foo/);
});

test('resolveSkillSource honors an @skill filter', async () => {
  const fetchImpl = mockFetch([
    ['/git/trees/', { json: TREE }],
    ['/main/skills/bar/SKILL.md', { text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ]);
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', skillFilter: 'bar' }, fetchImpl);
  assert.deepEqual(
    result.skills.map((skill) => skill.name),
    ['bar'],
  );
});

test('resolveSkillSource narrows a GitHub tree URL to its selected directory', async () => {
  const embedded = JSON.stringify({
    payload: {
      codeViewTreeRoute: {
        path: 'skills/foo',
        refInfo: { name: 'main', currentOid: EXACT_OID },
        tree: {
          items: [{ name: 'SKILL.md', path: 'skills/foo/SKILL.md', contentType: 'file' }],
          totalCount: 1,
        },
      },
    },
  });
  const fetchImpl = mockFetch([
    ['https://github.com/acme/skills/tree/main/skills/foo', {
      text: `<script data-target="react-app.embeddedData">${embedded}</script>`,
    }],
    [`/${EXACT_OID}/skills/foo/SKILL.md`, { text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo' }],
  ]);
  const result = await resolveSkillSource({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    skillPath: 'skills/foo',
  }, fetchImpl);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['foo']);
  assert.equal(result.total, 1);
});

test('resolveSkillSource resolves an exact public directory without scanning the repository tree', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const embedded = JSON.stringify({
    payload: {
      codeViewTreeRoute: {
        path: 'skills/foo',
        refInfo: { name: 'main', currentOid: EXACT_OID },
        tree: {
          items: [{ name: 'SKILL.md', path: 'skills/foo/SKILL.md', contentType: 'file' }],
          totalCount: 1,
        },
      },
    },
  });
  const fetchImpl = mockFetch([
    ['https://github.com/acme/skills/tree/main/skills/foo', {
      text: `<script type="application/json" data-target="react-app.embeddedData">${embedded}</script>`,
    }],
    [`/${EXACT_OID}/skills/foo/SKILL.md`, {
      text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo',
    }],
  ], requests);

  const result = await resolveSkillSource({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    skillPath: 'skills/foo',
  }, fetchImpl);

  assert.equal(requests.length, 2);
  assert.equal(requests.some((request) => request.url.includes('/git/trees/')), false);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['foo']);
  assert.equal(result.skills[0]?.hasScripts, false);
  assert.equal(result.total, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.ref, EXACT_OID);
  assert.match(result.skills[0]!.sourceUrl, new RegExp(EXACT_OID));
});

test('exact-path rate-limit fallback conservatively flags packaged directories', async () => {
  const embedded = JSON.stringify({
    payload: {
      codeViewTreeRoute: {
        path: 'skills/foo',
        refInfo: { name: 'main', currentOid: EXACT_OID },
        tree: {
          items: [
            { name: 'SKILL.md', path: 'skills/foo/SKILL.md', contentType: 'file' },
            { name: 'scripts', path: 'skills/foo/scripts', contentType: 'directory' },
          ],
          totalCount: 2,
        },
      },
    },
  });
  const fetchImpl = mockFetch([
    ['/git/trees/', { status: 429 }],
    ['https://github.com/acme/skills/tree/main/skills/foo', {
      text: `<script data-target="react-app.embeddedData">${embedded}</script>`,
    }],
    [`/${EXACT_OID}/skills/foo/SKILL.md`, {
      text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo',
    }],
  ]);

  const result = await resolveSkillSource({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    skillPath: 'skills/foo',
  }, fetchImpl);
  assert.equal(result.skills[0]?.hasScripts, true);
});

test('an exact-path parent directory falls back to bounded candidate discovery', async () => {
  const parentDirectory = JSON.stringify({
    payload: {
      codeViewTreeRoute: {
        path: 'skills',
        refInfo: { name: 'main', currentOid: EXACT_OID },
        tree: {
          items: [{ name: 'foo', path: 'skills/foo', contentType: 'directory' }],
          totalCount: 1,
        },
      },
    },
  });
  const fetchImpl = mockFetch([
    ['https://github.com/acme/skills/tree/main/skills', {
      text: `<script data-target="react-app.embeddedData">${parentDirectory}</script>`,
    }],
    ['/git/trees/', { json: TREE }],
    ['/main/skills/foo/SKILL.md', {
      text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo',
    }],
    ['/main/skills/bar/SKILL.md', {
      text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar',
    }],
  ]);

  const result = await resolveSkillSource({
    owner: 'acme',
    repo: 'skills',
    ref: 'main',
    skillPath: 'skills',
  }, fetchImpl);
  assert.deepEqual(result.skills.map(({ name }) => name), ['foo', 'bar']);
});

test('exact-path fallback accepts a full GitHub OID for an abbreviated ref', async () => {
  const embedded = JSON.stringify({
    payload: {
      codeViewTreeRoute: {
        path: 'skills/foo',
        refInfo: { name: EXACT_OID, currentOid: EXACT_OID },
        tree: {
          items: [{ name: 'SKILL.md', path: 'skills/foo/SKILL.md', contentType: 'file' }],
          totalCount: 1,
        },
      },
    },
  });
  const fetchImpl = mockFetch([
    ['/git/trees/', { status: 429 }],
    ['https://github.com/acme/skills/tree/3b3fad9/skills/foo', {
      text: `<script data-target="react-app.embeddedData">${embedded}</script>`,
    }],
    [`/${EXACT_OID}/skills/foo/SKILL.md`, {
      text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo',
    }],
  ]);

  const result = await resolveSkillSource({
    owner: 'acme',
    repo: 'skills',
    ref: '3b3fad9',
    skillPath: 'skills/foo',
  }, fetchImpl);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['foo']);
});

test('authenticated rate-limited tree resolution never uses the anonymous page fallback', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = mockFetch([
    ['/git/trees/', { status: 429 }],
    ['api.github.com/repos/acme/private', { json: { default_branch: 'main', private: true } }],
  ], requests);

  await assert.rejects(
    () => resolveSkillSource({
      owner: 'acme',
      repo: 'private',
      ref: 'main',
      skillPath: 'skills/foo',
    }, fetchImpl, { token: 'private-installation-token' }),
    (error: unknown) => error instanceof SkillImportError && error.code === 'rate_limited',
  );
  assert.equal(requests.some(({ url }) => url.startsWith('https://github.com/')), false);
});

test('resolveSkillSource rejects oversized GitHub responses before buffering them', async () => {
  const oversizedTreeFetch = (async () => new Response('{}', {
    headers: { 'content-length': String(32 * 1024 * 1024) },
  })) as typeof fetch;
  await assert.rejects(
    () => resolveSkillSource({ owner: 'acme', repo: 'skills', ref: 'main' }, oversizedTreeFetch),
    (error: unknown) => error instanceof SkillImportError && error.code === 'source_too_large',
  );

  const tree = JSON.stringify({ tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] });
  const oversizedSkillFetch = (async (input: unknown) => {
    const url = String(input);
    return url.includes('/git/trees/')
      ? new Response(tree, { headers: { 'content-type': 'application/json' } })
      : new Response('---\nname: foo\ndescription: Foo.\n---\n# Foo', {
          headers: { 'content-length': String(1024 * 1024) },
        });
  }) as typeof fetch;
  await assert.rejects(
    () => resolveSkillSource({ owner: 'acme', repo: 'skills', ref: 'main' }, oversizedSkillFetch),
    (error: unknown) => error instanceof SkillImportError && error.code === 'source_too_large',
  );
});

test('resolveSkillSource skips a skill missing a description', async () => {
  const fetchImpl = mockFetch([
    ['/git/trees/', { json: { tree: [{ path: 'skills/foo/SKILL.md', type: 'blob' }] } }],
    ['/main/skills/foo/SKILL.md', { text: '---\nname: foo\n---\n# Body only, no description' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ]);
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills' }, fetchImpl);
  assert.equal(result.skills.length, 0);
  assert.equal(result.skipped, 1);
});

test('resolveSkillSource marks an anonymous 404 as an authenticated-access candidate', async () => {
  const fetchImpl = mockFetch([['api.github.com/repos/acme/private', { status: 404 }]]);
  await assert.rejects(
    () => resolveSkillSource({ owner: 'acme', repo: 'private' }, fetchImpl),
    (err: unknown) => err instanceof SkillImportError && err.code === 'access_candidate',
  );
});

test('resolveSkillSource classifies anonymous rate limits without requesting App fallback', async () => {
  const fetchImpl = mockFetch([
    ['api.github.com/repos/acme/skills', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
    }],
  ]);
  await assert.rejects(
    () => resolveSkillSource({ owner: 'acme', repo: 'skills' }, fetchImpl),
    (err: unknown) => err instanceof SkillImportError && err.code === 'rate_limited',
  );
});

test('resolveSkillSource reads private skill files through authenticated Contents requests', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = mockFetch([
    ['/contents/skills/private/SKILL.md?', {
      text: '---\nname: private-skill\ndescription: Private instructions.\n---\n# Secret body',
    }],
    ['/git/trees/', { json: { tree: [{ path: 'skills/private/SKILL.md', type: 'blob' }] } }],
    ['api.github.com/repos/acme/private-skills', {
      json: { default_branch: 'main', private: true },
    }],
  ], requests);

  const result = await resolveSkillSource(
    { owner: 'acme', repo: 'private-skills' },
    fetchImpl,
    { token: 'private-installation-token' },
  );

  assert.deepEqual(result.source, { visibility: 'private', access: 'github_app' });
  assert.deepEqual(result.skills.map((skill) => skill.name), ['private-skill']);
  assert.equal(requests.some((request) => request.url.includes('raw.githubusercontent.com')), false);
  for (const request of requests) {
    assert.equal(
      new Headers(request.init?.headers).get('authorization'),
      'Bearer private-installation-token',
      request.url,
    );
    assert.ok(request.init?.signal, `expected a request deadline for ${request.url}`);
  }
  const contentsRequest = requests.find((request) => request.url.includes('/contents/'));
  assert.match(new Headers(contentsRequest?.init?.headers).get('accept') ?? '', /github\.raw/);
});

test('resolveSkillSource classifies access removed during authenticated resolution', async () => {
  const fetchImpl = mockFetch([
    ['api.github.com/repos/acme/private-skills', { status: 404 }],
  ]);
  await assert.rejects(
    () => resolveSkillSource(
      { owner: 'acme', repo: 'private-skills' },
      fetchImpl,
      { token: 'private-installation-token' },
    ),
    (err: unknown) => err instanceof SkillImportError && err.code === 'repository_inaccessible',
  );
});

test('resolveSkillSource preserves rate-limit recovery during authenticated resolution', async () => {
  const fetchImpl = mockFetch([
    ['api.github.com/repos/acme/private-skills', {
      status: 403,
      headers: { 'retry-after': '60' },
    }],
  ]);
  await assert.rejects(
    () => resolveSkillSource(
      { owner: 'acme', repo: 'private-skills' },
      fetchImpl,
      { token: 'private-installation-token' },
    ),
    (err: unknown) => err instanceof SkillImportError && err.code === 'rate_limited',
  );
});
