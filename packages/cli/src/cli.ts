import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { runDoctor, renderDoctorReport } from './doctor.ts';
import { CliError, describeError, formatErrorLine } from './errors.ts';
import { isMcpClient, MCP_CLIENTS, mcpConfigRecord, renderMcpConfig, type McpClient } from './mcp-config.ts';
import { connectManagementClient, login, logout, type AuthDeps } from './oauth.ts';
import { normalizeDeploymentOrigin, mcpUrl } from './origin.ts';
import { Io } from './output.ts';
import { CredentialStore, resolveConfigDir } from './store.ts';
import { callManagementTool, collectEnvelopeHints, renderEnvelopeHints, renderToolList, type ToolEnvelope } from './tools.ts';
import { CLI_VERSION } from './version.ts';
import { renderWorkspaceSummary } from './workspace.ts';

export interface CliDeps {
  fetch: typeof fetch;
  store: CredentialStore;
  env: NodeJS.ProcessEnv;
  now: () => number;
  openBrowser: (url: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => string;
  /** Test hook forwarded to `login`. */
  onAuthorizationUrl?: (url: string) => void;
  loginTimeoutMs?: number;
}

const FORBIDDEN_FLAGS = new Set(['--token', '--bearer', '--api-key', '--slack-token', '--access-token', '--provider-key']);

export const USAGE = `chickpea ${CLI_VERSION}

Usage:
  chickpea doctor <deployment-url>                    Check the public OAuth and MCP surface (no sign-in)
  chickpea mcp config <deployment-url> [--client c]   Print MCP client configuration (${MCP_CLIENTS.join('|')})
  chickpea login <deployment-url>                     Sign in through the browser and save a session
  chickpea logout <deployment-url>                    Revoke the saved session and delete it
  chickpea workspace inspect <deployment-url>         Summarize Agents, channels, providers, and team
  chickpea tools list <deployment-url>                List every management tool
  chickpea call <deployment-url> <tool> [--args json | --args-file file]
                                                      Call a management tool; prints the { ok, result | error } envelope
  chickpea recipe export <deployment-url> [--agents id,id]
  chickpea recipe preview <deployment-url> <recipe.json>

Global flags:
  --json     Machine-readable output on stdout
  --quiet    Suppress progress notes on stderr
  --help     Show this help
  --version  Print the version

The CLI never accepts a token, provider key, or Slack credential. The deployment
issues tokens during login; they live in $XDG_CONFIG_HOME/chickpea or
~/.config/chickpea with mode 0600. The CLI sends no telemetry.
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    if (equals !== -1) {
      flags.set(arg.slice(0, equals), arg.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    const valued = ['--client', '--args', '--args-file', '--agents'];
    if (valued.includes(arg) && next !== undefined && !next.startsWith('--')) {
      flags.set(arg, next);
      index += 1;
    } else {
      flags.set(arg, true);
    }
  }
  return { positional, flags };
}

export function defaultDeps(): CliDeps {
  return {
    fetch,
    store: new CredentialStore(resolveConfigDir(process.env)),
    env: process.env,
    now: Date.now,
    openBrowser: openBrowserDetached,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFileSync(path, 'utf8'),
  };
}

export async function run(argv: readonly string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...overrides };
  const { positional, flags } = parseArgs(argv);
  const io = new Io({
    json: flags.has('--json'),
    quiet: flags.has('--quiet'),
    stdout: deps.stdout,
    stderr: deps.stderr,
  });

  try {
    for (const flag of flags.keys()) {
      if (FORBIDDEN_FLAGS.has(flag)) {
        throw new CliError('UNSUPPORTED_FLAG', `${flag} is not accepted`, 'The deployment issues tokens during sign-in; run: chickpea login <deployment-url>');
      }
    }
    if (flags.has('--version')) {
      io.print(CLI_VERSION);
      return 0;
    }
    if (flags.has('--help') || positional.length === 0) {
      io.print(USAGE);
      return positional.length === 0 && !flags.has('--help') ? 1 : 0;
    }
    const [command, ...rest] = positional;
    switch (command) {
      case 'doctor':
        return await commandDoctor(rest, io, deps);
      case 'mcp':
        return commandMcp(rest, flags, io);
      case 'login':
        return await commandLogin(rest, io, deps);
      case 'logout':
        return await commandLogout(rest, io, deps);
      case 'workspace':
        return await commandWorkspace(rest, io, deps);
      case 'tools':
        return await commandTools(rest, io, deps);
      case 'call':
        return await commandCall(rest, flags, io, deps);
      case 'recipe':
        return await commandRecipe(rest, flags, io, deps);
      default:
        throw new CliError('UNKNOWN_COMMAND', `Unknown command "${command}"`, 'Run: chickpea --help');
    }
  } catch (error) {
    const record = describeError(error);
    if (io.json) {
      deps.stderr(`${JSON.stringify({ ok: false, error: record })}\n`);
    } else {
      deps.stderr(`${formatErrorLine(record)}\n`);
    }
    return 1;
  }
}

function requireOrigin(args: readonly string[], usage: string): string {
  const raw = args[0];
  if (!raw) throw new CliError('MISSING_ARGUMENT', 'A deployment URL is required', `Usage: ${usage}`);
  return normalizeDeploymentOrigin(raw);
}

function authDeps(deps: CliDeps, io: Io): AuthDeps {
  return {
    fetch: deps.fetch,
    store: deps.store,
    now: deps.now,
    openBrowser: deps.openBrowser,
    note: (text) => io.note(text),
  };
}

async function commandDoctor(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const origin = requireOrigin(args, 'chickpea doctor <deployment-url>');
  const report = await runDoctor(origin, { fetch: deps.fetch });
  if (io.json) io.printJson(report);
  else io.print(renderDoctorReport(report));
  return report.ok ? 0 : 1;
}

function commandMcp(args: readonly string[], flags: ParsedArgs['flags'], io: Io): number {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'config') {
    throw new CliError('UNKNOWN_COMMAND', `Unknown mcp subcommand "${subcommand ?? ''}"`, 'Usage: chickpea mcp config <deployment-url> [--client claude-code|codex|cursor|json]');
  }
  const origin = requireOrigin(rest, 'chickpea mcp config <deployment-url> [--client claude-code|codex|cursor|json]');
  const requested = flags.get('--client');
  let clients: readonly McpClient[] = MCP_CLIENTS;
  if (typeof requested === 'string') {
    if (!isMcpClient(requested)) {
      throw new CliError('INVALID_ARGUMENT', `Unknown client "${requested}"`, `Choose one of: ${MCP_CLIENTS.join(', ')}`);
    }
    clients = [requested];
  } else if (requested === true) {
    throw new CliError('INVALID_ARGUMENT', '--client needs a value', `Choose one of: ${MCP_CLIENTS.join(', ')}`);
  }
  if (io.json) {
    const record = mcpConfigRecord(origin);
    if (clients.length === 1) {
      const only = clients[0]!;
      io.printJson({ ...record, clients: { [only]: (record.clients as Record<string, string>)[only] } });
    } else {
      io.printJson(record);
    }
    return 0;
  }
  io.print(renderMcpConfig(origin, clients));
  return 0;
}

async function commandLogin(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const origin = requireOrigin(args, 'chickpea login <deployment-url>');
  const result = await login(origin, authDeps(deps, io), {
    ...(deps.loginTimeoutMs !== undefined ? { timeoutMs: deps.loginTimeoutMs } : {}),
    ...(deps.onAuthorizationUrl ? { onAuthorizationUrl: deps.onAuthorizationUrl } : {}),
  });
  if (io.json) {
    io.printJson({ ok: true, origin: result.origin, clientId: result.clientId, expiresAt: result.expiresAt ?? null, path: result.path });
  } else {
    io.print(`Signed in to ${result.origin}. Session saved to ${result.path} (mode 0600).`);
  }
  return 0;
}

async function commandLogout(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const origin = requireOrigin(args, 'chickpea logout <deployment-url>');
  const result = await logout(origin, authDeps(deps, io));
  if (io.json) io.printJson({ ok: true, ...result });
  else io.print(`${result.revoked ? 'Revoked and removed' : 'Removed'} the session for ${origin}.`);
  return 0;
}

async function withConnection<T>(
  origin: string,
  io: Io,
  deps: CliDeps,
  work: (client: Awaited<ReturnType<typeof connectManagementClient>>['client']) => Promise<T>,
): Promise<T> {
  const connection = await connectManagementClient(origin, authDeps(deps, io));
  try {
    return await work(connection.client);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

async function commandWorkspace(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'inspect') {
    throw new CliError('UNKNOWN_COMMAND', `Unknown workspace subcommand "${subcommand ?? ''}"`, 'Usage: chickpea workspace inspect <deployment-url> [--json]');
  }
  const origin = requireOrigin(rest, 'chickpea workspace inspect <deployment-url> [--json]');
  const envelope = await withConnection(origin, io, deps, (client) => callManagementTool(client, 'inspect_workspace', {}));
  if (!envelope.ok) return failEnvelope(envelope, io);
  if (io.json) io.printJson(envelope.result);
  else io.print(renderWorkspaceSummary(envelope.result));
  return 0;
}

async function commandTools(args: readonly string[], io: Io, deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'list') {
    throw new CliError('UNKNOWN_COMMAND', `Unknown tools subcommand "${subcommand ?? ''}"`, 'Usage: chickpea tools list <deployment-url>');
  }
  const origin = requireOrigin(rest, 'chickpea tools list <deployment-url>');
  const listed = await withConnection(origin, io, deps, (client) => client.listTools());
  if (io.json) io.printJson(listed.tools);
  else io.print(renderToolList(listed.tools));
  return 0;
}

async function commandCall(args: readonly string[], flags: ParsedArgs['flags'], io: Io, deps: CliDeps): Promise<number> {
  const usage = "chickpea call <deployment-url> <tool> [--args '<json>' | --args-file <file>]";
  const origin = requireOrigin(args, usage);
  const tool = args[1];
  if (!tool) throw new CliError('MISSING_ARGUMENT', 'A tool name is required', `Usage: ${usage}`);
  const toolArgs = readToolArgs(flags, deps);
  const envelope = await withConnection(origin, io, deps, (client) => callManagementTool(client, tool, toolArgs));
  io.printJson(envelope);
  const hints = collectEnvelopeHints(envelope);
  for (const line of renderEnvelopeHints(hints, origin)) io.warn(line);
  return envelope.ok ? 0 : 1;
}

function readToolArgs(flags: ParsedArgs['flags'], deps: CliDeps): Record<string, unknown> {
  const inline = flags.get('--args');
  const file = flags.get('--args-file');
  if (inline !== undefined && file !== undefined) {
    throw new CliError('INVALID_ARGUMENT', 'Pass either --args or --args-file, not both');
  }
  let text: string | undefined;
  if (typeof inline === 'string') text = inline;
  else if (inline === true) throw new CliError('INVALID_ARGUMENT', '--args needs a JSON object value');
  if (typeof file === 'string') {
    try {
      text = deps.readFile(file);
    } catch (error) {
      throw new CliError('INVALID_ARGUMENT', `Cannot read ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  } else if (file === true) {
    throw new CliError('INVALID_ARGUMENT', '--args-file needs a path');
  }
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError('INVALID_ARGUMENT', 'Tool arguments must be valid JSON', "Example: --args '{\"agentId\":\"agent_support\"}'");
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('INVALID_ARGUMENT', 'Tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function commandRecipe(args: readonly string[], flags: ParsedArgs['flags'], io: Io, deps: CliDeps): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === 'export') {
    const origin = requireOrigin(rest, 'chickpea recipe export <deployment-url> [--agents id,id] > recipe.json');
    const agents = flags.get('--agents');
    const agentIds = typeof agents === 'string'
      ? agents.split(',').map((id) => id.trim()).filter(Boolean)
      : undefined;
    if (agents === true) throw new CliError('INVALID_ARGUMENT', '--agents needs a comma-separated list of Agent ids');
    const envelope = await withConnection(origin, io, deps, (client) => callManagementTool(
      client,
      'export_workspace_recipe',
      agentIds && agentIds.length ? { agentIds } : {},
    ));
    if (!envelope.ok) return failEnvelope(envelope, io);
    io.printJson(envelope.result);
    return 0;
  }
  if (subcommand === 'preview') {
    const origin = requireOrigin(rest, 'chickpea recipe preview <deployment-url> <recipe.json>');
    const file = rest[1];
    if (!file) throw new CliError('MISSING_ARGUMENT', 'A recipe file is required', 'Usage: chickpea recipe preview <deployment-url> <recipe.json>');
    let recipe: unknown;
    try {
      recipe = JSON.parse(deps.readFile(file));
    } catch (error) {
      throw new CliError('INVALID_ARGUMENT', `Cannot read recipe ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
    const envelope = await withConnection(origin, io, deps, (client) => callManagementTool(
      client,
      'preview_workspace_recipe',
      { recipe },
    ));
    if (!envelope.ok) return failEnvelope(envelope, io);
    if (io.json) {
      io.printJson(envelope.result);
    } else {
      io.print(renderRecipePreview(envelope.result));
      io.note(`Apply the returned operations with: chickpea call ${origin} apply_workspace_changes --args-file <file>`);
    }
    return 0;
  }
  throw new CliError('UNKNOWN_COMMAND', `Unknown recipe subcommand "${subcommand ?? ''}"`, 'Usage: chickpea recipe export|preview ...');
}

function renderRecipePreview(result: unknown): string {
  if (!result || typeof result !== 'object') return JSON.stringify(result, null, 2);
  const record = result as Record<string, unknown>;
  const agents = Array.isArray(record.agents) ? record.agents as Array<Record<string, unknown>> : [];
  const operations = Array.isArray(record.operations) ? record.operations as Array<Record<string, unknown>> : [];
  const lines = [`Recipe digest ${String(record.recipeDigest ?? '?')}`, '', `Agents (${agents.length})`];
  for (const agent of agents) {
    const setup = Array.isArray(agent.setupRequired) && agent.setupRequired.length ? `  setup required: ${agent.setupRequired.join(', ')}` : '';
    const unavailable = Array.isArray(agent.unavailable) && agent.unavailable.length ? `  unavailable: ${agent.unavailable.join(', ')}` : '';
    const choices = Array.isArray(agent.choices) && agent.choices.length ? `  choices: ${agent.choices.join('/')}` : '';
    lines.push(`  ${String(agent.symbol)}: ${String(agent.status)}${agent.existingAgentId ? ` (existing ${String(agent.existingAgentId)})` : ''}${setup}${unavailable}${choices}`);
  }
  lines.push('', `Operations (${operations.length})`);
  for (const operation of operations) {
    lines.push(`  ${String(operation.itemId)}: ${String(operation.kind)}${operation.confirmationReason ? ` (${String(operation.confirmationReason)})` : ''}`);
  }
  lines.push('', JSON.stringify({ operations }, null, 2));
  return lines.join('\n');
}

function failEnvelope(envelope: Extract<ToolEnvelope, { ok: false }>, io: Io): number {
  if (io.json) io.printJson(envelope);
  throw new CliError(`TOOL_${envelope.error.code.toUpperCase()}`, envelope.error.message);
}

async function openBrowserDetached(url: string): Promise<void> {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
      : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve());
      child.once('spawn', () => { child.unref(); resolve(); });
    } catch {
      resolve();
    }
  });
}

export { mcpUrl };
