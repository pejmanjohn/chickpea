#!/usr/bin/env node
/**
 * Bounded, self-reattaching Worker tail for a QA lane.
 *
 *   npm run lane:tail -- <amber|cobalt|violet> --out <absolute file> [--minutes N] [--stall-minutes M] [--profile P] [--env E]
 *   npm run lane:tail -- --worker <name> --out <absolute file> [...]
 *
 * Attach it before the action you want logs for, as one background command.
 * Events (pretty-printed JSON objects, not JSON lines) go to the file; attach,
 * exit, stall and stop lines go to `<file>.events`; Wrangler's own messages go
 * to `<file>.err`. It reattaches after a deploy replaces the version, restarts
 * after `--stall-minutes` without output (default 10), and stops after
 * `--minutes` (default 60, at most 240). The file must be outside Git.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_STALL_MINUTES, DEFAULT_TAIL_MINUTES, MAX_TAIL_MINUTES, runTail } from './lib/lane-tail.mjs';
import { QA_LANES } from './lib/qa-lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const USAGE = 'Usage: npm run lane:tail -- (<amber|cobalt|violet> | --worker NAME) --out ABSOLUTE_FILE [--minutes N] [--stall-minutes M] [--profile P] [--env E]\n';

export function parseArguments(argv) {
  const options = { lane: undefined, worker: undefined, out: undefined, minutes: DEFAULT_TAIL_MINUTES, stallMinutes: DEFAULT_STALL_MINUTES, providerContext: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    if (!flag.startsWith('--') && options.lane === undefined) options.lane = flag;
    else if (flag === '--worker') options.worker = value();
    else if (flag === '--out') options.out = value();
    else if (flag === '--minutes') options.minutes = Number(value());
    else if (flag === '--stall-minutes') options.stallMinutes = Number(value());
    else if (flag === '--profile' || flag === '--env') options.providerContext.push(flag, value());
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if ((options.lane === undefined) === (options.worker === undefined)) throw new Error('Name exactly one lane or --worker.');
  if (options.lane !== undefined && !QA_LANES.includes(options.lane)) throw new Error(`Choose a lane: ${QA_LANES.join(', ')}.`);
  if (!options.out || !path.isAbsolute(options.out)) throw new Error('--out must be an absolute file path outside Git.');
  if (!Number.isFinite(options.minutes) || options.minutes <= 0 || options.minutes > MAX_TAIL_MINUTES) throw new Error(`--minutes must be 1..${MAX_TAIL_MINUTES}.`);
  if (!Number.isFinite(options.stallMinutes) || options.stallMinutes <= 0) throw new Error('--stall-minutes must be positive.');
  return options;
}

async function resolveWorker(lane) {
  const { readEnvironmentRegistry } = await import('./lib/environment-registry.mjs');
  const workerName = readEnvironmentRegistry().targets?.[lane]?.workerName;
  if (!workerName) throw new Error(`No registered QA lane named ${lane}.`);
  return workerName;
}

export async function main(argv, { env = process.env, stderr = process.stderr } = {}) {
  if (argv.length === 0 || argv.includes('--help')) { stderr.write(USAGE); return argv.length === 0 ? 2 : 0; }
  let options;
  try { options = parseArguments(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}`); return 2; }
  try {
    const { outsideGit } = await import('./lib/private-evidence.mjs');
    const out = outsideGit(options.out, ROOT);
    const worker = options.worker ?? await resolveWorker(options.lane);
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, () => controller.abort());
    stderr.write(`lane:tail ${worker}: appending to ${out} for up to ${options.minutes} min (events in ${out}.events)\n`);
    const counts = await runTail({
      command: process.execPath,
      args: [WRANGLER, 'tail', worker, '--format', 'json', ...options.providerContext],
      out, env, durationMs: options.minutes * 60_000, stallMs: options.stallMinutes * 60_000, signal: controller.signal,
    });
    stderr.write(`lane:tail ${worker}: ${counts.attaches} attach(es), ${counts.exits} reattach(es) after an exit, ` +
      `${counts.stallRestarts} stall restart(s), ${counts.bytes} bytes\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
