#!/usr/bin/env node
/**
 * Live verification kickoff doctor.
 *
 *   npm run verify:live:kickoff -- [--lane amber|cobalt|violet|all] [--no-browser] [--json] [--profile P] [--env E]
 *
 * One pass before claiming a lane, changing nothing but starting a stopped
 * lane browser: host Node and node_modules, the
 * host reservation, source freshness against remote main, and for each lane its
 * health, claim, deploy profile and command, schema generation against the
 * candidate, actors, telemetry receipt, and whether its browser daemon is
 * signed in to Admin and Slack. It prints what needs a person in one list.
 * Exit 0 when the host is usable and at least one requested lane is ready.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gatherKickoffFacts, kickoffReport, renderKickoff } from './lib/kickoff-doctor.mjs';
import { QA_LANES as LANES } from './lib/qa-lanes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: npm run verify:live:kickoff -- [--lane amber|cobalt|violet|all] [--no-browser] [--no-start] [--json] [--profile P] [--env E]\n';

export function parseArguments(argv) {
  const options = { lanes: LANES, browser: true, start: true, json: false, providerContext: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`);
      index += 1;
      return next;
    };
    if (flag === '--lane') {
      const lane = value();
      if (lane !== 'all' && !LANES.includes(lane)) throw new Error(`Choose a lane: ${LANES.join(', ')} or all.`);
      options.lanes = lane === 'all' ? LANES : [lane];
    } else if (flag === '--no-browser') options.browser = false;
    else if (flag === '--no-start') options.start = false;
    else if (flag === '--json') options.json = true;
    else if (flag === '--profile' || flag === '--env') options.providerContext.push(flag, value());
    else throw new Error(`Unknown argument "${flag}".`);
  }
  return options;
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, gather = gatherKickoffFacts } = {}) {
  if (argv.includes('--help')) { stdout.write(USAGE); return 0; }
  let options;
  try { options = parseArguments(argv); } catch (error) { stderr.write(`${error.message}\n${USAGE}`); return 2; }
  try {
    const facts = await gather({
      root: ROOT, lanes: options.lanes, browser: options.browser, startBrowsers: options.start,
      ...(options.providerContext.length ? { providerContext: options.providerContext } : {}),
    });
    const report = kickoffReport(facts);
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderKickoff(report));
    return report.ok ? 0 : 1;
  } catch (error) {
    stderr.write(`Kickoff doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
