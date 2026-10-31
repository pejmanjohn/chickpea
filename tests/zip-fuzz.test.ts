import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { createByteBudget, openZip, ZipArchiveError } from '../src/files/zip.ts';
import { buildZip } from './helpers/zip.ts';

const SEED = 0x2a1f_2026;
const CASES = 3_000;
const BUDGET = 256 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024;
const CASE_TIMEOUT_MS = 2_000;

/** mulberry32: small, fast, and the same sequence on every run for one seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const fixtures = readdirSync(new URL('./fixtures/zip/', import.meta.url))
  .map((name) => new Uint8Array(readFileSync(new URL(`./fixtures/zip/${name}`, import.meta.url))));
const seeds: Uint8Array[] = [
  ...fixtures,
  buildZip([
    { path: 'a.txt', content: 'x'.repeat(40_000) },
    { path: 'b.bin', content: new Uint8Array(60_000), method: 0 },
    { path: 'c.txt', content: 'y'.repeat(70_000) },
  ]),
  buildZip([{ path: 'kernel.bin', content: new Uint8Array(200_000) }, { path: 'kernel.bin', content: '', localOffset: 0 }]),
];

/** Values that land on the boundaries the reader checks: zero, small, saturated, and near-length. */
const INTERESTING = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff];

function mutate(source: Uint8Array, next: () => number): Uint8Array {
  let bytes: Uint8Array = source.slice();
  const pick = (limit: number) => Math.floor(next() * limit);
  const rounds = 1 + pick(4);
  for (let round = 0; round < rounds && bytes.byteLength > 0; round += 1) {
    const at = pick(bytes.byteLength);
    switch (pick(6)) {
      case 0:
        bytes[at]! ^= 1 << pick(8);
        break;
      case 1:
        bytes[at] = pick(256);
        break;
      case 2:
        bytes = bytes.slice(0, at);
        break;
      case 3: {
        const length = Math.min(bytes.byteLength - at, 1 + pick(64));
        const copy = bytes.slice(at, at + length);
        const into = pick(bytes.byteLength);
        bytes = Uint8Array.from([...bytes.subarray(0, into), ...copy, ...bytes.subarray(into)]);
        break;
      }
      case 4: {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const value = next() < 0.5 ? INTERESTING[pick(INTERESTING.length)]! : pick(bytes.byteLength * 2);
        if (at + 4 <= bytes.byteLength) view.setUint32(at, value >>> 0, true);
        else if (at + 2 <= bytes.byteLength) view.setUint16(at, value & 0xffff, true);
        break;
      }
      default:
        bytes = Uint8Array.from([...bytes.subarray(0, at), ...bytes.subarray(at + 1 + pick(32))]);
    }
  }
  return bytes;
}

function withinTime<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${CASE_TIMEOUT_MS} ms`)), CASE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

test(`${CASES} seeded mutations of real and synthetic archives either read within budget or refuse with a ZipArchiveError`, {
  timeout: 120_000,
}, async () => {
  const next = random(SEED);
  const outcomes = { opened: 0, refusedOpen: 0, entriesRead: 0, entriesRefused: 0 };
  for (let index = 0; index < CASES; index += 1) {
    const label = `case ${index} (seed ${SEED})`;
    const bytes = mutate(seeds[index % seeds.length]!, next);
    const budget = createByteBudget(BUDGET);
    let archive: ReturnType<typeof openZip>;
    try {
      archive = openZip(bytes, { maxEntryBytes: MAX_ENTRY_BYTES, budget });
      outcomes.opened += 1;
    } catch (error) {
      assert.ok(error instanceof ZipArchiveError, `${label}: open threw ${String(error)}`);
      outcomes.refusedOpen += 1;
      continue;
    }
    let inflated = 0;
    for (const entry of archive.entries) {
      try {
        const content = await withinTime(entry.read(), label);
        assert.equal(content.byteLength, entry.size, `${label}: ${entry.path} read a different size than declared`);
        inflated += content.byteLength;
        outcomes.entriesRead += 1;
      } catch (error) {
        assert.ok(error instanceof ZipArchiveError, `${label}: ${entry.path} read threw ${String(error)}`);
        outcomes.entriesRefused += 1;
      }
    }
    assert.ok(inflated <= BUDGET, `${label}: inflated ${inflated} bytes past the ${BUDGET}-byte budget`);
    assert.equal(budget.remaining >= 0, true, `${label}: the budget went negative`);
  }
  // Every branch ran: mutations that still open, refusals at open, reads, and read refusals.
  assert.ok(Object.values(outcomes).every((count) => count > 50), JSON.stringify(outcomes));
});
