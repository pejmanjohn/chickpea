import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AgentPromptFailure,
  classifyAgentPromptFailure,
} from '../src/slack/agent-dispatch.ts';
import { agentFailureText } from '../src/slack/run-turn.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_DISABLED_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
} from '../src/slack/web-client-presenter.ts';

function envelope(type: string, message: string): string {
  return JSON.stringify({ error: { type, message, details: 'private detail' } });
}

test('agent prompt failure classification distinguishes provider, sandbox, and unknown errors', () => {
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (preview_disabled).'),
    ),
    'openai-subscription-disabled',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('sandbox_unavailable', 'The coding workspace is temporarily unavailable.'),
    ),
    'sandbox',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope(
        'operation_failed',
        'Agent turn failed: Maximum number of running container instances exceeded.',
      ),
    ),
    'sandbox',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('sandbox_session_cap_reached', 'Monthly limit reached.'),
    ),
    'sandbox-session-cap',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('cloudflare_ai_binding_error', 'Cloudflare AI binding request failed.'),
    ),
    'provider',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (auth_reconnect_required).'),
    ),
    'openai-subscription-reconnect',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (subscription_quota_exhausted).'),
    ),
    'openai-subscription-quota',
  );
  assert.equal(
    classifyAgentPromptFailure(
      500,
      envelope('operation_failed', 'OpenAI subscription operation failed (originator_rejected).'),
    ),
    'openai-subscription-policy',
  );
  assert.equal(
    classifyAgentPromptFailure(500, envelope('operation_failed', 'Tool execution failed.')),
    'agent',
  );
  assert.equal(classifyAgentPromptFailure(500, 'not-json'), 'agent');
});

test('Slack failure copy uses only the public-safe failure category', () => {
  assert.equal(agentFailureText(new AgentPromptFailure('provider', 500)), PROVIDER_FAILURE_TEXT);
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-disabled', 500)),
    OPENAI_SUBSCRIPTION_DISABLED_TEXT,
  );
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-reconnect', 500)),
    OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  );
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-quota', 500)),
    OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  );
  assert.equal(
    agentFailureText(new AgentPromptFailure('openai-subscription-policy', 500)),
    OPENAI_SUBSCRIPTION_POLICY_TEXT,
  );
  assert.equal(agentFailureText(new AgentPromptFailure('sandbox', 500)), SANDBOX_FAILURE_TEXT);
  assert.equal(
    agentFailureText(new AgentPromptFailure('sandbox-session-cap', 500)),
    SANDBOX_SESSION_CAP_FAILURE_TEXT,
  );
  assert.equal(agentFailureText(new AgentPromptFailure('agent', 500)), AGENT_FAILURE_TEXT);
  assert.equal(agentFailureText(new Error('raw secret')), AGENT_FAILURE_TEXT);
});
