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
function mockFetch(routes: Array<[string, { status?: number; json?: unknown; text?: string }]>): typeof fetch {
  return (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url: string }).url);
    for (const [needle, res] of routes) {
      if (url.includes(needle)) {
        const status = res.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
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

test('resolveSkillSource resolves candidates, flags scripts, and skips test fixtures', async () => {
  const fetchImpl = mockFetch([
    ['/git/trees/', { json: TREE }],
    ['/main/skills/foo/SKILL.md', { text: '---\nname: foo\ndescription: The foo skill.\n---\n# Foo body' }],
    ['/main/skills/bar/SKILL.md', { text: '---\nname: bar\ndescription: The bar skill.\n---\n# Bar body' }],
    ['api.github.com/repos/acme/skills', { json: { default_branch: 'main' } }],
  ]);

  const result = await resolveSkillSource({ owner: 'acme', repo: 'skills' }, fetchImpl);

  assert.equal(result.ref, 'main');
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

test('resolveSkillSource throws a typed error when the repo is missing', async () => {
  const fetchImpl = mockFetch([['api.github.com/repos/acme/missing', { status: 404 }]]);
  await assert.rejects(
    () => resolveSkillSource({ owner: 'acme', repo: 'missing' }, fetchImpl),
    (err: unknown) => err instanceof SkillImportError && err.code === 'not_found',
  );
});
