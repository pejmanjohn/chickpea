import { parityExceptions } from './parity/exceptions.ts';
import { laneA } from './parity/lane-a.ts';
import { runScenarioSuite } from './parity/scenarios.ts';

runScenarioSuite(laneA, parityExceptions);
