import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FlueEventContext,
  FlueExecutionContext,
  FlueExecutionOperation,
  FlueObservation,
  LlmMessage,
} from '@flue/runtime';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { serializeCurrentRequestEnvelope } from '../src/memory/tool-policy.ts';
import {
  observePresentationToolPolicy,
  presentationToolPolicyInterceptor,
  SlackAnswerOnlyToolDeniedError,
  SlackPresentationToolUnavailableError,
} from '../src/slack/presentation-tool-policy.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import { SLACK_PRESENT_TABLE_TOOL_NAME } from '../src/slack/table-presentation.ts';

const EXECUTION_CONTEXT = {
  agentName: CHICKPEA_SLACK_AGENT_NAME,
  instanceId: 'instance_presentation_policy',
  submissionId: 'submission_presentation_policy',
} satisfies FlueExecutionContext;

const OBSERVATION_CONTEXT = {
  agentName: CHICKPEA_SLACK_AGENT_NAME,
} as unknown as FlueEventContext;

function currentPrompt(offered = true): string {
  return [
    'Current request: explain the tradeoffs.',
    serializeCurrentRequestEnvelope(
      'Explain the tradeoffs.',
      false,
      'U_POLICY',
      '1785700300.000100',
      { schemaVersion: 2, progressiveStreamingOffered: offered },
    ),
  ].join('\n');
}

function observeTurn(messages: LlmMessage[]): void {
  observePresentationToolPolicy({
    type: 'turn_request',
    purpose: 'agent',
    request: {
      input: { messages },
    },
  } as unknown as FlueObservation, OBSERVATION_CONTEXT);
}

function executeTool<T>(toolName: string, toolCallId: string, next: () => Promise<T>): Promise<T> {
  return presentationToolPolicyInterceptor(
    { type: 'tool', toolName, toolCallId },
    EXECUTION_CONTEXT,
    next,
  );
}

function withSubmission<T>(run: () => Promise<T>): Promise<T> {
  const operation: FlueExecutionOperation = {
    type: 'agent',
    operationId: 'submission_presentation_policy',
    operationKind: 'prompt',
  };
  return presentationToolPolicyInterceptor(operation, EXECUTION_CONTEXT, run);
}

test('a successful declaration arms answer-only authority before later tools execute', async () => {
  await withSubmission(async () => {
    observeTurn([{ role: 'user', content: currentPrompt(true) }]);
    assert.equal(
      await executeTool(SLACK_STREAM_ANSWER_TOOL_NAME, 'call_stream', async () => 'noted'),
      'noted',
    );

    for (const toolName of [
      'read',
      'write',
      'remember_memory',
      'manage_slack_workspace',
      'bash',
      'post_artifact',
      'mcp__docs__search',
    ]) {
      let executed = false;
      await assert.rejects(
        () => executeTool(toolName, `call_denied_${toolName}`, async () => {
          executed = true;
          return 'must not execute';
        }),
        SlackAnswerOnlyToolDeniedError,
      );
      assert.equal(executed, false, toolName);
    }
  });
});

test('an envelope without the frozen offer cannot execute the declaration tool', async () => {
  await withSubmission(async () => {
    observeTurn([{ role: 'user', content: currentPrompt(false) }]);
    let executed = false;
    await assert.rejects(
      () => executeTool(SLACK_STREAM_ANSWER_TOOL_NAME, 'call_unavailable', async () => {
        executed = true;
        return 'must not execute';
      }),
      SlackPresentationToolUnavailableError,
    );
    assert.equal(executed, false);
  });
});

test('a failed declaration does not arm the answer-only lock', async () => {
  await withSubmission(async () => {
    observeTurn([{ role: 'user', content: currentPrompt(true) }]);
    await assert.rejects(
      () => executeTool(SLACK_STREAM_ANSWER_TOOL_NAME, 'call_stream_failed', async () => {
        throw new Error('synthetic declaration failure');
      }),
      /synthetic declaration failure/,
    );
    assert.equal(
      await executeTool('read', 'call_read_after_failure', async () => 'allowed'),
      'allowed',
    );
  });
});

test('a successful table presentation locks later data-changing tools', async () => {
  await withSubmission(async () => {
    observeTurn([{ role: 'user', content: currentPrompt(true) }]);
    assert.equal(
      await executeTool(SLACK_PRESENT_TABLE_TOOL_NAME, 'call_table', async () => 'recorded'),
      'recorded',
    );
    await assert.rejects(
      () => executeTool('mcp__docs__search', 'call_after_table', async () => 'must not execute'),
      SlackAnswerOnlyToolDeniedError,
    );
  });
});

test('resumed turns rehydrate a successful table presentation as answer-only', async () => {
  await withSubmission(async () => {
    observeTurn([
      { role: 'user', content: currentPrompt(true) },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall', id: 'call_durable_table', name: SLACK_PRESENT_TABLE_TOOL_NAME,
          arguments: {},
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call_durable_table',
        toolName: SLACK_PRESENT_TABLE_TOOL_NAME,
        content: [{ type: 'text', text: 'Table recorded.' }],
        isError: false,
      },
    ]);
    await assert.rejects(
      () => executeTool('write', 'call_after_resumed_table', async () => 'must not execute'),
      SlackAnswerOnlyToolDeniedError,
    );
  });
});

test('same-batch tools may start concurrently, but later tool work is denied', async () => {
  await withSubmission(async () => {
    observeTurn([{ role: 'user', content: currentPrompt(true) }]);
    let releaseDeclaration!: () => void;
    const declarationGate = new Promise<void>((resolve) => {
      releaseDeclaration = resolve;
    });
    const declaration = executeTool(
      SLACK_STREAM_ANSWER_TOOL_NAME,
      'call_stream_batch',
      async () => {
        await declarationGate;
        return 'noted';
      },
    );
    assert.equal(
      await executeTool('read', 'call_same_batch', async () => 'same batch executed'),
      'same batch executed',
    );
    releaseDeclaration();
    await declaration;

    await assert.rejects(
      () => executeTool('write', 'call_later_batch', async () => 'must not execute'),
      SlackAnswerOnlyToolDeniedError,
    );
  });
});

test('resumed turns rehydrate only a successful declaration after the newest user message', async () => {
  const successfulHistory: LlmMessage[] = [
    { role: 'user', content: currentPrompt(true) },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall', id: 'call_durable_stream', name: SLACK_STREAM_ANSWER_TOOL_NAME,
        arguments: {},
      }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_durable_stream',
      toolName: SLACK_STREAM_ANSWER_TOOL_NAME,
      content: [{ type: 'text', text: 'Delivery preference noted.' }],
      isError: false,
    },
  ];

  await withSubmission(async () => {
    observeTurn(successfulHistory);
    await assert.rejects(
      () => executeTool('mcp__docs__search', 'call_after_resume', async () => 'must not execute'),
      SlackAnswerOnlyToolDeniedError,
    );
  });

  await withSubmission(async () => {
    observeTurn([
      ...successfulHistory,
      { role: 'user', content: currentPrompt(true) },
    ]);
    assert.equal(
      await executeTool('mcp__docs__search', 'call_new_response', async () => 'new response'),
      'new response',
    );
  });
});
