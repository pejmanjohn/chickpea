import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DurableObjectLocationHint } from '@cloudflare/workers-types';

import {
  TAG_STATE_INSTANCE,
  TAG_STATE_LOCATION_HINTS,
  type TagStateLocationHint,
  tagStateInstanceName,
  tagStateLocationHint,
  tagStateStub,
} from '../src/config/state-rpc.ts';

// Core's list is exactly the pinned workers-types' list, so a Cloudflare type bump that changes it fails typecheck.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const hintsMatchWorkersTypes: Same<TagStateLocationHint, DurableObjectLocationHint> = true;
void hintsMatchWorkersTypes;

test('TAG_STATE uses the stable singleton unless a deployment explicitly chooses a fresh instance', () => {
  assert.equal(tagStateInstanceName(undefined), TAG_STATE_INSTANCE);
  assert.equal(tagStateInstanceName({}), TAG_STATE_INSTANCE);
  assert.equal(tagStateInstanceName({ TAG_STATE_INSTANCE_NAME: 'agent-first-v1' }), 'agent-first-v1');
  assert.throws(
    () => tagStateInstanceName({ TAG_STATE_INSTANCE_NAME: '../unsafe' }),
    /bounded Durable Object name/,
  );

  const names: string[] = [];
  const stub = {} as never;
  assert.equal(tagStateStub({
    TAG_STATE_INSTANCE_NAME: 'agent-first-v1',
    TAG_STATE: {
      getByName(name: string) {
        names.push(name);
        return stub;
      },
    },
  }), stub);
  assert.deepEqual(names, ['agent-first-v1']);
});

function recordingNamespace() {
  const calls: unknown[][] = [];
  const stub = {} as never;
  return {
    calls,
    stub,
    TAG_STATE: {
      getByName(...args: unknown[]) {
        calls.push(args);
        return stub;
      },
    },
  };
}

test('TAG_STATE is addressed with the configured location hint', () => {
  const namespace = recordingNamespace();
  assert.equal(tagStateStub({ TAG_STATE_LOCATION_HINT: 'enam', TAG_STATE: namespace.TAG_STATE }), namespace.stub);
  assert.deepEqual(namespace.calls, [[TAG_STATE_INSTANCE, { locationHint: 'enam' }]]);
});

test('TAG_STATE is addressed by name alone when no location hint is configured', () => {
  for (const hint of [undefined, '']) {
    const namespace = recordingNamespace();
    assert.equal(tagStateStub({ TAG_STATE_LOCATION_HINT: hint, TAG_STATE: namespace.TAG_STATE }), namespace.stub);
    assert.deepEqual(namespace.calls, [[TAG_STATE_INSTANCE]], `hint ${JSON.stringify(hint)}`);
  }
});

test('a location hint outside Cloudflare\'s documented list is refused before any store is addressed', () => {
  assert.deepEqual(
    [...TAG_STATE_LOCATION_HINTS],
    ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'],
  );
  for (const hint of TAG_STATE_LOCATION_HINTS) assert.equal(tagStateLocationHint({ TAG_STATE_LOCATION_HINT: hint }), hint);
  for (const hint of ['ENAM', ' enam', 'us-east', 'eu', 'enam,weur', 7, true]) {
    const namespace = recordingNamespace();
    assert.throws(
      () => tagStateStub({ TAG_STATE_LOCATION_HINT: hint, TAG_STATE: namespace.TAG_STATE }),
      /TAG_STATE_LOCATION_HINT must be one of wnam, enam, .*, me, or unset\./,
      String(hint),
    );
    assert.deepEqual(namespace.calls, [], `no store addressed for ${JSON.stringify(hint)}`);
  }
});
