import { isMetaAdsMcpConnection, metaAdsToolEffect } from './meta-ads-policy.ts';
import type { McpConnectionConfig, McpToolPolicy } from './types.ts';

/**
 * The stored tool policies a change to a connection's allowed tools keeps:
 * whole for tools allowed both before it and after it. Any other tool loses
 * its mark, so an old read mark, which nobody can see while its tool is not
 * allowed, never comes back with it (withoutMarks).
 */
export function keptToolPolicies(
  before: { allowedTools: readonly string[]; toolPolicies?: Record<string, McpToolPolicy> },
  allowedTools: readonly string[],
): Record<string, McpToolPolicy> {
  return withoutMarks(before.toolPolicies, (tool) => !before.allowedTools.includes(tool) || !allowedTools.includes(tool));
}

/**
 * The tool policies with the named tools' marks dropped. An argument limit
 * is a restriction on every Slack turn, not a mark, so it stays with its
 * tool, which is stored as a write: a test run never calls it.
 */
export function withoutMarks(
  toolPolicies: Record<string, McpToolPolicy> | undefined,
  unmark: (tool: string) => boolean,
): Record<string, McpToolPolicy> {
  return Object.fromEntries(Object.entries(toolPolicies ?? {}).flatMap(([tool, policy]) => {
    if (!unmark(tool)) return [[tool, policy]];
    return policy.argumentConstraints ? [[tool, { effect: 'write', argumentConstraints: policy.argumentConstraints }]] : [];
  }));
}

/** Owner declarations take precedence over the last discovered server hint. */
export function mcpToolEffect(connection: Pick<McpConnectionConfig, 'toolPolicies' | 'discoveredTools'>, name: string): boolean | undefined {
  const declared = connection.toolPolicies?.[name];
  if (declared) return declared.effect === 'read';
  return connection.discoveredTools.find((tool) => tool.name === name)?.readOnlyHint;
}

/**
 * A tool a test run may call: an Admin declared it a read, since a server's
 * own hint is not a declaration, and a Meta Ads tool is also a reviewed read.
 * A server that says the tool changes things outranks the mark, whichever
 * door set it and however long ago.
 */
export function mcpToolDeclaredRead(
  connection: Pick<McpConnectionConfig, 'toolPolicies' | 'presetId' | 'url' | 'discoveredTools'>,
  name: string,
): boolean {
  return connection.toolPolicies?.[name]?.effect === 'read' && !mcpServerSaysWrites(connection, name) &&
    (!isMetaAdsMcpConnection(connection) || metaAdsToolEffect(name) === 'read');
}

/** The server's last discovery said this tool changes things (readOnlyHint false); no hint says nothing. */
export function mcpServerSaysWrites(connection: Pick<McpConnectionConfig, 'discoveredTools'>, name: string): boolean {
  return connection.discoveredTools.some((tool) => tool.name === name && tool.readOnlyHint === false);
}

/** Enforced at outbound MCP invocation, before sending the tool request. */
export function assertMcpToolArguments(
  name: string,
  argumentsValue: unknown,
  constraints: Record<string, Record<string, string[]>> | undefined,
): void {
  const required = constraints?.[name];
  if (!required) return;
  const args = argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown> : {};
  for (const [key, allowed] of Object.entries(required)) {
    if (typeof args[key] !== 'string' || !allowed.includes(args[key] as string)) {
      throw new Error(`This connection permits ${key} only with an approved value: ${allowed.join(', ')}.`);
    }
  }
}

/** Reject arguments absent from the authenticated tool schema projection. */
export function assertMcpToolArgumentKeys(
  name: string,
  argumentsValue: unknown,
  propertyNames: readonly string[],
): void {
  if (argumentsValue === undefined) return;
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new Error(`MCP tool ${name} requires an object argument.`);
  }
  const allowed = new Set(propertyNames);
  for (const key of Object.keys(argumentsValue)) {
    if (!allowed.has(key)) {
      throw new Error(`MCP tool ${name} does not permit the argument ${key}.`);
    }
  }
}
