import { createHash } from 'node:crypto';

import { MCP_WORKSPACE_SCOPE } from '../../auth/mcp-oauth.ts';
import { AgentPresenceError } from '../../slack/agent-presence/errors.ts';
import type { PlaybookTopic } from '../playbook/index.ts';
import { ManagementError } from '../types.ts';
import type { HeldTokens } from './card-host.ts';

/**
 * The conventions every 5.0 management tool follows (U2 design note §2.1 and
 * §5): three explicit hints, OAuth `securitySchemes`, an `outputSchema`, one
 * error shape, and opaque handles in place of internal IDs and revisions.
 */

/** Every tool needs the signed-in person's workspace grant; none runs unauthenticated. */
export const MCP_TOOL_SECURITY_SCHEMES = Object.freeze([
  Object.freeze({ type: 'oauth2', scopes: Object.freeze([MCP_WORKSPACE_SCOPE]) }),
]);

/** Reads only Chickpea's own state. */
export const READ_HINTS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

/**
 * A write's hints under OpenAI's rules: an overwrite, removal, revocation or
 * irreversible send is destructive, whether or not undo can reverse it. A
 * retry with the same idempotencyKey replays, so a keyed write is idempotent.
 */
export function writeHints(input: { destructive: boolean; openWorld?: boolean; idempotent?: boolean }) {
  return Object.freeze({
    readOnlyHint: false,
    destructiveHint: input.destructive,
    idempotentHint: input.idempotent ?? true,
    openWorldHint: input.openWorld ?? false,
  });
}

export type McpToolVisibility = 'model' | 'app';

/**
 * Descriptor `_meta`: the `securitySchemes` mirror OpenAI documents for clients
 * that read only `_meta`, `ui.visibility` for a tool only a card calls, and
 * `ui.resourceUri` for a tool whose result a card draws. ChatGPT also reads
 * the older `openai/outputTemplate` name for that link.
 */
export function toolMeta(input: {
  visibility?: readonly McpToolVisibility[];
  profile?: true;
  card?: string;
} = {}) {
  const ui = {
    ...(input.card ? { resourceUri: input.card } : {}),
    ...(input.visibility ? { visibility: [...input.visibility] } : {}),
  };
  return {
    securitySchemes: MCP_TOOL_SECURITY_SCHEMES,
    ...(Object.keys(ui).length ? { ui } : {}),
    ...(input.card ? { 'openai/outputTemplate': input.card } : {}),
    ...(input.profile ? { 'openai/profile': true } : {}),
  };
}

/**
 * Sends a client with no Chickpea skill to one job's guide. It goes in the
 * description of each tool that starts the job, and in the next step of a
 * result that starts the job's next part: ChatGPT without skills skipped the
 * server instructions' pointer to get_guide, but it reads both of these.
 */
export function guideFirst(topic: PlaybookTopic): string {
  return `With no Chickpea skill loaded, call get_guide topic ${topic} first.`;
}

/**
 * The opaque token a 5.0 write takes in place of a revision number. Equal
 * state gives an equal token; nothing is decoded from it, and knowing a
 * revision grants nothing, so no secret goes in.
 */
export function versionToken(kind: string, id: string, revision: number, organizationId: string): string {
  return createHash('sha256')
    .update(`${kind}:${id}:${revision}:${organizationId}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The profile ID ChatGPT keys a connected account on. Frozen: OpenAI stores
 * it and it must never change or be reused, so changing this derivation is a
 * T3 change.
 */
export function accountProfileId(organizationId: string, membershipId: string): string {
  return createHash('sha256')
    .update(`chickpea-profile:v1:${organizationId}:${membershipId}`)
    .digest('hex')
    .slice(0, 32);
}

export const MCP_ERROR_CODES = [
  'not_allowed',
  'not_found',
  'invalid_input',
  'changed_since_read',
  'confirmation_expired',
  'in_progress',
  'key_reused',
  'still_in_use',
  'setup_link_unusable',
  'model_unavailable',
  'slack_unavailable',
  'schedule_unavailable',
  'nothing_to_undo',
  'usage_limit',
  'temporarily_unavailable',
  'tool_removed',
  /** A test run: a connection the caller has yet to finish setting up. */
  'needs_setup',
  /** A test run: a connection with no tool declared a read. */
  'not_testable',
  /** A test run: this deployment serves none. */
  'test_run_unavailable',
] as const;

export type McpErrorCode = typeof MCP_ERROR_CODES[number];

export type McpErrorFix =
  | { label: string; url: string }
  | { label: string; tool: string; arguments: Record<string, unknown> };

/** A type alias, so it fits `structuredContent`'s index signature. */
export type McpToolError = {
  code: McpErrorCode;
  /** Plain, for the person; never a key or an internal ID. */
  message: string;
  retryable: boolean;
  /** For the model: what to do next. */
  nextStep?: string;
  fix?: McpErrorFix;
};

/** A refusal a 5.0 tool raises itself, already in the 5.0 shape. */
export class McpToolFailure extends Error {
  readonly name = 'McpToolFailure';

  constructor(readonly error: McpToolError) {
    super(error.message);
  }
}

export function fail(
  code: McpErrorCode,
  message: string,
  options: { nextStep?: string; fix?: McpErrorFix; retryable?: boolean } = {},
): never {
  throw new McpToolFailure({
    code,
    message,
    retryable: options.retryable ?? RETRYABLE.has(code),
    ...(options.nextStep ? { nextStep: options.nextStep } : {}),
    ...(options.fix ? { fix: options.fix } : {}),
  });
}

const RETRYABLE: ReadonlySet<McpErrorCode> = new Set([
  'changed_since_read', 'confirmation_expired', 'in_progress', 'slack_unavailable', 'temporarily_unavailable',
]);

/** Today's service codes (`ManagementError`, `AgentPresenceError`) in the 5.0 vocabulary. */
const SERVICE_CODES: Readonly<Record<string, McpErrorCode>> = {
  forbidden: 'not_allowed',
  owner_required: 'not_allowed',
  operational_access_required: 'not_allowed',
  proposal_binding_mismatch: 'not_allowed',
  operation_not_found: 'not_found',
  proposal_not_found: 'not_found',
  setup_not_found: 'not_found',
  mcp_client_not_found: 'not_found',
  invalid_request: 'invalid_input',
  invalid_state: 'invalid_input',
  incomplete_search: 'invalid_input',
  base_agent_capabilities_require_setup: 'invalid_input',
  key_rejected: 'invalid_input',
  key_unconfirmed: 'invalid_input',
  revision_conflict: 'changed_since_read',
  proposal_stale: 'changed_since_read',
  operation_in_progress: 'in_progress',
  idempotency_conflict: 'key_reused',
  still_referenced: 'still_in_use',
  setup_unavailable: 'setup_link_unusable',
  setup_expired: 'setup_link_unusable',
  setup_session_mismatch: 'setup_link_unusable',
  model_provider_unavailable: 'model_unavailable',
  effort_not_supported: 'model_unavailable',
  effort_requires_model: 'model_unavailable',
  slack_unavailable: 'slack_unavailable',
  slack_refused: 'slack_unavailable',
  routines_unavailable_on_target: 'schedule_unavailable',
  schedule_authority_missing: 'schedule_unavailable',
  undo_unavailable: 'nothing_to_undo',
  proposal_expired: 'confirmation_expired',
  removal_incomplete: 'temporarily_unavailable',
  // The codes a change's own outcome carries when it did not apply.
  not_found: 'not_found',
  already_exists: 'invalid_input',
  operation_failed: 'temporarily_unavailable',
};

/** A service or outcome code in the 5.0 vocabulary. */
export function fiveZeroCode(code: string): McpErrorCode {
  return SERVICE_CODES[code] ?? 'invalid_input';
}

export function isRetryable(code: McpErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Service codes a retry cannot fix, though a retry often fixes their 5.0 code. */
const PERMANENT_SERVICE_CODES: ReadonlySet<string> = new Set(['slack_refused']);

/** Whether the same call can work later, for a service or outcome code. */
export function serviceCodeRetryable(code: string): boolean {
  return !PERMANENT_SERVICE_CODES.has(code) && RETRYABLE.has(fiveZeroCode(code));
}

const UNEXPECTED: McpToolError = {
  code: 'temporarily_unavailable',
  message: 'Chickpea could not finish that request.',
  retryable: true,
  nextStep: 'Try the same call again in a moment.',
};

/** Any failure as the 5.0 error; an unexpected one never carries its own text. */
export function mcpToolError(error: unknown): McpToolError {
  if (error instanceof McpToolFailure) return error.error;
  if (error instanceof AgentPresenceError) {
    return {
      code: 'slack_unavailable',
      message: error.message,
      retryable: error.options.retryable ?? true,
    };
  }
  if (error instanceof ManagementError) {
    const code = fiveZeroCode(error.code);
    return {
      code,
      message: error.message,
      retryable: serviceCodeRetryable(error.code),
      ...(error.links?.admin ? { fix: { label: 'Open Chickpea Admin', url: error.links.admin } } : {}),
    };
  }
  return UNEXPECTED;
}

/**
 * The text clients show: the message, the next step, then the fix's label and
 * link. A client that passes only `content` to its model still gets them.
 */
export function mcpErrorText(error: McpToolError): string {
  return [
    error.message,
    error.nextStep,
    error.fix && 'url' in error.fix ? `${error.fix.label}: ${error.fix.url}` : undefined,
  ].filter((line): line is string => line !== undefined).join('\n');
}

/**
 * A listed output schema that accepts fields it does not name. A client may
 * check each result against the schema it listed and keep that listing, so
 * an `additionalProperties: false` anywhere in it would refuse every result
 * once a release adds a field there (`tools` on `get_agent`). The server still
 * checks its own results strictly before they leave (tools.ts).
 */
export function openOutputSchema<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map(openOutputSchema) as T;
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) =>
    key === 'additionalProperties' && value === false ? [] : [[key, openOutputSchema(value)]])) as T;
}

export function mcpErrorResult(error: McpToolError) {
  return {
    content: [{ type: 'text' as const, text: mcpErrorText(error) }],
    structuredContent: { error },
    isError: true as const,
  };
}

/**
 * A success: `structuredContent` matches the tool's `outputSchema`, and the
 * text block carries the same JSON for a client that passes only `content` to
 * its model, so no handle a follow-up call needs is lost there. A tool may
 * give its own `text`, which must carry those handles too. A result a
 * card draws names its tool in `_meta`, which only the card reads: hosts do
 * not say which tool a result came from. The tokens a card holds go there too.
 * `lead` comes before the JSON, for a card host's model: what the card shows.
 */
export function mcpSuccessResult<T extends Record<string, unknown>>(
  structured: T,
  card?: { tool: string; held?: HeldTokens | undefined; lead?: string | undefined },
  text: string = JSON.stringify(structured),
) {
  return {
    content: [
      ...card?.lead ? [{ type: 'text' as const, text: card.lead }] : [],
      { type: 'text' as const, text },
    ],
    structuredContent: structured,
    ...(card ? { _meta: { 'chickpea/tool': card.tool, ...card.held ? { 'chickpea/held': card.held } : {} } } : {}),
  };
}
