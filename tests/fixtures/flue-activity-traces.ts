/**
 * Content-free trace projections captured from Flue's documented v3 event
 * contract. These fixtures intentionally retain only event identity and
 * correlation fields used by semantic activity narration.
 */
export const FLUE_ACTIVITY_TRACES = {
  ordinaryTopLevelAnswer: [
    { type: 'submission_queued', submissionId: 'ordinary', kind: 'dispatch' },
    {
      type: 'submission_running',
      submissionId: 'ordinary',
      kind: 'dispatch',
      attemptCount: 1,
      maxAttempts: 3,
    },
    {
      type: 'operation_start',
      submissionId: 'ordinary',
      operationId: 'operation_ordinary',
      operationKind: 'prompt',
    },
    {
      type: 'turn_start',
      submissionId: 'ordinary',
      operationId: 'operation_ordinary',
      turnId: 'turn_ordinary',
      purpose: 'agent',
    },
    {
      type: 'text_delta',
      submissionId: 'ordinary',
      operationId: 'operation_ordinary',
      turnId: 'turn_ordinary',
      text: 'provider content must never be inspected',
    },
    {
      type: 'submission_settled',
      submissionId: 'ordinary',
      outcome: 'completed',
    },
  ],
  progressiveAnswer: [
    {
      type: 'tool_start',
      submissionId: 'progressive',
      operationId: 'operation_progressive',
      turnId: 'turn_declaration',
      toolName: 'stream_answer',
      toolCallId: 'call_stream',
    },
    {
      type: 'tool',
      submissionId: 'progressive',
      operationId: 'operation_progressive',
      turnId: 'turn_declaration',
      toolName: 'stream_answer',
      toolCallId: 'call_stream',
      isError: false,
    },
    {
      type: 'text_delta',
      submissionId: 'progressive',
      operationId: 'operation_progressive',
      turnId: 'turn_answer',
      text: 'answer content must never be inspected',
    },
  ],
  nestedStructuredOutput: [
    {
      type: 'tool_start',
      submissionId: 'structured',
      operationId: 'operation_structured',
      turnId: 'turn_structured',
      toolName: 'submit_result',
      toolCallId: 'call_result',
    },
    {
      type: 'tool',
      submissionId: 'structured',
      operationId: 'operation_structured',
      turnId: 'turn_structured',
      toolName: 'submit_result',
      toolCallId: 'call_result',
      isError: false,
    },
  ],
  intermediateTextThenTool: [
    {
      type: 'text_delta',
      submissionId: 'intermediate',
      operationId: 'operation_intermediate',
      turnId: 'turn_tool_request',
      text: 'intermediate text must never authorize drafting',
    },
    {
      type: 'tool_start',
      submissionId: 'intermediate',
      operationId: 'operation_intermediate',
      turnId: 'turn_tool_request',
      toolName: 'gmail_search_messages',
      toolCallId: 'call_gmail',
    },
  ],
  toolAfterText: [
    {
      type: 'text_delta',
      submissionId: 'tool-after-text',
      operationId: 'operation_tool_after_text',
      turnId: 'turn_tool_after_text',
      text: 'early answer-looking text is not a terminal-answer signal',
    },
    {
      type: 'tool_start',
      submissionId: 'tool-after-text',
      operationId: 'operation_tool_after_text',
      turnId: 'turn_tool_after_text',
      toolName: 'gmail_search_messages',
      toolCallId: 'call_after_text',
    },
    {
      type: 'tool',
      submissionId: 'tool-after-text',
      operationId: 'operation_tool_after_text',
      turnId: 'turn_tool_after_text',
      toolName: 'gmail_search_messages',
      toolCallId: 'call_after_text',
      isError: false,
    },
  ],
} as const;
