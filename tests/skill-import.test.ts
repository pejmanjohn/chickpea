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
    refPath: 'dev/skills/foo',
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
    for (const [needle, res] of [...routes.filter(([needle]) => !/^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(needle) && !/^api\.github\.com\/repos\/[^/]+\/[^/]+$/.test(needle)), ['/commits/', { json: { sha: EXACT_OID } }] as const, ...routes]) {
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
    [`/${EXACT_OID}/skills/foo/SKILL.md`, { text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo body' }],
    [`/${EXACT_OID}/skills/bar/SKILL.md`, { text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar body' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ], requests);

  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills' }, fetchImpl);

  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(new Headers(request.init?.headers).has('authorization'), false, request.url);
  }
  assert.equal(result.ref, EXACT_OID);
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
  assert.match(String(foo?.sourceUrl), new RegExp(`github.com/acme/skills/tree/${EXACT_OID}/skills/foo`));
  assert.equal(foo?.importSource?.commit, EXACT_OID, 'branch content is fetched only after resolving its commit');
});

test('resolveSkillSource honors an @skill filter', async () => {
  const fetchImpl = mockFetch([
    ['/git/trees/', { json: TREE }],
    [`/${EXACT_OID}/skills/bar/SKILL.md`, { text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar' }],
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
  assert.equal(result.skills[0]?.importSource?.commit, EXACT_OID);
  assert.equal(result.skills[0]?.importSource?.repository, 'acme/skills');
  assert.equal(result.skills[0]?.importSource?.path, 'skills/foo');
  assert.match(result.skills[0]?.importSource?.contentSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(result.skills[0]!.sourceUrl, new RegExp(EXACT_OID));
});

test('exact-path inspection flags actual scripts in nested directories', async () => {
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
    [`/tree/${EXACT_OID}/skills/foo/scripts`, { text: directoryPage('skills/foo/scripts', [{ path: 'skills/foo/scripts/run.sh', contentType: 'file' }]) }],
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
    [`/${EXACT_OID}/skills/foo/SKILL.md`, {
      text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo',
    }],
    [`/${EXACT_OID}/skills/bar/SKILL.md`, {
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
    () => resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, oversizedTreeFetch),
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
    () => resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, oversizedSkillFetch),
    (error: unknown) => error instanceof SkillImportError && error.code === 'source_too_large',
  );
});

test('resolveSkillSource reports a selected skill missing a description', async () => {
  await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, mockFetch([
    ['/git/trees/', { json: { tree: [{ path: 'foo/SKILL.md', type: 'blob' }] } }],
    ['/SKILL.md', { text: '---\nname: foo\n---\nBody.' }],
  ])), (error: unknown) => error instanceof SkillImportError && error.code === 'invalid_document');
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

function directoryPage(path: string, items: Array<{ path: string; contentType: string }>, oid = EXACT_OID) {
  return `<script data-target="react-app.embeddedData">${JSON.stringify({ payload: { codeViewTreeRoute: {
    path, refInfo: { name: oid, currentOid: oid }, tree: { items, totalCount: items.length },
  } } })}</script>`;
}

test('metadata and references are inspected recursively and disclosed without script misclassification', async () => {
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID, skillPath: 'foo' }, mockFetch([
    [`/tree/${EXACT_OID}/foo/agents`, { text: directoryPage('foo/agents', [{ path: 'foo/agents/openai.yaml', contentType: 'file' }]) }],
    [`/tree/${EXACT_OID}/foo/references`, { text: directoryPage('foo/references', [{ path: 'foo/references/guide.md', contentType: 'file' }]) }],
    [`/tree/${EXACT_OID}/foo`, { text: directoryPage('foo', [
      { path: 'foo/SKILL.md', contentType: 'file' }, { path: 'foo/agents', contentType: 'directory' },
      { path: 'foo/references', contentType: 'directory' },
    ]) }],
    [`/${EXACT_OID}/foo/SKILL.md`, { text: '---\nname: foo\ndescription: Foo.\n---\nRead references/guide.md.' }],
  ]));
  assert.equal(result.skills[0]?.hasScripts, false);
  assert.deepEqual(result.skills[0]?.inspection?.auxiliaryPaths, ['agents/openai.yaml', 'references/guide.md']);
});

test('root packages classify scripts, executable modes and unknown files', async () => {
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, mockFetch([
    ['/git/trees/', { json: { tree: [
      { path: 'SKILL.md', type: 'blob' }, { path: 'scripts/run.ps1', type: 'blob' },
      { path: 'run', type: 'blob', mode: '100755' }, { path: 'mystery.bin', type: 'blob' },
    ] } }],
    ['/SKILL.md', { text: '---\nname: foo\ndescription: Foo.\n---\nDo it.' }],
  ]));
  assert.equal(result.skills[0]?.hasScripts, true);
  assert.deepEqual(result.skills[0]?.inspection?.scriptPaths, ['run', 'scripts/run.ps1']);
  assert.deepEqual(result.skills[0]?.inspection?.unknownPaths, ['mystery.bin']);
});

test('truncated trees fail closed', async () => {
  await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, mockFetch([
    ['/git/trees/', { json: { ...TREE, truncated: true } }],
    ['/SKILL.md', { text: '---\nname: foo\ndescription: Foo.\n---\nDo it.' }],
  ])), (error: unknown) => error instanceof SkillImportError && error.code === 'incomplete_inspection');
});

for (const [status, code] of [[404, 'document_not_found'], [429, 'rate_limited'], [500, 'github_error']] as const) {
  test(`raw document ${status} retains its actual failure`, async () => {
    await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID, skillPath: 'foo' }, mockFetch([
      ['/tree/', { text: directoryPage('foo', [{ path: 'foo/SKILL.md', contentType: 'file' }]) }],
      ['/SKILL.md', { status }],
    ])), (error: unknown) => error instanceof SkillImportError && error.code === code);
  });
}

test('file and raw URLs preserve the directory and immutable revision', () => {
  for (const source of [
    `https://github.com/acme/skills/blob/${EXACT_OID}/skills/foo/SKILL.md`,
    `https://raw.githubusercontent.com/acme/skills/${EXACT_OID}/skills/foo/SKILL.md`,
  ]) {
    const parsed = parseSkillSource(source);
    assert.equal(parsed?.ref, EXACT_OID);
    assert.equal(parsed?.skillPath, 'skills/foo');
  }
  assert.equal(parseSkillSource('https://github.com/acme/skills/issues/1'), null);
});

test('named repository discovery pins the actual commit and finds a canonical target after 40 unrelated skills', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const tree = { sha: 'b'.repeat(40), tree: [
    ...Array.from({ length: 41 }, (_, i) => ({ path: `skills/unrelated-${i}/SKILL.md`, type: 'blob' })),
    { path: 'skills/foo/SKILL.md', type: 'blob' },
  ] };
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', skillFilter: 'foo' }, mockFetch([
    ['/commits/main', { json: { sha: EXACT_OID } }],
    [`/git/trees/${EXACT_OID}`, { json: tree }],
    [`/${EXACT_OID}/skills/foo/SKILL.md`, { text: '---\nname: foo\ndescription: Foo.\n---\nExact snapshot.' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ], requests));
  assert.equal(result.skills[0]?.importSource?.commit, EXACT_OID);
  assert.equal(result.ref, EXACT_OID);
  assert.equal(requests.length, 4);
  assert.equal(requests.some(({ url }) => url.includes('unrelated-')), false);
});

test('duplicate canonical names remain candidates and an incomplete declared-name search is explicit', async () => {
  const tree = { tree: ['a/foo', 'b/foo'].map((dir) => ({ path: `${dir}/SKILL.md`, type: 'blob' })) };
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID, skillFilter: 'foo' }, mockFetch([
    ['/git/trees/', { json: tree }], ['/SKILL.md', { text: '---\nname: foo\ndescription: Foo.\n---\nBody.' }],
  ]));
  assert.deepEqual(result.skills.map(({ path }) => path), ['a/foo', 'b/foo']);
  await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID, skillFilter: 'other-name' }, mockFetch([
    ['/git/trees/', { json: { tree: Array.from({ length: 41 }, (_, i) => ({ path: `a-${i}/SKILL.md`, type: 'blob' })) } }],
    ['/SKILL.md', { text: '---\nname: unrelated\ndescription: Unrelated.\n---\nBody.' }],
  ])), (error: unknown) => error instanceof SkillImportError && error.code === 'incomplete_search');
});

test('an exact root document does not select nested skills and stores the root provenance path', async () => {
  const parsed = parseSkillSource(`https://github.com/acme/skills/blob/${EXACT_OID}/SKILL.md`)!;
  const result = await resolveSkillSource(parsed, mockFetch([
    ['/git/trees/', { json: { tree: [{ path: 'SKILL.md', type: 'blob' }, { path: 'nested/SKILL.md', type: 'blob' }] } }],
    ['/SKILL.md', { text: '---\nname: root-skill\ndescription: Root.\n---\nBody.' }],
  ]));
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.importSource?.path, '');
});

test('the public directory listing resolves slash-containing refs without changing the source', async () => {
  const parsed = parseSkillSource('https://github.com/acme/skills/tree/release/v1/foo')!;
  const page = directoryPage('foo', [{ path: 'foo/SKILL.md', contentType: 'file' }]).replace(`"name":"${EXACT_OID}"`, '"name":"release/v1"');
  const result = await resolveSkillSource(parsed, mockFetch([
    ['/tree/release/v1/foo', { text: page }],
    [`/${EXACT_OID}/foo/SKILL.md`, { text: '---\nname: foo\ndescription: Foo.\n---\nBody.' }],
  ]));
  assert.equal(result.skills[0]?.path, 'foo');
  assert.equal(result.skills[0]?.importSource?.commit, EXACT_OID);
});

test('an ambiguous authenticated URL ref is rejected rather than silently reinterpreted', async () => {
  await assert.rejects(resolveSkillSource(parseSkillSource('https://github.com/acme/skills/tree/release/v1/foo')!, mockFetch([
    ['/matching-refs/heads/', { json: [{ ref: 'refs/heads/release' }, { ref: 'refs/heads/release/v1' }] }],
    ['/matching-refs/tags/', { json: [] }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main', private: true } }],
  ]), { token: 'test-token' }), (error: unknown) => error instanceof SkillImportError && error.code === 'ambiguous_ref');
});

for (const failure of ['deep', 'wide', 'malformed', 'incomplete']) {
  test(`package inspection stops on ${failure} listings`, async () => {
    const path = failure === 'deep' ? `foo/${'deep/'.repeat(9)}file.md` : 'foo/file.md';
    const items = failure === 'wide'
      ? Array.from({ length: 14 }, (_, i) => ({ path: `foo/d-${i}`, contentType: 'directory' }))
      : [{ path, contentType: 'file' }];
    const page = failure === 'malformed' ? '<html>Missing embedded data</html>'
      : directoryPage('foo', [{ path: 'foo/SKILL.md', contentType: 'file' }, ...items]);
    const fetchImpl = mockFetch([
      ['/tree/', { text: failure === 'incomplete' ? page.replace('"totalCount":2', '"totalCount":3') : page }],
      ['/SKILL.md', { text: '---\nname: foo\ndescription: Foo.\n---\nBody.' }],
    ]);
    await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID, skillPath: 'foo' }, fetchImpl),
      (error: unknown) => error instanceof SkillImportError && ['incomplete_inspection', 'source_too_large'].includes(error.code));
  });
}

test('saved real GitHub listings preserve nested metadata inspection', async () => {
  const { readFile } = await import('node:fs/promises');
  const [root, agents] = await Promise.all(['github-skill-directory.html', 'github-agents-directory.html'].map((name) =>
    readFile(new URL(`./fixtures/skill-import/${name}`, import.meta.url), 'utf8')));
  const result = await resolveSkillSource(parseSkillSource('https://github.com/mattpocock/skills/tree/main/skills/productivity/grill-me')!, mockFetch([
    ['/agents', { text: agents! }], ['/tree/', { text: root! }],
    ['/SKILL.md', { text: '---\nname: grill-me\ndescription: Alias.\n---\nCall the Skill tool with "grilling".' }],
  ]));
  assert.equal(result.skills[0]?.hasScripts, false);
  assert.deepEqual(result.skills[0]?.inspection?.auxiliaryPaths, ['agents/openai.yaml']);
});

for (const [style, expected] of [['|', 'First line.\nSecond line.\n'], ['>-', 'First line. Second line.']] as const) {
  test(`YAML ${style} descriptions preserve their meaning`, () => {
    const front = parseFrontmatter(`\uFEFF---\r\nname: foo\r\ndescription: ${style}\r\n  First line.\r\n  Second line.\r\nmetadata:\r\n  author: example\r\n---\r\n\r\nBody.\r\n`);
    assert.equal(front.description, expected);
    assert.equal(front.body, '\r\nBody.\r\n');
  });
}

for (const [description, body, code] of [
  ['Foo.', '  \n', 'invalid_document'],
  ['Foo.', 'x'.repeat(100_001), 'document_too_large'],
  ['x'.repeat(1025), 'Body.', 'document_too_large'],
] as const) {
  test(`invalid or oversized document is rejected (${description.length}/${body.length})`, async () => {
    await assert.rejects(resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, mockFetch([
      ['/git/trees/', { json: { tree: [{ path: 'foo/SKILL.md', type: 'blob' }] } }],
      ['/SKILL.md', { text: `---\nname: foo\ndescription: ${description}\n---\n${body}` }],
    ])), (error: unknown) => error instanceof SkillImportError && error.code === code);
  });
}

test('imported body bytes are preserved and unsupported invocation metadata is disclosed', async () => {
  const body = '\nKeep these spaces.  \r\n\n';
  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills', ref: EXACT_OID }, mockFetch([
    ['/git/trees/', { json: { tree: [{ path: 'foo/SKILL.md', type: 'blob' }] } }],
    ['/SKILL.md', { text: `---\nname: foo\ndescription: Foo.\ndisable-model-invocation: true\nallowed-tools: [Skill]\n---\n${body}` }],
  ]));
  assert.equal(result.skills[0]?.instructions, body);
  assert.match(result.skills[0]?.inspection?.warnings.join(' ') ?? '', /disable-model-invocation.*allowed-tools|allowed-tools.*disable-model-invocation/);
});

for (const header of [
  'name: foo\nname: bar\ndescription: Test.',
  'name: foo\ndescription: &a Test.\nmetadata: *a',
  'name: foo\ndescription: !unsafe Test.',
  'name: foo\ndescription: [not, text]',
]) {
  test(`unsupported YAML is rejected: ${header.split('\n')[1]}`, () => {
    assert.throws(() => parseFrontmatter(`---\n${header}\n---\nBody.`),
      (error: unknown) => error instanceof SkillImportError && error.code === 'invalid_document');
  });
}
