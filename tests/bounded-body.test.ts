import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedBytes, readBoundedText, readTruncatedText } from '../src/http/bounded-body.ts';

test('a body cut off by its signal is an error, never the part that arrived', async () => {
  const cancelled: string[] = [];
  /** Sends one chunk, then nothing more until it is cancelled. */
  const stalled = (name: string) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial '));
    },
    cancel() {
      cancelled.push(name);
    },
  }));
  const timedOut = () => new Error('timed out');
  const reads = {
    text: () => readBoundedText(stalled('text'), {
      maxBytes: 1_024, onOversize: () => new Error('too large'), signal: AbortSignal.timeout(30), onAbort: timedOut,
    }),
    truncated: () => readTruncatedText(stalled('truncated'), { maxBytes: 1_024, signal: AbortSignal.timeout(30) }),
    bytes: () => readBoundedBytes(stalled('bytes'), {
      maxBytes: 1_024, onOversize: () => new Error('too large'), signal: AbortSignal.timeout(30), onAbort: timedOut,
    }),
  };
  // Node unrefs AbortSignal.timeout's timer; keep the loop alive while the reads wait on it.
  const keepAlive = setTimeout(() => undefined, 5_000);
  try {
    await assert.rejects(reads.text(), /timed out/);
    await assert.rejects(reads.truncated(), /bounded body read aborted/);
    await assert.rejects(reads.bytes(), /timed out/);
  } finally {
    clearTimeout(keepAlive);
  }
  assert.deepEqual(cancelled, ['text', 'truncated', 'bytes']);
});
