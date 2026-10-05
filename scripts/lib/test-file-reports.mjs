/**
 * Whether each test file delivered every report its process made.
 *
 * node:test passes a test file whose process exits 0, whatever reached the
 * runner. The last thing a file's process sends is its own `test:summary`,
 * which counts every test and suite it finished. So a file is complete only
 * when that summary arrived and the passes and failures that arrived before it
 * match its counts. A process that ends partway (a stray process.exit(), or
 * --test-force-exit discarding reports still queued for the pipe) leaves no
 * summary; a report lost in between leaves the counts short.
 *
 * Events are attributed by `entryFile`, the test file whose process sent them,
 * not `file`, where a test was declared: a shared helper can declare tests.
 * The runner's own pass or fail event for each file carries no `entryFile`.
 */
import { resolve } from 'node:path';

/** Starts counting a node:test `run()` stream's reports per test file. */
export function recordFileReports(stream) {
  const files = new Map();
  const entry = (file) => {
    const key = resolve(file);
    if (!files.has(key)) files.set(key, { tests: 0, suites: 0, summary: undefined });
    return files.get(key);
  };
  const count = (event) => {
    if (!event.entryFile) return;
    const reports = entry(event.entryFile);
    if (event.details?.type === 'suite') reports.suites += 1;
    else reports.tests += 1;
  };
  stream.on('test:pass', count);
  stream.on('test:fail', count);
  stream.on('test:summary', (event) => {
    if (event.entryFile) entry(event.entryFile).summary = event.counts;
  });
  return {
    /** Tests and suites that reported from `file`'s process. */
    reported: (file) => reportedCount(files.get(resolve(file))),
    /** Why `file`'s reports are incomplete, or undefined when they are not. */
    shortfall: (file) => reportShortfall(files.get(resolve(file))),
  };
}

const reportedCount = (reports) => (reports ? reports.tests + reports.suites : 0);

function reportShortfall(reports) {
  const reported = reportedCount(reports);
  if (!reports?.summary) return `${reported} test(s) reported, then its process ended without the file's summary`;
  const { tests, suites } = reports.summary;
  if (reports.tests !== tests || reports.suites !== suites) {
    return `its summary counts ${tests + suites} test(s), but only ${reported} reported`;
  }
  return undefined;
}
