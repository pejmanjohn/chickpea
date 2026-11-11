import type { FlueObservation, McpConnectionDefinition } from '@flue/runtime';
import { ConnectionCredentialUnavailableError } from '../connections/errors.ts';
import { opaqueId } from '../work/admission.ts';
import { McpBlockedUrlError, McpConnectionChangedError, McpToolsListRefusedError } from './mcp-errors.ts';

export type McpUnavailableReason =
  | 'auth' | 'network' | 'timeout' | 'blocked_url' | 'policy_changed' | 'tools_list_refused' | 'http_error'
  | 'allowlist' | 'task_support' | 'duplicate_tool_name' | 'other';

interface Cause {
  reason: McpUnavailableReason;
  status?: number;
}

/**
 * Flue connects each definition at most once, so one definition is one
 * connection attempt. By instance and connection, the latest attempt and the
 * last failure Chickpea saw on it.
 */
const attempts = new Map<string, { cause?: Cause }>();
const MAX_ATTEMPTS = 256;

/**
 * Keep the last failure on this connection's own requests, read from the HTTP
 * status or the error's type, for the line logged if Flue drops it.
 */
export function withMcpFailureCause(
  definition: McpConnectionDefinition,
  instanceId: string,
): McpConnectionDefinition {
  const key = `${instanceId}\n${definition.name}`;
  let attempt: { cause?: Cause } | undefined;
  const begin = () => {
    if (!attempt) {
      attempt = {};
      attempts.delete(key);
      if (attempts.size >= MAX_ATTEMPTS) attempts.delete(attempts.keys().next().value!);
      attempts.set(key, attempt);
    }
    return attempt;
  };
  const { fetch: fetchFn, auth } = definition;
  return {
    ...definition,
    ...(fetchFn ? {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const current = begin();
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        // The client sends its requests one at a time, so a POST replaces what an
        // earlier one left, such as a 401 before its retry.
        if (method === 'POST') delete current.cause;
        let response: Response;
        try {
          response = await fetchFn(input, init);
        } catch (error) {
          const cause = thrownCause(error);
          if (cause) current.cause = cause;
          throw error;
        }
        if (response.status === 401 || response.status === 403) {
          current.cause = { reason: 'auth', status: response.status };
        } else if (!response.ok && !(method === 'GET' && response.status === 405)) {
          current.cause = { reason: 'http_error', status: response.status };
        }
        return response;
      },
    } : {}),
    ...(typeof auth === 'function' ? {
      auth: async () => {
        const current = begin();
        try {
          return await auth();
        } catch (error) {
          current.cause = { reason: error instanceof McpConnectionChangedError ? 'policy_changed' : 'auth' };
          throw error;
        }
      },
    } : {}),
  };
}

function thrownCause(error: unknown): Cause | undefined {
  if (error instanceof McpConnectionChangedError) return { reason: 'policy_changed' };
  if (error instanceof McpToolsListRefusedError) return { reason: 'tools_list_refused' };
  if (error instanceof ConnectionCredentialUnavailableError) return { reason: 'auth' };
  if (error instanceof McpBlockedUrlError) return { reason: 'blocked_url' };
  const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
  // The MCP client aborts a request it stops waiting for, and every open one when it closes. It reports why.
  if (name === 'AbortError') return undefined;
  if (name === 'TimeoutError' || code === 'ETIMEDOUT') return { reason: 'timeout' };
  // fetch rejects with a TypeError, and Node's https request with a system error code, when no answer arrives.
  if (error instanceof TypeError || (typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code))) {
    return { reason: 'network' };
  }
  return { reason: 'other' };
}

/** What Flue reports when it cannot connect, read from its own fixed wording and the MCP client's. */
function messageReason(server: string, message: string): McpUnavailableReason {
  if (message === 'Request timed out' || message === 'Maximum total timeout exceeded') return 'timeout';
  if ((message.startsWith(`[flue] MCP server "${server}" does not expose `) &&
      message.includes(' named in the tools allowlist. Discovered tools: ')) ||
      message.startsWith(`[flue] MCP server "${server}" tools allowlist repeats `)) {
    return 'allowlist';
  }
  if (message.startsWith('[flue] MCP tool "') &&
      message.includes(`" from server "${server}" requires task-based execution, which is not supported`)) {
    return 'task_support';
  }
  if (message.startsWith(`[flue] MCP tools from server "${server}" produced duplicate tool name "`)) {
    return 'duplicate_tool_name';
  }
  return 'other';
}

/**
 * Flue drops an optional MCP connection that fails to resolve, mounting none
 * of its tools, with one warning per submission. Log it with a reason code.
 * Never Flue's message: it can list the server's tools or quote the server.
 */
export function emitMcpConnectionUnavailable(
  observation: FlueObservation,
  sink: { info(record: Record<string, unknown>): void } = console,
): void {
  if (observation.type !== 'log' || observation.level !== 'warn') return;
  const { server, reason } = observation.attributes ?? {};
  if (typeof server !== 'string' || typeof reason !== 'string' ||
      observation.message !== `MCP server "${server}" is unavailable; its tools are not mounted for this submission.`) {
    return;
  }
  try {
    const { instanceId, submissionId } = observation;
    const cause = (instanceId ? attempts.get(`${instanceId}\n${server}`)?.cause : undefined) ??
      { reason: messageReason(server, reason) };
    sink.info({
      event: 'chickpea.mcp.connection_unavailable',
      connectionId: /^[A-Za-z0-9_.:-]{1,128}$/.test(server) ? server : '(other)',
      reason: cause.reason,
      ...(cause.status === undefined ? {} : { status: cause.status }),
      ...(observation.instanceId ? { flueInstanceRef: opaqueId('flueinstance', observation.instanceId) } : {}),
      ...(submissionId ? { flueSubmissionRef: opaqueId('fluesubmission', submissionId) } : {}),
    });
  } catch {
    // Diagnostics must not affect execution, including when the sink fails.
  }
}
