import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import { cardServer } from './helpers/mcp-card-host.ts';

/**
 * What a client that draws cards lists, descriptor for descriptor: the tools
 * OpenAI reviews for the ChatGPT app. Removing the 4.x surface (contract
 * 5.0.0) must leave it unchanged. Any other change to it is deliberate: run
 * this file with CHICKPEA_UPDATE_CARD_HOST_TOOLS=1 to rewrite the snapshot,
 * and say in the PR which tools changed and why. The snapshot holds digests,
 * so to see what changed, run this file on both commits with
 * CHICKPEA_CARD_HOST_TOOLS_OUT=<a file outside the repository>, which gets
 * every descriptor's JSON, and diff the two files.
 */
const SNAPSHOT = new URL('./fixtures/mcp-v5/card-host-tools.json', import.meta.url);

type Descriptor = { name: string } & Record<string, unknown>;

/** A value with every object's keys sorted. */
function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
      : value;
}

/** A descriptor's sha-256 over its JSON with every object's keys sorted. */
function digest(descriptor: Descriptor): string {
  return createHash('sha256').update(JSON.stringify(canonical(descriptor))).digest('hex');
}

test('a card host lists exactly the tool descriptors in the snapshot', async (t) => {
  const { send } = await cardServer(t, 'card-host-tools', {}, { cards: true });
  const listed = (JSON.parse(await send('tools/list', {})) as { result: { tools: Descriptor[] } }).result.tools;
  const digests = Object.fromEntries(listed.map((tool) => [tool.name, digest(tool)]));
  const out = process.env.CHICKPEA_CARD_HOST_TOOLS_OUT;
  if (out) await writeFile(out, `${JSON.stringify(canonical(listed), null, 2)}\n`);
  if (process.env.CHICKPEA_UPDATE_CARD_HOST_TOOLS === '1') await writeFile(SNAPSHOT, `${JSON.stringify(digests, null, 2)}\n`);
  const expected = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Record<string, string>;
  assert.deepEqual(Object.keys(digests), Object.keys(expected), 'the same tools, in the same order');
  const changed = Object.keys(digests).filter((name) => digests[name] !== expected[name]);
  assert.deepEqual(changed, [], 'these tools list a different descriptor; CHICKPEA_CARD_HOST_TOOLS_OUT=<file> writes every descriptor, to diff against another commit');
});
