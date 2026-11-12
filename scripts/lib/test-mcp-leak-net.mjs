/**
 * Preloaded into every test file's process by scripts/run-tests.mjs.
 *
 * The 4.x leak net: no result of Chickpea's management MCP server names one of
 * the 21 4.x tools, which 5.0.0 removes, so a client on the 5.0 tools is never
 * told to call one. It reads every `tools/call` answer the server sends, as
 * the client gets it: successes and errors, in `content` and
 * `structuredContent`. It skips only a 4.x tool's own answer while the server
 * still serves that tool.
 *
 * Allowed, by name:
 * - explain_agent's list of the tools an Agent has in Slack: a string that is
 *   exactly one tool's name (src/management/mcp-v5/explain.ts);
 * - run history (list_agent_runs, get_agent_run): the quoted words of a Slack
 *   turn, `ask` and `reply`, which can name the tools that turn called;
 * - the removal answer, an error whose code is `tool_removed`.
 *
 * Test fixtures must not put the 21 names into user text (instructions,
 * skills, memory): the net cannot tell user text from Chickpea's.
 *
 * Each hit fails the test that made it, in a root afterEach; a root after
 * catches one made outside a test. The net never throws inside
 * `transport.send`, where a throw would land in the SDK's response path.
 *
 * It stops regressions on the paths tests exercise. A grep of src/management
 * sorted the rest when it was added (U3c, PR B).
 */
import { after, afterEach } from 'node:test';

import {
  InMemoryTransport,
  McpServer,
  PerRequestHTTPServerTransport,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';

/** The 4.x tools, as `WORKSPACE_MANAGEMENT_MCP_V4_TOOL_NAMES` lists them (tests/mcp-leak-net.test.ts). */
export const V4_TOOL_NAMES = Object.freeze([
  'inspect_workspace',
  'prepare_connector_setup',
  'prepare_provider_setup',
  'discover_slack_channels',
  'test_connection',
  'save_connection_key',
  'try_connection',
  'inspect_memory',
  'inspect_routines',
  'export_workspace_recipe',
  'preview_workspace_recipe',
  'import_skill',
  'upload_skills',
  'manage_agent_skill',
  'apply_workspace_changes',
  'confirm_workspace_change',
  'undo_workspace_change',
  'get_operation',
  'revoke_setup_link',
  'list_mcp_clients',
  'revoke_mcp_client',
]);

const V4 = new Set(V4_TOOL_NAMES);
const NAMED = new RegExp(`\\b(?:${V4_TOOL_NAMES.join('|')})\\b`, 'g');
const SERVER_NAME = 'chickpea-workspace';
const RUN_HISTORY = new Set(['list_agent_runs', 'get_agent_run']);
const QUOTED = new Set(['ask', 'reply']);

/**
 * Where one tool's answer names a 4.x tool, outside what the net allows.
 * `answer` is a `tools/call` result, or a JSON-RPC error's `error`.
 */
export function leaksIn(tool, answer) {
  if (answer?.isError === true && answer.structuredContent?.error?.code === 'tool_removed') return [];
  const leaks = [];
  const visit = (value, path) => {
    if (typeof value === 'string') {
      const names = [...new Set(value.match(NAMED) ?? [])];
      if (names.length && !allowed(tool, path, value)) leaks.push({ tool, path: path.join('.'), names, text: excerpt(value) });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key]);
    }
  };
  if ('structuredContent' in (answer ?? {})) visit(answer.structuredContent, ['structuredContent']);
  for (const [index, part] of (Array.isArray(answer?.content) ? answer.content : []).entries()) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    const json = parsed(part.text);
    visit(json ?? part.text, ['content', String(index), ...json ? [] : ['text']]);
  }
  if (typeof answer?.message === 'string') visit(answer.message, ['error', 'message']);
  return leaks;
}

function allowed(tool, path, value) {
  if (tool === 'explain_agent') return V4.has(value);
  if (RUN_HISTORY.has(tool)) return path.some((key) => QUOTED.has(key));
  return false;
}

function parsed(text) {
  if (!/^\s*[[{]/.test(text)) return undefined;
  try {
    const value = JSON.parse(text);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
}

function excerpt(text) {
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

let leaks = [];

/** Every hit recorded since the last call; the net's own test reads them. */
export function takeLeaks() {
  const taken = leaks;
  leaks = [];
  return taken;
}

/** Each watched transport's open `tools/call` requests, by request id. */
const calls = new WeakMap();
const SENDS = new Set();

for (const Transport of [WebStandardStreamableHTTPServerTransport, PerRequestHTTPServerTransport, InMemoryTransport]) {
  const send = Transport.prototype.send;
  const watchedSend = function (message, options) {
    const open = calls.get(this);
    if (open && message && 'id' in message && open.has(message.id) && ('result' in message || 'error' in message)) {
      const tool = open.get(message.id);
      open.delete(message.id);
      try {
        leaks.push(...leaksIn(tool, 'result' in message ? message.result : message.error));
      } catch (error) {
        leaks.push({ tool, path: '', names: [], text: `the leak net could not read this answer: ${error}` });
      }
    }
    return send.call(this, message, options);
  };
  Transport.prototype.send = watchedSend;
  SENDS.add(watchedSend);
}

const connect = McpServer.prototype.connect;
McpServer.prototype.connect = function (transport) {
  if (this.server?._serverInfo?.name === SERVER_NAME) watch(this, transport);
  return connect.call(this, transport);
};

/**
 * Records each `tools/call` this transport receives. Called before the SDK
 * connects, so every request passes here; the server's own wrappers
 * (mcp-v5/transport.ts) are already on `send`, and the patched prototype
 * `send` they call reads each answer after them.
 */
function watch(server, transport) {
  const registered = server._registeredTools;
  if (typeof registered !== 'object' || registered === null) {
    throw new Error('The 4.x leak net cannot read McpServer._registeredTools; update scripts/lib/test-mcp-leak-net.mjs for this SDK.');
  }
  if (!SENDS.has(prototypeSend(transport))) {
    throw new Error(`The 4.x leak net does not watch ${transport?.constructor?.name ?? 'this transport'}; add its class in scripts/lib/test-mcp-leak-net.mjs.`);
  }
  const open = new Map();
  calls.set(transport, open);
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    try {
      const name = message?.method === 'tools/call' && 'id' in message ? message.params?.name : undefined;
      // A 4.x tool's own answer while this server serves it is the 4.x surface, not a leak.
      if (typeof name === 'string' && !(V4.has(name) && Object.hasOwn(registered, name))) open.set(message.id, name);
    } catch {
      // Watching never changes how a message is dispatched.
    }
    onmessage?.(message, extra);
  };
}

function prototypeSend(transport) {
  for (let proto = Object.getPrototypeOf(transport); proto; proto = Object.getPrototypeOf(proto)) {
    if (Object.hasOwn(proto, 'send')) return proto.send;
  }
  return undefined;
}

function failure(found) {
  const lines = found.map(({ tool, path, names, text }) => `  ${tool} ${path}: ${names.join(', ')} in ${JSON.stringify(text)}`);
  return new Error(`A management MCP result names a 4.x tool (scripts/lib/test-mcp-leak-net.mjs):\n${lines.join('\n')}`);
}

afterEach(() => {
  const found = takeLeaks();
  if (found.length) throw failure(found);
});

after(() => {
  const found = takeLeaks();
  if (found.length) throw failure(found);
});
