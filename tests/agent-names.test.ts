import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CodingWorker } from '../src/agents/coding-worker.ts';
import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { ChickpeaRoutineIntent } from '../src/agents/routine-intent.ts';
import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import { ChickpeaTestTurn } from '../src/agents/test-turn.ts';
import { TEST_RUN_ABORT_AFTER_MS, TEST_RUN_DEADLINE_MS, TEST_RUN_FORCED_ERASE_MS } from '../src/state/test-run-lifecycle.ts';
import {
  CHICKPEA_CODING_WORKER_AGENT_NAME,
  CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME,
  CHICKPEA_ROUTINE_INTENT_AGENT_NAME,
  CHICKPEA_SLACK_AGENT_NAME,
  CHICKPEA_TEST_TURN_AGENT_NAME,
  MANAGED_SUBMISSION_AGENT_NAMES,
  UNATTENDED_AGENT_NAMES,
} from '../src/agents/names.ts';

// The registrations must be static literals (the Flue build derives Durable
// Object binding names from them before any code runs), so they cannot import
// the policy constants. This test is the seam that keeps the two in step: the
// Flue 2 rename previously drifted them apart and silently disabled the only
// deterministic side-effect gate in production for every live agent.
test('registered agent names match the constants runtime policy keys off', () => {
  assert.equal(ChickpeaSlack.agentName, CHICKPEA_SLACK_AGENT_NAME);
  assert.equal(ChickpeaRoutineIntent.agentName, CHICKPEA_ROUTINE_INTENT_AGENT_NAME);
  assert.equal(ChickpeaRoutineExecution.agentName, CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME);
  assert.equal(CodingWorker.agentName, CHICKPEA_CODING_WORKER_AGENT_NAME);
  assert.equal(ChickpeaTestTurn.agentName, CHICKPEA_TEST_TURN_AGENT_NAME);
  assert.equal(ChickpeaTestTurn.agentName, 'chickpea-test-turn-v1', 'the literal names the v12 class FlueChickpeaTestTurnV1Agent');
});

// The connection write gate's second layer holds only for these names: for
// any other agent it finds no submission state and lets the write through
// (memory/tool-policy.ts, assertCurrentRequestContext).
test('a practice run is bounded as a direct message is: its durability, and a store deadline 30 seconds past its timeout', () => {
  assert.deepEqual(ChickpeaTestTurn.durability, ChickpeaSlack.durability);
  assert.deepEqual(ChickpeaSlack.durability, { maxAttempts: 10, timeoutMs: 155 * 60_000 });
  const timeout = ChickpeaSlack.durability!.timeoutMs!;
  assert.deepEqual([TEST_RUN_ABORT_AFTER_MS, TEST_RUN_DEADLINE_MS, TEST_RUN_FORCED_ERASE_MS],
    [timeout + 5_000, timeout + 30_000, timeout + 30_000 + 7.5 * 60_000], 'abort, deadline and forced erase follow the timeout, with the margins they had');
});

test('a test run is a managed submission, so the connection write gate holds for it', () => {
  assert.ok((MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(ChickpeaTestTurn.agentName!));
});

test('the coding worker carries no tool authority, so it is not a managed submission', () => {
  assert.equal(
    (MANAGED_SUBMISSION_AGENT_NAMES as readonly string[]).includes(CodingWorker.agentName!),
    false,
  );
});

test('every agent that runs a Slack submission is covered by the managed-submission policy set', () => {
  const registered = [
    ChickpeaSlack.agentName,
    ChickpeaRoutineIntent.agentName,
    ChickpeaRoutineExecution.agentName,
    ChickpeaTestTurn.agentName,
  ].sort();
  assert.deepEqual([...MANAGED_SUBMISSION_AGENT_NAMES].sort(), registered);
});

test('the unattended set is exactly the routine agents', () => {
  assert.deepEqual([...UNATTENDED_AGENT_NAMES].sort(), [
    ChickpeaRoutineExecution.agentName,
    ChickpeaRoutineIntent.agentName,
  ].sort());
  assert.equal(
    UNATTENDED_AGENT_NAMES.includes(
      ChickpeaSlack.agentName as (typeof UNATTENDED_AGENT_NAMES)[number],
    ),
    false,
    'the interactive Slack agent has a human in the loop and must not be treated as unattended',
  );
  assert.equal((UNATTENDED_AGENT_NAMES as readonly string[]).includes(ChickpeaTestTurn.agentName!), false,
    'a test run answers the person who asked for it');
});
