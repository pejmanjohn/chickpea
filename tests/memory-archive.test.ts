import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeMemoryArchive, encodeMemoryArchive } from '../src/memory/archive.ts';

test('USTAR archive bytes are deterministic and round-trip regular files', () => {
  const files = [
    { path: 'channel/C1/z.md', content: 'z\n' },
    { path: 'MEMORY.md', content: '# Index\n' },
  ];
  const first = encodeMemoryArchive(files);
  const second = encodeMemoryArchive([...files].reverse());
  assert.deepEqual(second, first);
  assert.deepEqual(decodeMemoryArchive(first), [
    { path: 'MEMORY.md', content: '# Index\n' },
    { path: 'channel/C1/z.md', content: 'z\n' },
  ]);
});

test('archive decoder rejects unsafe paths, duplicate paths, links, and oversized input', () => {
  assert.throws(() => encodeMemoryArchive([{ path: '../secret', content: 'x' }]), /unsafe/i);
  assert.throws(
    () => encodeMemoryArchive([{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }]),
    /duplicate/i,
  );
  assert.throws(
    () => encodeMemoryArchive([{ path: 'large', content: 'x'.repeat(4 * 1024 * 1024 + 1) }]),
    /size/i,
  );

  const archive = encodeMemoryArchive([{ path: 'safe.md', content: 'ok' }]);
  archive[156] = '2'.charCodeAt(0);
  assert.throws(() => decodeMemoryArchive(archive), /type|checksum/i);
});

