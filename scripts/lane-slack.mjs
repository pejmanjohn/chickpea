#!/usr/bin/env node
/**
 * Exact, read-only Slack readback for a QA lane.
 *
 *   npm run lane:slack -- <lane> whoami
 *   npm run lane:slack -- <lane> message <message link> [--out FILE]
 *   npm run lane:slack -- <lane> thread <message link> [--out FILE]
 *   npm run lane:slack -- <lane> history <channel id or link> [--since ISO] [--until ISO] [--limit N] [--out FILE]
 *
 * Reads with the lane's own readback app token (`<LANE>__SLACK_READBACK_TOKEN`
 * in the lane secrets file; see qa/live/operator/hosts.md). Prints JSON, or
 * writes it owner-only to a new file outside Git with --out. Never posts and
 * never prints the token.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { QA_LANES } from './lib/qa-lanes.mjs';
import { parseMessageLink, readHistory, readMessage, readThread, readbackToken, slackClient, whoami } from './lib/slack-readback.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: npm run lane:slack -- <${QA_LANES.join('|')}> <whoami | message LINK | thread LINK | history CHANNEL> [--since ISO] [--until ISO] [--limit N] [--out FILE]\n`;
const COMMANDS = new Set(['whoami', 'message', 'thread', 'history']);

export function parseArguments(argv) {
  const [lane, command, target, ...rest] = argv;
  if (!QA_LANES.includes(lane)) throw new Error(`Choose a lane: ${QA_LANES.join(', ')}.`);
  if (!COMMANDS.has(command)) throw new Error('Choose whoami, message, thread or history.');
  const options = { lane, command, target, out: undefined, since: undefined, until: undefined, limit: 50 };
  if (command === 'whoami') { if (target !== undefined) rest.unshift(target); options.target = undefined; }
  else if (!target || target.startsWith('--')) throw new Error(`${command} needs a ${command === 'history' ? 'channel ID or link' : 'message link'}.`);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    index += 1;
    if (flag === '--out') options.out = value;
    else if (flag === '--since' && command === 'history') options.since = value;
    else if (flag === '--until' && command === 'history') options.until = value;
    else if (flag === '--limit' && command === 'history') options.limit = Number(value);
    else throw new Error(`Unknown or inapplicable argument "${flag}".`);
  }
  if (options.out && !path.isAbsolute(options.out)) throw new Error('--out must be an absolute file path outside Git.');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new Error('--limit must be 1..200.');
  return options;
}

const slackTs = (value) => {
  if (value === undefined) return undefined;
  if (/^\d{10}(\.\d{1,6})?$/u.test(value)) return value;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`"${value}" is not an ISO time or Slack timestamp.`);
  return (ms / 1000).toFixed(6);
};

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch, readEntries, readRegistry } = {}) {
  if (argv.length === 0 || argv.includes('--help')) { (argv.length ? stdout : stderr).write(USAGE); return argv.length ? 0 : 2; }
  let options;
  try { options = parseArguments(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}`); return 2; }
  try {
    const entries = readEntries ? readEntries() : (await import('./lib/lane-secrets.mjs')).readLaneSecretEntries({ env });
    const call = slackClient(readbackToken(entries, options.lane), { fetchImpl });
    let result;
    if (options.command === 'whoami') {
      const registry = readRegistry ? readRegistry() : (await import('./lib/environment-registry.mjs')).readEnvironmentRegistry();
      result = await whoami(call, registry.targets?.[options.lane]?.workspaceId);
    } else if (options.command === 'message') result = await readMessage(call, options.target);
    else if (options.command === 'thread') result = await readThread(call, parseMessageLink(options.target));
    else {
      const channel = /^[CDG][A-Z0-9]+$/u.test(options.target) ? options.target : parseMessageLink(options.target).channel;
      result = await readHistory(call, { channel, oldest: slackTs(options.since), latest: slackTs(options.until), limit: options.limit });
    }
    const text = `${JSON.stringify({ lane: options.lane, command: options.command, readAt: new Date().toISOString(), ...result }, null, 2)}\n`;
    if (options.out) {
      const { outsideGit } = await import('./lib/private-evidence.mjs');
      const file = outsideGit(options.out, ROOT);
      writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
      stdout.write(`${JSON.stringify({ out: file })}\n`);
    } else stdout.write(text);
    if (options.command === 'whoami' && result.matchesLane === false) {
      stderr.write('The readback token belongs to a different workspace than this lane. Replace it.\n');
      return 1;
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
