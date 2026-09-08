#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATALOG_URL = 'https://raw.githubusercontent.com/pejmanjohn/chickpea/main/catalog/current.json';
const MAX_BYTES = 128 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = await readFile(path.join(root, 'catalog', 'current.json'));
const response = await fetch(CATALOG_URL, { redirect: 'error', cache: 'no-store' });
if (!response.ok) {
  throw new Error(`Catalog origin returned HTTP ${response.status}.`);
}
const contentLength = response.headers.get('content-length');
const advertised = contentLength === null ? undefined : Number(contentLength);
if (advertised !== undefined && Number.isFinite(advertised) && advertised > MAX_BYTES) {
  throw new Error('Catalog origin exceeded the 128 KiB cap.');
}
const served = await readBoundedBody(response);
if (!Buffer.from(served).equals(expected)) {
  throw new Error(
    `Served catalog bytes differ from main: expected ${sha(expected)}, received ${sha(served)}.`,
  );
}
console.log(`Served catalog matches main (${sha(served)}, ${served.byteLength} bytes).`);

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readBoundedBody(response) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel();
        throw new Error('Catalog origin exceeded the 128 KiB cap.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
