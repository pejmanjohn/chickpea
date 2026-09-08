import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TAG_STATE_INSTANCE,
  tagStateInstanceName,
  tagStateStub,
} from '../src/config/state-rpc.ts';

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
