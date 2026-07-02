import { parityExceptions } from './parity/exceptions.ts';
import { laneB } from './parity/lane-b.ts';
import { runScenarioSuite } from './parity/scenarios.ts';

// Lane B spawns a real `node dist-node/server.mjs` per scenario. Every scenario
// RUNS (nothing is skipped); slow scenarios (e.g. the provider-500 retry turn)
// are tolerated by the adapter's per-scenario quiesce windows.
runScenarioSuite(laneB, parityExceptions);
