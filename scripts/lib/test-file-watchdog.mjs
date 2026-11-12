/**
 * Stops a test file whose process stops making progress, and names it.
 *
 * node:test fails a test or hook after its timeout (scripts/lib/test-timeout.mjs),
 * but nothing bounds a file's process: one that hangs while loading, blocks its
 * event loop, or never ends after its last test never finishes. The runner
 * prints files in order, so every later file's output waits behind it, and the
 * pass goes silent until verify:host stops it with no name. The file's own
 * results stay unprinted too: node:test holds them until its process ends.
 *
 * The runner hears each file and each test start and finish as it happens:
 * test:dequeue and test:complete pass ahead of the ordered reports. A file that
 * starts and finishes no test for stallMs is past anything node:test will end.
 * onStall gets its name, the tests it reported running, and the last one it
 * finished. If the file has still not ended graceMs later, onStuck gets it.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Follows `files` (absolute paths) on a node:test run() stream; returns a function that stops watching. */
export function watchFileProgress(stream, files, { stallMs, graceMs, onStall, onStuck }) {
  const inPass = new Set(files);
  const inFlight = new Map();
  const progress = (event, update) => {
    const state = inFlight.get(resolve(event.entryFile));
    if (!state) return;
    state.last = Date.now();
    update(state);
  };
  // The runner's own event for a file carries no entryFile; each event from a file's process does.
  stream.on('test:dequeue', (event) => {
    if (event.entryFile) {
      progress(event, (state) => state.running.set(event.testId, { name: event.name, nesting: event.nesting, since: Date.now() }));
    } else if (event.file && inPass.has(resolve(event.file))) {
      inFlight.set(resolve(event.file), { last: Date.now(), running: new Map(), finished: undefined, stalledAt: undefined, stuck: false });
    }
  });
  stream.on('test:complete', (event) => {
    if (event.entryFile) {
      progress(event, (state) => { state.running.delete(event.testId); state.finished = event.name; });
    } else if (event.file) {
      inFlight.delete(resolve(event.file));
    }
  });
  const timer = setInterval(() => {
    for (const [file, state] of inFlight) {
      if (state.stalledAt === undefined && Date.now() - state.last >= stallMs) {
        state.stalledAt = Date.now();
        const running = [...state.running.values()].sort((a, b) => a.nesting - b.nesting)
          .map(({ name, since }) => ({ name, ms: Date.now() - since }));
        onStall({ file, idleMs: Date.now() - state.last, running, finished: state.finished });
      } else if (state.stalledAt !== undefined && !state.stuck && Date.now() - state.stalledAt >= graceMs) {
        state.stuck = true;
        onStuck({ file });
      }
    }
  }, Math.min(5_000, Math.max(100, Math.floor(stallMs / 4))));
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The process node:test started for `file` under this runner and every process
 * under it, from ps. A process that has left the tree, such as one whose parent
 * already exited, is not found.
 */
export function fileProcesses(file, runnerPid = process.pid) {
  const rows = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,stat=,etime=,time=,command='], { encoding: 'utf8', timeout: 10_000 })
    .split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, stat, elapsed, cpu, command]) => ({ pid: Number(pid), ppid: Number(ppid), stat, elapsed, cpu, command }));
  const tree = rows.filter((row) => row.ppid === runnerPid && row.command.endsWith(` ${file}`));
  for (let index = 0; index < tree.length; index += 1) tree.push(...rows.filter((row) => row.ppid === tree[index].pid));
  return tree;
}

/** What a stalled file was doing, for the log. */
export function describeStall({ idleMs, running, finished }) {
  const seconds = (ms) => `${Math.round(ms / 1000)} s`;
  const last = finished === undefined ? 'it finished no test' : `the last test it finished was "${finished}"`;
  if (running.length > 0) {
    const chain = running.map(({ name }) => `"${name}"`).join(' › ');
    return `It was running ${chain} (started ${seconds(running.at(-1).ms)} ago); ${last}.`;
  }
  if (finished !== undefined) return `No test was running: ${last}, and its process has not ended in ${seconds(idleMs)}.`;
  return 'It reported no test starting: it hung while loading, or blocked before it could report.';
}
