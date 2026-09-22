import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudflareBuildSource } from '../src/config/runtime-target.ts';

const KEY = '__CHICKPEA_CLOUDFLARE_BUILD_SOURCE__';

function withBuildSource(value: unknown, run: () => void) {
  const scope = globalThis as Record<string, unknown>;
  scope[KEY] = value;
  try {
    run();
  } finally {
    delete scope[KEY];
  }
}

test('cloudflareBuildSource is unknown without a build-time value', () => {
  assert.equal(cloudflareBuildSource(), 'unknown');
});

test('cloudflareBuildSource reports the recorded Workers Builds or command build', () => {
  withBuildSource('workers-builds', () => assert.equal(cloudflareBuildSource(), 'workers-builds'));
  withBuildSource('command', () => assert.equal(cloudflareBuildSource(), 'command'));
});

test('cloudflareBuildSource treats any other recorded value as unknown', () => {
  withBuildSource('dashboard', () => assert.equal(cloudflareBuildSource(), 'unknown'));
});
