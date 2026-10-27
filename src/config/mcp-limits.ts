/**
 * Tools kept per MCP server; every write path shares this bound. Discovery
 * drops whatever a server lists past it, so it must cover documented vendor
 * servers. With the shared-prefix tools it must also stay under a provider's
 * per-request tool limit (OpenAI accepts at most 128 functions).
 */
export const MAX_MCP_TOOLS = 64;

/** Stored MCP OAuth scopes and every sign-in start share this bound. */
export const MAX_MCP_OAUTH_SCOPE_LENGTH = 4_096;
