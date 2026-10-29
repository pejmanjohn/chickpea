import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_MANAGEMENT_REQUEST_BYTES, validateManagementOperations } from '../src/management/contracts.ts';
import type { ManagementOperation } from '../src/management/types.ts';

function skillsUpdate(totalChars: number, count = 8): ManagementOperation {
  const body = 'a'.repeat(Math.floor(totalChars / count));
  return {
    itemId: 'op_skills',
    kind: 'update_agent',
    agentId: 'agent_support',
    expectedRevision: 3,
    patch: {
      skills: Array.from({ length: count }, (_, i) => ({
        name: `knowledge-${i}`,
        description: 'A knowledge domain.',
        instructions: body,
        enabled: true,
      })),
    },
  } as ManagementOperation;
}

test('a knowledge-heavy skills update of several hundred KiB is accepted in one request', () => {
  const op = skillsUpdate(600 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify([op]), 'utf8') > 128 * 1024, 'the fixture must exceed the old 128 KiB cap');
  assert.doesNotThrow(() => validateManagementOperations([op]));
});

test('a request over the 1 MiB cap is refused with the size message', () => {
  const op = skillsUpdate(MAX_MANAGEMENT_REQUEST_BYTES + 64 * 1024);
  assert.throws(() => validateManagementOperations([op]), /The management request is too large\./);
});
