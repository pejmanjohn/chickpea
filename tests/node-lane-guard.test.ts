import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The preflight both `npm test` (pretest) and `npm run flue:build` run before
// the node lane. It must FAIL LOUDLY when a Cloudflare build was interrupted
// and left src/db.ts parked as src/db.ts.node-lane. Driven against a scratch
// --root so it never touches the real checkout.
const GUARD = fileURLToPath(new URL('../scripts/preflight-node-lane.mjs', import.meta.url));
const OPENAI_SUBSCRIPTION_LIVE = fileURLToPath(
  new URL('../scripts/verify-openai-subscription-live.mjs', import.meta.url),
);

function runGuard(root: string): { status: number | null; stderr: string } {
  const result = spawnSync(process.execPath, [GUARD, '--root', root], { encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

test('node-lane preflight fails loudly with a recovery hint when db.ts is parked', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-parked-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'db.ts.node-lane'), '// parked by an interrupted CF build\n');

    const { status, stderr } = runGuard(root);
    assert.equal(status, 1, 'the guard must exit non-zero when db.ts is parked');
    assert.match(stderr, /db\.ts\.node-lane/);
    // A one-line, actionable recovery hint.
    assert.match(stderr, /mv src\/db\.ts\.node-lane src\/db\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node-lane preflight passes when db.ts is not parked', () => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-unparked-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'db.ts'), 'export {};\n');

    const { status } = runGuard(root);
    assert.equal(status, 0, 'the guard must exit zero on a healthy node lane');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI subscription verifier rejects remote plaintext HTTP before reading admin auth', () => {
  const result = spawnSync(process.execPath, [
    OPENAI_SUBSCRIPTION_LIVE,
    '--live',
    '--target', 'node',
    '--base-url', 'http://example.com',
  ], {
    encoding: 'utf8',
    env: { ...process.env, TAG_ADMIN_TOKEN: '' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node target must use HTTPS unless it is an explicit loopback host/);
  assert.doesNotMatch(result.stderr, /TAG_ADMIN_TOKEN is required/);
});

test('node-lane preflight accepts one exact Pi pin within Flue\'s declared range', () => {
  const root = modelDependencyFixture({
    packageVersion: '0.80.2',
    lockVersion: '0.80.2',
    flueRange: '^0.80.2',
  });
  try {
    const { status, stderr } = runGuard(root);
    assert.equal(status, 0, stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node-lane preflight rejects Pi overrides, mismatched pins, and duplicate installs', () => {
  for (const scenario of [
    {
      name: 'override',
      options: {
        packageVersion: '0.80.2',
        lockVersion: '0.80.2',
        flueRange: '^0.80.2',
        overrideVersion: '0.82.1',
      },
      message: /must not use an npm override/,
    },
    {
      name: 'mismatched pin',
      options: {
        packageVersion: '0.82.1',
        lockVersion: '0.80.2',
        flueRange: '^0.80.2',
      },
      message: /direct pin 0\.82\.1 does not match the resolved version 0\.80\.2/,
    },
    {
      name: 'duplicate install',
      options: {
        packageVersion: '0.80.2',
        lockVersion: '0.80.2',
        flueRange: '^0.80.2',
        duplicateVersion: '0.79.0',
      },
      message: /expected one installed Pi copy, found 2/,
    },
  ] as const) {
    const root = modelDependencyFixture(scenario.options);
    try {
      const { status, stderr } = runGuard(root);
      assert.equal(status, 1, scenario.name);
      assert.match(stderr, scenario.message, scenario.name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function modelDependencyFixture(options: {
  packageVersion: string;
  lockVersion: string;
  flueRange: string;
  overrideVersion?: string;
  duplicateVersion?: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-pi-pin-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'db.ts'), 'export {};\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: {
      '@earendil-works/pi-ai': options.packageVersion,
      '@flue/runtime': '1.0.0-beta.8',
    },
    ...(options.overrideVersion
      ? { overrides: { '@earendil-works/pi-ai': options.overrideVersion } }
      : {}),
  }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {
        dependencies: {
          '@earendil-works/pi-ai': options.packageVersion,
          '@flue/runtime': '1.0.0-beta.8',
        },
      },
      'node_modules/@earendil-works/pi-ai': { version: options.lockVersion },
      'node_modules/@flue/runtime': {
        version: '1.0.0-beta.8',
        dependencies: { '@earendil-works/pi-ai': options.flueRange },
      },
      ...(options.duplicateVersion
        ? {
            'node_modules/@flue/runtime/node_modules/@earendil-works/pi-ai': {
              version: options.duplicateVersion,
            },
          }
        : {}),
    },
  }));
  return root;
}
