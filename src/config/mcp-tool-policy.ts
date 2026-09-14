import type { McpConnectionConfig } from './types.ts';

/** Owner declarations take precedence over the last discovered server hint. */
export function mcpToolEffect(connection: Pick<McpConnectionConfig, 'toolPolicies' | 'discoveredTools'>, name: string): boolean | undefined {
  const declared = connection.toolPolicies?.[name];
  if (declared) return declared.effect === 'read';
  return connection.discoveredTools.find((tool) => tool.name === name)?.readOnlyHint;
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
