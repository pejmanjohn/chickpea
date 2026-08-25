import { matchesEgressPrefix } from '../config/egress.ts';
import {
  extractCurlRequests,
  parseShellCommands,
  type CurlRequest,
  type ParsedShellCommand,
} from './curl-request-urls.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../slack/presentation-intent.ts';

export interface ActivityStatus {
  text: string;
}

export interface ActivitySkill {
  name: string;
  displayName?: string;
}

export interface ActivityConnection {
  id: string;
  displayName: string;
}

export interface ApiConnectionActivity {
  displayName: string;
  allowedHosts: readonly string[];
  pathPrefixes: readonly string[];
  allowedMethods: readonly string[];
  matchesRequest?: (url: string) => boolean;
}

export interface ActivityContext {
  skills: readonly ActivitySkill[];
  mcpConnections: readonly ActivityConnection[];
  apiConnections: readonly ApiConnectionActivity[];
}

interface RegisteredActivityContext {
  skills: Map<string, string>;
  mcpConnections: Map<string, string>;
  apiConnections: Array<{
    displayName: string;
    allowedHosts: string[];
    pathPrefixes: string[];
    allowedMethods: Set<string>;
    matchesRequest?: (url: string) => boolean;
  }>;
}

interface ActivityObservation {
  type: string;
  instanceId?: string | undefined;
  toolName?: string | undefined;
  args?: unknown;
  contentIndex?: number | undefined;
  delta?: string | undefined;
  toolCallId?: string | undefined;
}

// Durable agent instances can outlive individual turns, and Flue observation
// events carry only the instance id. Keep a small, bounded policy-only catalog
// so tool events can be narrated with human names without ever inspecting
// credentials or persisting profile data indefinitely.
const MAX_ACTIVITY_CONTEXTS = 256;
const activityContexts = new Map<string, RegisteredActivityContext>();

export function registerActivityContext(instanceId: string, context: ActivityContext): void {
  const registered: RegisteredActivityContext = {
    skills: new Map(
      context.skills.map((skill) => [
        skill.name,
        safeActivityLabel(skill.displayName ?? humanizeIdentifier(skill.name)),
      ]),
    ),
    mcpConnections: new Map(
      context.mcpConnections.map((connection) => [
        connection.id,
        safeActivityLabel(connection.displayName),
      ]),
    ),
    apiConnections: context.apiConnections.map((connection) => ({
      displayName: safeActivityLabel(connection.displayName),
      allowedHosts: [...connection.allowedHosts],
      pathPrefixes: [...connection.pathPrefixes],
      allowedMethods: new Set(
        connection.allowedMethods.map((method) => method.trim().toUpperCase()).filter(Boolean),
      ),
      ...(connection.matchesRequest ? { matchesRequest: connection.matchesRequest } : {}),
    })),
  };

  // Refresh insertion order so safe degradation evicts the oldest registered
  // conversation when the bounded cache fills.
  activityContexts.delete(instanceId);
  activityContexts.set(instanceId, registered);
  while (activityContexts.size > MAX_ACTIVITY_CONTEXTS) {
    const oldest = activityContexts.keys().next().value;
    if (oldest === undefined) break;
    activityContexts.delete(oldest);
  }
}

/**
 * Turn an observation into a concise operational summary. Thinking deltas and
 * their content are deliberately ignored: users get a useful activity trace,
 * not raw private reasoning. Tool arguments are used only for exact allowlist
 * matching and are never copied into the returned text.
 */
export function activityStatusForObservation(
  event: ActivityObservation,
): ActivityStatus | undefined {
  const context =
    typeof event.instanceId === 'string' ? activityContexts.get(event.instanceId) : undefined;
  if (!context) {
    return undefined;
  }
  if (event.type === 'thinking_start') {
    return { text: 'is thinking through the request' };
  }
  if (
    event.type !== 'tool_start' ||
    typeof event.instanceId !== 'string' ||
    typeof event.toolName !== 'string'
  ) {
    return undefined;
  }
  return toolActivityStatus(event.toolName, event.args, context);
}

export function toolActivityStatus(
  toolName: string,
  args?: unknown,
  context?: RegisteredActivityContext,
): ActivityStatus {
  if (toolName === SLACK_STREAM_ANSWER_TOOL_NAME) {
    return { text: 'is preparing the response' };
  }
  if (toolName === 'activate_skill') {
    const name = objectString(args, 'name');
    const displayName = name ? context?.skills.get(name) : undefined;
    return displayName
      ? boundedNamedStatus('is loading the ', displayName, ' skill')
      : { text: 'is loading a skill' };
  }
  if (toolName === 'bash') {
    return bashActivityStatus(args, context?.apiConnections ?? []);
  }
  if (toolName === 'read') {
    return { text: 'is reading a workspace file' };
  }
  if (toolName === 'write') {
    return { text: 'is writing a workspace file' };
  }
  if (toolName === 'edit') {
    return { text: 'is editing a workspace file' };
  }
  if (toolName === 'grep') {
    return { text: 'is searching the workspace' };
  }
  if (toolName === 'glob') {
    return { text: 'is finding workspace files' };
  }
  if (toolName === 'read_skill_resource') {
    return { text: 'is reading a skill resource' };
  }
  if (toolName.startsWith('mcp__')) {
    const serverId = mcpServerId(toolName);
    const displayName = serverId ? context?.mcpConnections.get(serverId) : undefined;
    return displayName
      ? boundedNamedStatus('is using ', displayName)
      : { text: 'is using a connection' };
  }
  if (toolName === 'lookup_thread_history') {
    return { text: 'is checking thread history' };
  }
  if (toolName === 'post_artifact') {
    return { text: 'is sharing a workspace artifact' };
  }
  return { text: 'is using a tool' };
}

export function connectingActivityStatus(displayName: string): ActivityStatus {
  return boundedNamedStatus('is connecting to ', displayName);
}

function bashActivityStatus(
  args: unknown,
  apiConnections: RegisteredActivityContext['apiConnections'],
): ActivityStatus {
  const command = objectString(args, 'command');
  if (!command) return { text: 'is running a workspace command' };

  const commands = parseShellCommands(command);
  const curlRequests = extractCurlRequests(command);
  if (!commands || !curlRequests) {
    return { text: 'is running a workspace command' };
  }

  if (commands.some((parsed) => isGitCommand(parsed, 'clone'))) {
    return { text: 'is cloning the repository' };
  }
  if (commands.some(isDependencyInstallCommand)) {
    return { text: 'is installing dependencies' };
  }
  if (commands.some(isTestCommand)) {
    return { text: 'is running the test suite' };
  }
  if (commands.some(isScreenshotCommand)) {
    return { text: 'is capturing a screenshot' };
  }
  if (commands.some(isStartCommand)) {
    return { text: 'is starting the app' };
  }
  if (curlRequests.some(isGitHubPullCreation)) {
    return { text: 'is opening the pull request' };
  }
  if (commands.some((parsed) => isGitCommand(parsed, 'push'))) {
    return { text: 'is pushing the branch' };
  }
  if (commands.some((parsed) => isGitCommand(parsed, 'commit'))) {
    return { text: 'is committing the changes' };
  }
  const connection = apiConnectionForRequests(curlRequests, apiConnections);
  if (connection) {
    return boundedNamedStatus('is using ', connection.displayName);
  }
  if (commands.some(isEditCommand)) {
    return { text: 'is editing the code' };
  }
  if (commands.some(isInspectionCommand)) {
    return { text: 'is inspecting the workspace' };
  }

  return { text: 'is running a workspace command' };
}

function apiConnectionForRequests(
  requests: readonly CurlRequest[],
  apiConnections: RegisteredActivityContext['apiConnections'],
): RegisteredActivityContext['apiConnections'][number] | undefined {
  if (requests.length === 0 || apiConnections.length === 0) {
    return undefined;
  }

  let matchedConnection: RegisteredActivityContext['apiConnections'][number] | undefined;
  for (const request of requests) {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return undefined;
    }
    const matches = apiConnections.filter((connection) => {
      if (!connection.allowedMethods.has(request.method)) return false;
      const prefixes = connection.pathPrefixes.length > 0 ? connection.pathPrefixes : [''];
      const matchesPrefix = connection.allowedHosts.some((host) =>
        prefixes.some((prefix) => matchesEgressPrefix(url.href, `https://${host}${prefix}`)),
      );
      if (!matchesPrefix) return false;
      try {
        return connection.matchesRequest === undefined || connection.matchesRequest(url.href);
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      return undefined;
    }
    const [connection] = matches;
    if (!connection || (matchedConnection && matchedConnection !== connection)) {
      return undefined;
    }
    matchedConnection = connection;
  }
  return matchedConnection;
}

function executableWords(command: ParsedShellCommand): readonly string[] {
  let commandIndex = 0;
  while (isShellAssignment(command.words[commandIndex])) commandIndex += 1;
  if (command.words[commandIndex] === 'command') commandIndex += 1;
  return command.words.slice(commandIndex);
}

function isShellAssignment(word: string | undefined): boolean {
  return typeof word === 'string' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isGitCommand(command: ParsedShellCommand, subcommand: string): boolean {
  const words = executableWords(command);
  return words[0] === 'git' && words[1] === subcommand;
}

function isDependencyInstallCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0];
  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn' || executable === 'bun') {
    const [subcommand] = packageManagerArgs(words);
    return subcommand === 'ci' || subcommand === 'install' || subcommand === 'i';
  }
  if (executable === 'pip' || executable === 'pip3') return words[1] === 'install';
  return (
    (executable === 'python' || executable === 'python3') &&
    words[1] === '-m' &&
    words[2] === 'pip' &&
    words[3] === 'install'
  );
}

function isTestCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0];
  if (executable === 'pytest' || executable === 'vitest' || executable === 'jest') return true;
  if (executable === 'playwright') return words[1] === 'test';
  if (executable !== 'npm' && executable !== 'pnpm' && executable !== 'yarn' && executable !== 'bun') {
    return false;
  }
  const args = packageManagerArgs(words);
  return args[0] === 'test' || (args[0] === 'run' && args[1] === 'test');
}

function isScreenshotCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0] ?? '';
  if (executable === 'playwright') return words[1] === 'screenshot';
  if (executable === 'npx' && words[1] === 'playwright') return words[2] === 'screenshot';
  if (executable === 'chromium' || executable === 'google-chrome') {
    return words.slice(1).some((word) => word === '--screenshot' || word.startsWith('--screenshot='));
  }
  if (executable !== 'node') return false;
  const script = words[1];
  return typeof script === 'string' && !script.startsWith('-') && /(?:playwright|screenshot|capture)/i.test(script);
}

function isStartCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0];
  if (executable === 'wrangler') return words[1] === 'dev';
  if (executable !== 'npm' && executable !== 'pnpm' && executable !== 'yarn' && executable !== 'bun') {
    return false;
  }
  const args = packageManagerArgs(words);
  const script = args[0] === 'run' ? args[1] : args[0];
  return script === 'dev' || script === 'start';
}

function packageManagerArgs(words: readonly string[]): readonly string[] {
  const executable = words[0];
  const valueFlags =
    executable === 'pnpm'
      ? new Set(['-C', '--dir', '-F', '--filter'])
      : executable === 'npm'
        ? new Set(['--prefix', '-w', '--workspace'])
        : executable === 'yarn'
          ? new Set(['--cwd'])
          : executable === 'bun'
            ? new Set(['--cwd', '--filter'])
            : new Set<string>();
  const booleanFlags =
    executable === 'pnpm'
      ? new Set(['-w', '--workspace-root', '-r', '--recursive'])
      : executable === 'npm'
        ? new Set(['--workspaces', '--include-workspace-root'])
        : new Set<string>();
  let index = 1;
  while (index < words.length) {
    const word = words[index];
    if (word !== undefined && valueFlags.has(word)) {
      index += 2;
      continue;
    }
    if (word !== undefined && booleanFlags.has(word)) {
      index += 1;
      continue;
    }
    const equalsAt = word?.indexOf('=') ?? -1;
    if (word !== undefined && equalsAt > 0 && valueFlags.has(word.slice(0, equalsAt))) {
      index += 1;
      continue;
    }
    break;
  }
  return words.slice(index);
}

function isGitHubPullCreation(request: CurlRequest): boolean {
  if (request.method !== 'POST') return false;
  try {
    const url = new URL(request.url);
    return (
      url.origin === 'https://api.github.com' &&
      /^\/repos\/[^/]+\/[^/]+\/pulls\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isEditCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0];
  if (executable === 'apply_patch' || executable === 'tee') return true;
  if (executable === 'cat') return command.hasOutputRedirection;
  if (executable === 'sed') {
    return words.slice(1).some((word) => word === '-i' || word.startsWith('-i.'));
  }
  if (executable === 'perl') {
    return words.slice(1).some((word) => /^-[A-Za-z]*i[A-Za-z]*$/.test(word));
  }
  return false;
}

function isInspectionCommand(command: ParsedShellCommand): boolean {
  const words = executableWords(command);
  const executable = words[0];
  if (executable === 'git') {
    return words[1] === 'status' || words[1] === 'log' || words[1] === 'diff' || words[1] === 'branch';
  }
  return (
    executable === 'ls' ||
    executable === 'find' ||
    executable === 'cat' ||
    executable === 'head' ||
    executable === 'tail' ||
    executable === 'rg' ||
    executable === 'grep' ||
    executable === 'pwd'
  );
}

function mcpServerId(toolName: string): string | undefined {
  const rest = toolName.slice('mcp__'.length);
  const separator = rest.indexOf('__');
  return separator > 0 ? rest.slice(0, separator) : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function boundedNamedStatus(prefix: string, displayName: string, suffix = ''): ActivityStatus {
  const maxNameLength = Math.max(1, 50 - prefix.length - suffix.length);
  const name = truncate(safeActivityLabel(displayName), maxNameLength);
  return { text: `${prefix}${name}${suffix}` };
}

function safeActivityLabel(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>&*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'connection';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === 'api') return 'API';
      if (lower === 'github') return 'GitHub';
      if (lower === 'mcp') return 'MCP';
      return lower;
    })
    .join(' ');
}
