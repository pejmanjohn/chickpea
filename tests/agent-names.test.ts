import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ChickpeaRoutineExecution } from '../src/agents/routine-execution.ts';
import { ChickpeaRoutineIntent } from '../src/agents/routine-intent.ts';
import { ChickpeaSlack } from '../src/agents/slack-thread.ts';
import {
  CHICKPEA_ROUTINE_EXECUTION_AGENT_NAME,
  CHICKPEA_ROUTINE_INTENT_AGENT_NAME,
  CHICKPEA_SLACK_AGENT_NAME,
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
});

test('every registered agent is covered by the managed-submission policy set', () => {
  const registered = [
    ChickpeaSlack.agentName,
    ChickpeaRoutineIntent.agentName,
    ChickpeaRoutineExecution.agentName,
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
});
