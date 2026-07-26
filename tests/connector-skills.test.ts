import assert from 'node:assert/strict';
import { test } from 'node:test';

import { suppressProfileNamedConnectorSkills } from '../src/agents/slack-thread.ts';
import {
  connectorSkillsForConnections,
  repositoriesSkillForGrants,
} from '../src/config/connector-skills.ts';
import { resolveProfileSkills } from '../src/config/profile-skills.ts';
import type { SkillConfig } from '../src/config/types.ts';

type ConnectorSkillScope = Parameters<typeof connectorSkillsForConnections>[0][number];

function scope(
  allowedHosts: string[],
  overrides: Partial<ConnectorSkillScope> = {},
): ConnectorSkillScope {
  return {
    allowedHosts,
    pathPrefixes: [],
    allowedMethods: ['GET'],
    ...overrides,
  };
}

test('matches supported API hosts case-insensitively and rejects lookalikes', () => {
  const cases: Array<{ host: string; expectedNames: string[] }> = [
    { host: 'api.github.com', expectedNames: ['github-api'] },
    { host: 'API.GITHUB.COM', expectedNames: ['github-api'] },
    { host: 'app.asana.com', expectedNames: ['asana-api'] },
    { host: 'APP.ASANA.COM', expectedNames: ['asana-api'] },
    { host: 'foo.zendesk.com', expectedNames: ['zendesk-api'] },
    { host: 'Foo.Zendesk.Com', expectedNames: ['zendesk-api'] },
    { host: 'www.googleapis.com', expectedNames: [] },
    { host: 'zendesk.com', expectedNames: [] },
    { host: 'zendesk.com.evil.com', expectedNames: [] },
    { host: 'api.github.com.evil.com', expectedNames: [] },
    { host: 'example.com', expectedNames: [] },
  ];

  for (const { host, expectedNames } of cases) {
    assert.deepEqual(
      connectorSkillsForConnections([scope([host])]).map((skill) => skill.name),
      expectedNames,
      host,
    );
  }
});

test('Google Workspace policy attaches one scope-aware Gmail, Calendar, and Drive skill', () => {
  const [skill] = connectorSkillsForConnections([
    scope(['gmail.googleapis.com', 'www.googleapis.com'], {
      presetId: 'google-workspace',
      pathPrefixes: ['/gmail/v1/users/me', '/calendar/v3', '/drive/v3'],
      allowedMethods: ['GET', 'HEAD'],
      oauthScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    }),
  ]);

  assert.equal(skill?.name, 'google-workspace');
  const instructions = skill?.instructions ?? '';
  assert.match(instructions, /Gmail, Calendar, and Drive/);
  assert.match(instructions, /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages/);
  assert.match(instructions, /www\.googleapis\.com\/calendar\/v3\/calendars/);
  assert.match(instructions, /www\.googleapis\.com\/drive\/v3\/files/);
  assert.match(instructions, /Gmail: read-only/);
  assert.match(instructions, /Calendar: read-only/);
  assert.match(instructions, /Drive: read-only/);
  assert.match(instructions, /Authentication is handled automatically/);
  assert.doesNotMatch(instructions, /Bearer |access[_ -]?token|client[_ -]?secret/i);
});

test('mixed Google access describes methods per service rather than as a writable union', () => {
  const [skill] = connectorSkillsForConnections([
    scope(['gmail.googleapis.com', 'www.googleapis.com'], {
      presetId: 'google-workspace',
      pathPrefixes: ['/gmail/v1/users/me', '/calendar/v3'],
      allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      oauthScopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ],
    }),
  ]);

  const instructions = skill?.instructions ?? '';
  assert.match(instructions, /Gmail: read-only/);
  assert.match(instructions, /Calendar: read and write/);
  assert.match(instructions, /Drive: not enabled/);
  assert.doesNotMatch(instructions, /Allowed methods:.*POST/);
});

test('matches every supported kind represented in one connection', () => {
  const skills = connectorSkillsForConnections([
    scope(['api.github.com', 'app.asana.com', 'acme.zendesk.com']),
  ]);

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ['github-api', 'asana-api', 'zendesk-api'],
  );
});

test("each skill's connection context lists only hosts for that vendor", () => {
  const skills = connectorSkillsForConnections([
    scope(['api.github.com', 'acme.zendesk.com']),
  ]);
  const githubContext =
    skills.find((skill) => skill.name === 'github-api')?.instructions.split('## Your connection')[1] ?? '';
  const zendeskContext =
    skills.find((skill) => skill.name === 'zendesk-api')?.instructions.split('## Your connection')[1] ?? '';

  assert.match(githubContext, /api\.github\.com/);
  assert.doesNotMatch(githubContext, /acme\.zendesk\.com/);
  assert.match(zendeskContext, /acme\.zendesk\.com/);
  assert.doesNotMatch(zendeskContext, /api\.github\.com/);
});

test('emits one skill per kind and keeps the first matching connection context', () => {
  const skills = connectorSkillsForConnections([
    scope(['api.github.com'], { pathPrefixes: ['/repos/first'] }),
    scope(['API.GITHUB.COM'], { pathPrefixes: ['/repos/second'] }),
  ]);

  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, 'github-api');
  assert.match(skills[0]?.instructions ?? '', /\/repos\/first/);
  assert.doesNotMatch(skills[0]?.instructions ?? '', /\/repos\/second/);
});

test('ignores connections with no matching host without throwing', () => {
  assert.doesNotThrow(() => connectorSkillsForConnections([scope([]), scope(['example.com'])]));
  assert.deepEqual(connectorSkillsForConnections([scope([]), scope(['example.com'])]), []);
});

test('appends the connection hosts, path prefixes, and methods to each skill', () => {
  const [scopedSkill] = connectorSkillsForConnections([
    scope(['api.github.com', 'uploads.github.com'], {
      pathPrefixes: ['/repos/acme/widgets', '/search'],
      allowedMethods: ['GET', 'POST'],
    }),
  ]);
  assert.match(scopedSkill?.instructions ?? '', /## Your connection/);
  assert.match(scopedSkill?.instructions ?? '', /api\.github\.com/);
  assert.doesNotMatch(scopedSkill?.instructions ?? '', /uploads\.github\.com/);
  assert.match(scopedSkill?.instructions ?? '', /\/repos\/acme\/widgets/);
  assert.match(scopedSkill?.instructions ?? '', /\/search/);
  assert.match(scopedSkill?.instructions ?? '', /GET, POST/);

  const [wholeHostSkill] = connectorSkillsForConnections([scope(['app.asana.com'])]);
  assert.match(wholeHostSkill?.instructions ?? '', /whole host/i);
});

test('the scope type excludes credentials and nearby credential data never reaches skill text', () => {
  const sentinel = 'SENTINEL-CREDENTIAL-MUST-NEVER-APPEAR';
  const resolvedConnection = {
    allowedHosts: ['api.github.com'],
    pathPrefixes: ['/repos'],
    allowedMethods: ['GET'],
    headerValue: sentinel,
  };
  const { allowedHosts, pathPrefixes, allowedMethods } = resolvedConnection;
  const skills = connectorSkillsForConnections([{ allowedHosts, pathPrefixes, allowedMethods }]);

  assert.doesNotMatch(skills.map((skill) => skill.instructions).join('\n'), new RegExp(sentinel));

  const credentialBearingScope: ConnectorSkillScope = {
    allowedHosts: ['api.github.com'],
    pathPrefixes: [],
    allowedMethods: ['GET'],
    // @ts-expect-error Connector skill builders must never accept credential-bearing fields.
    headerValue: sentinel,
  };
  void credentialBearingScope;
});

test('connector names pass defineSkill and a profile-authored skill overrides a connector skill', () => {
  const connectorSkills = connectorSkillsForConnections([
    scope(['api.github.com']),
    scope(['app.asana.com']),
    scope(['acme.zendesk.com']),
  ]);
  const refs = resolveProfileSkills(connectorSkills);

  assert.deepEqual(
    refs.map((ref) => ref.name),
    ['github-api', 'asana-api', 'zendesk-api'],
  );

  const profileOverride: SkillConfig = {
    name: 'github-api',
    description: 'Profile-authored GitHub instructions.',
    instructions: '# Custom GitHub behavior',
    enabled: true,
  };
  const overridden = resolveProfileSkills([
    ...suppressProfileNamedConnectorSkills(connectorSkills, [profileOverride]),
    profileOverride,
  ]);
  assert.equal(overridden.find((ref) => ref.name === 'github-api')?.description, profileOverride.description);
});

test('a disabled profile-authored skill suppresses the same-named connector skill', () => {
  const connectorSkills = connectorSkillsForConnections([
    scope(['api.github.com']),
    scope(['app.asana.com']),
  ]);
  const profileSuppression: SkillConfig = {
    name: 'github-api',
    description: 'Disable the auto-attached GitHub skill.',
    instructions: '# Disabled',
    enabled: false,
  };
  const refs = resolveProfileSkills([
    ...suppressProfileNamedConnectorSkills(connectorSkills, [profileSuppression]),
    profileSuppression,
  ]);

  assert.equal(refs.some((ref) => ref.name === 'github-api'), false);
  assert.equal(refs.some((ref) => ref.name === 'asana-api'), true);
});

test('repository grants attach the repositories skill and suppress generic github-api guidance', () => {
  const sentinel = 'SENTINEL-INSTALLATION-TOKEN-MUST-NEVER-APPEAR';
  const grantsWithNearbySecret = [
    {
      id: 'repo-zeta',
      installationId: 42,
      accountLogin: 'Acme',
      fullName: 'Acme/Zeta',
      enabled: true,
      nearbyToken: sentinel,
    },
    {
      id: 'repo-alpha',
      installationId: 42,
      accountLogin: 'Acme',
      fullName: 'Acme/Alpha',
      enabled: true,
    },
    {
      id: 'all-example',
      installationId: 84,
      accountLogin: 'ExampleOrg',
      fullName: '',
      allRepos: true,
      enabled: true,
    },
    {
      id: 'subsumed-by-all',
      installationId: 84,
      accountLogin: 'ExampleOrg',
      fullName: 'ExampleOrg/AlreadyIncluded',
      enabled: true,
    },
    {
      id: 'disabled',
      installationId: 42,
      accountLogin: 'Acme',
      fullName: 'Acme/Disabled',
      enabled: false,
    },
  ];

  const skills = connectorSkillsForConnections(
    [scope(['api.github.com'], { allowedMethods: ['GET', 'POST', 'PATCH', 'PUT'] })],
    grantsWithNearbySecret,
  );

  assert.deepEqual(skills.map((skill) => skill.name), ['repositories']);
  const instructions = skills[0]?.instructions ?? '';
  assert.match(instructions, /You have access to exactly these repositories/);
  assert.match(instructions, /`Acme\/Alpha`/);
  assert.match(instructions, /`Acme\/Zeta`/);
  assert.match(instructions, /all repositories in `ExampleOrg`/);
  assert.doesNotMatch(instructions, /ExampleOrg\/AlreadyIncluded/);
  assert.doesNotMatch(instructions, /Acme\/Disabled/);
  assert.doesNotMatch(instructions, new RegExp(sentinel));
  assert.doesNotMatch(instructions, /Authorization\s*:/i);
  assert.doesNotMatch(instructions, /\$GITHUB_[A-Z_]*TOKEN/i);
  for (const expected of [
    '/repos/{owner}/{repo}',
    '/contents/',
    '/search/code',
    '/pulls',
    '/issues',
    '/branches',
    '/compare/',
    '/git/blobs',
    '/git/trees',
    '/git/commits',
    '/git/refs',
    '/actions/runs',
    '/jobs',
    '/rerun',
  ]) {
    assert.ok(instructions.includes(expected), expected);
  }
  assert.match(instructions, /no workflow dispatch/i);
  assert.match(instructions, /no deployment approvals/i);
  assert.match(instructions, /no deletes/i);

  const direct = repositoriesSkillForGrants(grantsWithNearbySecret);
  assert.equal(direct?.name, 'repositories');
  assert.ok(Buffer.byteLength(direct?.instructions ?? '', 'utf8') <= 8 * 1_024);
});

test('each skill body is bounded, teaches automatic auth, and includes the required API guidance', () => {
  const skills = connectorSkillsForConnections([
    scope(['api.github.com'], { allowedMethods: ['GET', 'POST'] }),
    scope(['app.asana.com'], { allowedMethods: ['GET', 'POST', 'PUT'] }),
    scope(['acme.zendesk.com'], { allowedMethods: ['GET', 'POST', 'PUT'] }),
  ]);
  const expectations = new Map([
    [
      'github-api',
      [
        'https://api.github.com',
        'application/vnd.github+json',
        'X-GitHub-Api-Version: 2022-11-28',
        '/issues',
        '/comments',
        '/contents/',
        '/search/code',
        '/actions/runs',
        'Link',
      ],
    ],
    [
      'asana-api',
      [
        'https://app.asana.com/api/1.0',
        '{"data": ...}',
        'opt_fields',
        '/users/me',
        '/projects',
        '/tasks',
        '/stories',
        '/tasks/search',
        'offset',
      ],
    ],
    [
      'zendesk-api',
      [
        'https://<your-subdomain>.zendesk.com/api/v2',
        '/users/me.json',
        '/search.json',
        '/tickets/',
        'internal note',
        'public reply',
        'page[size]',
        'links.next',
      ],
    ],
  ]);

  assert.equal(skills.length, 3);
  for (const skill of skills) {
    assert.ok(skill.instructions.length > 0, skill.name);
    assert.ok(Buffer.byteLength(skill.instructions, 'utf8') <= 8 * 1024, skill.name);
    assert.match(skill.instructions, /authentication is handled automatically/i, skill.name);
    assert.doesNotMatch(skill.instructions, /Authorization\s*:/i, skill.name);
    assert.doesNotMatch(skill.instructions, /\$(?:GITHUB|ASANA|ZENDESK)_TOKEN/i, skill.name);
    for (const unsupportedFlag of ['--fail-with-body', '--get', '-G ', '--data-urlencode']) {
      assert.ok(!skill.instructions.includes(unsupportedFlag), `${skill.name}: ${unsupportedFlag}`);
    }
    assert.ok(!skill.description.includes('\n'), skill.name);
    const recipeCount = skill.instructions.match(/```bash\n\s*curl\b/g)?.length ?? 0;
    assert.ok(recipeCount >= 6 && recipeCount <= 10, `${skill.name}: ${recipeCount} recipes`);
    for (const expected of expectations.get(skill.name) ?? []) {
      assert.ok(skill.instructions.includes(expected), `${skill.name}: ${expected}`);
    }
  }
});

test('Asana skill says advanced task search is unpaginated', () => {
  const [asanaSkill] = connectorSkillsForConnections([scope(['app.asana.com'])]);

  assert.match(asanaSkill?.instructions ?? '', /task search endpoint is unpaginated/i);
});
