import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activityStatusForObservation,
  buildSemanticActivityContext,
  registerActivityContext,
  registerActivityInvocationFact,
} from '../src/activity/status.ts';
import { ActivityLifecycleReducer } from '../src/activity/lifecycle.ts';
import type { SemanticActivityTelemetrySink } from '../src/activity/telemetry.ts';
import {
  genericSemanticDescriptor,
  semanticDescriptorForCoreTool,
  semanticInvocationFact,
} from '../src/activity/semantic.ts';
import { semanticDescriptorForManagedTool } from '../src/connections/catalog/index.ts';
import { FLUE_ACTIVITY_TRACES } from './fixtures/flue-activity-traces.ts';

function registerTraceContext(instanceId: string): void {
  const gmail = semanticDescriptorForManagedTool('gmail_search_messages');
  assert.ok(gmail);
  registerActivityContext(instanceId, buildSemanticActivityContext([
    { toolName: 'gmail_search_messages', descriptor: gmail },
    { toolName: 'stream_answer', descriptor: semanticDescriptorForCoreTool('stream_answer') },
    {
      toolName: 'submit_result',
      descriptor: semanticDescriptorForCoreTool('request_chickpea_handoff'),
    },
    { toolName: 'inspect_workspace', descriptor: genericSemanticDescriptor('workspace') },
  ], ['repository']));
}

function replay(
  instanceId: string,
  trace: readonly Record<string, unknown>[],
): string[] {
  return trace.flatMap((event) => {
    const status = activityStatusForObservation({ ...event, instanceId } as never);
    return status ? [status.text] : [];
  });
}

test('documented Flue traces enable drafting only for the registered progressive declaration', () => {
  registerTraceContext('trace-ordinary');
  assert.deepEqual(replay('trace-ordinary', FLUE_ACTIVITY_TRACES.ordinaryTopLevelAnswer), []);

  registerTraceContext('trace-progressive');
  assert.deepEqual(replay('trace-progressive', FLUE_ACTIVITY_TRACES.progressiveAnswer), [
    'Drafting the response…',
  ]);

  registerTraceContext('trace-structured');
  assert.deepEqual(replay('trace-structured', FLUE_ACTIVITY_TRACES.nestedStructuredOutput), []);

  registerTraceContext('trace-intermediate');
  assert.deepEqual(replay('trace-intermediate', FLUE_ACTIVITY_TRACES.intermediateTextThenTool), [
    'Checking Gmail…',
  ]);

  registerTraceContext('trace-tool-after-text');
  assert.deepEqual(replay('trace-tool-after-text', FLUE_ACTIVITY_TRACES.toolAfterText), [
    'Checking Gmail…',
    'Reviewing Gmail messages…',
  ]);
});

test('a successful work batch reviews only after every parallel call settles', () => {
  registerTraceContext('parallel-success');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'parallel-success',
      submissionId: 'parallel-success-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'gmail',
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool_start', toolName: 'inspect_workspace', toolCallId: 'workspace',
  }), 'Inspecting workspace settings…');
  assert.equal(observe({
    type: 'tool', toolName: 'inspect_workspace', toolCallId: 'workspace', isError: false,
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'gmail', isError: false,
  }), 'Reviewing the results…');
});

test('work evidence records closed family, outcome, and measured duration', () => {
  let now = 1_000;
  const records: Array<Record<string, unknown>> = [];
  const telemetry: SemanticActivityTelemetrySink = {
    info(message) {
      records.push(JSON.parse(message.slice('[chickpea:activity] '.length)));
    },
  };
  const reducer = new ActivityLifecycleReducer(() => now, telemetry);
  const descriptor = semanticDescriptorForManagedTool('gmail_search_messages');
  assert.ok(descriptor);

  reducer.observe({
    type: 'tool_start', instanceId: 'duration-instance', submissionId: 'duration-submission',
    toolCallId: 'gmail', descriptor,
  });
  now = 2_750;
  reducer.observe({
    type: 'tool', instanceId: 'duration-instance', submissionId: 'duration-submission',
    toolCallId: 'gmail', descriptor, isError: false,
  });

  assert.deepEqual(records, [{
    schemaVersion: 1,
    event: 'activity.work',
    family: 'managed_connector',
    outcome: 'succeeded',
    durationMs: 1_750,
  }]);
});

test('a failed parallel batch never emits success review and reassesses only at settlement', () => {
  registerTraceContext('parallel-failure');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'parallel-failure',
      submissionId: 'parallel-failure-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'gmail',
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool_start', toolName: 'inspect_workspace', toolCallId: 'workspace',
  }), 'Inspecting workspace settings…');
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'gmail', isError: false,
  }), undefined, 'the already-visible latest active phase does not need a duplicate write');
  assert.equal(observe({
    type: 'tool',
    toolName: 'inspect_workspace',
    toolCallId: 'workspace',
    isError: true,
    result: 'private result',
    errorInfo: { message: 'xoxb-private-error' },
  }), 'Reassessing the request…');
});

test('same-object parallel work reviews specifically and an ambiguous outcome reassesses', () => {
  registerTraceContext('parallel-same-object');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'parallel-same-object',
      submissionId: 'same-object-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'gmail-one',
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'gmail-two',
  }), undefined, 'identical parallel activity does not need a duplicate write');
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'gmail-one', isError: false,
  }), undefined);
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'gmail-two', isError: false,
  }), 'Reviewing Gmail messages…');

  assert.equal(activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'parallel-same-object',
    submissionId: 'ambiguous-submission',
    toolName: 'gmail_search_messages',
    toolCallId: 'ambiguous',
  })?.text, 'Checking Gmail…');
  assert.equal(activityStatusForObservation({
    type: 'tool',
    instanceId: 'parallel-same-object',
    submissionId: 'ambiguous-submission',
    toolName: 'gmail_search_messages',
    toolCallId: 'ambiguous',
  })?.text, 'Reassessing the request…');
});

test('late unknown work cannot replace a still-active specific phase', () => {
  registerTraceContext('specific-precedence');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'specific-precedence',
      submissionId: 'specific-precedence-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'gmail',
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool_start', toolName: 'future_unknown_tool', toolCallId: 'unknown',
  }), undefined);
  assert.equal(observe({
    type: 'tool', toolName: 'future_unknown_tool', toolCallId: 'unknown', isError: false,
  }), undefined);
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'gmail', isError: false,
  }), 'Reviewing the results…');
});

test('answer-generation and hidden helpers never participate in work review or recovery', () => {
  registerTraceContext('non-work-roles');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'non-work-roles',
      submissionId: 'non-work-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'tool_start', toolName: 'stream_answer', toolCallId: 'answer',
  }), 'Drafting the response…');
  assert.equal(observe({
    type: 'tool', toolName: 'stream_answer', toolCallId: 'answer', isError: true,
  }), undefined);
  assert.equal(observe({
    type: 'tool_start', toolName: 'submit_result', toolCallId: 'internal',
  }), undefined);
  assert.equal(observe({
    type: 'tool', toolName: 'submit_result', toolCallId: 'internal', isError: true,
  }), undefined);
});

test('an invocation owner may refine an active call only to a granted closed family', () => {
  registerTraceContext('owner-fact');
  const submissionId = 'owner-fact-submission';
  assert.equal(activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'owner-fact',
    submissionId,
    toolName: 'dynamic_sandbox_action',
    toolCallId: 'dynamic',
  })?.text, 'Working on the request…');

  const repositoryFact = semanticInvocationFact(
    'dynamic',
    genericSemanticDescriptor('repository'),
  );
  assert.equal(
    registerActivityInvocationFact('owner-fact', submissionId, repositoryFact)?.text,
    'Inspecting the repository…',
  );
  assert.equal(activityStatusForObservation({
    type: 'tool',
    instanceId: 'owner-fact',
    submissionId,
    toolName: 'dynamic_sandbox_action',
    toolCallId: 'dynamic',
    isError: false,
  })?.text, 'Reviewing repository results…');

  assert.equal(registerActivityInvocationFact(
    'owner-fact',
    submissionId,
    semanticInvocationFact('ungranted', genericSemanticDescriptor('skill')),
  ), undefined);
});

test('an invocation owner cannot invent a managed catalog label', () => {
  const gmail = semanticDescriptorForManagedTool('gmail_search_messages');
  assert.ok(gmail);
  registerActivityContext('managed-owner-fact', buildSemanticActivityContext([
    { toolName: 'gmail_search_messages', descriptor: gmail },
  ], ['managed_connector']));
  const submissionId = 'managed-owner-fact-submission';
  assert.equal(activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'managed-owner-fact',
    submissionId,
    toolName: 'future_dynamic_managed_tool',
    toolCallId: 'dynamic-managed',
  })?.text, 'Working on the request…');

  const forged = semanticInvocationFact('dynamic-managed', {
    ...gmail,
    label: { kind: 'managed_connector', id: 'gmail', label: 'Other Mail' },
  });
  assert.equal(
    registerActivityInvocationFact('managed-owner-fact', submissionId, forged),
    undefined,
  );
});

test('duplicates, out-of-order terminals, retries, and settlement cannot replay stale phases', () => {
  registerTraceContext('lifecycle-fences');
  const observe = (event: Record<string, unknown>) =>
    activityStatusForObservation({
      instanceId: 'lifecycle-fences',
      submissionId: 'fenced-submission',
      ...event,
    } as never)?.text;

  assert.equal(observe({
    type: 'submission_running', attemptCount: 1,
  }), undefined);
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'late', isError: false,
  }), undefined);
  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'late',
  }), undefined);
  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'active',
  }), 'Checking Gmail…');
  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'active',
  }), undefined);
  assert.equal(observe({
    type: 'submission_running', attemptCount: 2,
  }), 'Thinking…');
  assert.equal(observe({
    type: 'tool', toolName: 'gmail_search_messages', toolCallId: 'active', isError: false,
  }), undefined);
  assert.equal(observe({ type: 'submission_settled', outcome: 'aborted' }), undefined);
  assert.equal(observe({
    type: 'tool_start', toolName: 'gmail_search_messages', toolCallId: 'post-settlement',
  }), undefined);
});

test('bounded submission eviction fences late lifecycle events', () => {
  registerTraceContext('bounded-lifecycle');
  for (let index = 0; index <= 256; index += 1) {
    assert.equal(activityStatusForObservation({
      type: 'submission_queued',
      instanceId: 'bounded-lifecycle',
      submissionId: `bounded-submission-${index}`,
    }), undefined);
  }
  assert.equal(activityStatusForObservation({
    type: 'tool_start',
    instanceId: 'bounded-lifecycle',
    submissionId: 'bounded-submission-0',
    toolName: 'gmail_search_messages',
    toolCallId: 'late-after-eviction',
  }), undefined);
});

test('a submission suppresses new work after its distinct-call budget is exhausted', () => {
  const reducer = new ActivityLifecycleReducer();
  const descriptor = genericSemanticDescriptor('workspace');
  for (let index = 0; index < 256; index += 1) {
    reducer.observe({
      type: 'tool_start',
      instanceId: 'bounded-calls',
      submissionId: 'bounded-calls-submission',
      toolCallId: `call-${index}`,
      descriptor,
    });
    reducer.observe({
      type: 'tool',
      instanceId: 'bounded-calls',
      submissionId: 'bounded-calls-submission',
      toolCallId: `call-${index}`,
      descriptor,
      isError: false,
    });
  }
  assert.equal(reducer.observe({
    type: 'tool_start',
    instanceId: 'bounded-calls',
    submissionId: 'bounded-calls-submission',
    toolCallId: 'call-over-limit',
    descriptor,
  }), undefined);
  assert.equal(reducer.observe({
    type: 'tool_start',
    instanceId: 'bounded-calls',
    submissionId: 'bounded-calls-submission',
    toolCallId: 'call-after-suppression',
    descriptor,
  }), undefined);
});
