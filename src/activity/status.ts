import { matchesEgressPrefix } from '../config/egress.ts';
import {
  extractCurlRequests,
  parseShellCommands,
  type CurlRequest,
  type ParsedShellCommand,
} from './curl-request-urls.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../slack/presentation-intent.ts';
import {
  activityStatus,
  genericSemanticDescriptor,
  isSemanticActivityDescriptor,
  narrateSemanticActivity,
  safeActivityLabel,
  unknownSemanticDescriptor,
  type ActivityStatus,
  type SemanticActivityDescriptor,
  type SemanticTargetFamily,
  type TypedActivityStatus,
} from './semantic.ts';

export {
  activityStatus,
  isSafeTypedActivityStatus,
  type ActivityKind,
  type ActivityStatus,
  type TypedActivityStatus,
} from './semantic.ts';

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

export interface ActivityToolDescriptor {
  toolName: string;
  descriptor: SemanticActivityDescriptor;
}

export interface ActivityContext {
  skills: readonly ActivitySkill[];
  mcpConnections: readonly ActivityConnection[];
  apiConnections: readonly ApiConnectionActivity[];
  /**
   * Exact product-trusted descriptors for tools mounted on this render.
   * Presence selects the closed semantic contract, even when the list is
   * empty; unregistered observations then degrade to fixed generic copy.
   */
  toolDescriptors?: readonly ActivityToolDescriptor[];
  /** Generic grants are policy evidence for invocation-owner facts, not copy. */
  enabledFamilies?: readonly SemanticTargetFamily[];
}

/** Build the content-free context shape shared by RuntimePlan and legacy assembly. */
export function buildSemanticActivityContext(
  toolDescriptors: readonly ActivityToolDescriptor[],
  enabledFamilies: readonly SemanticTargetFamily[] = [],
): ActivityContext {
  return {
    skills: [],
    mcpConnections: [],
    apiConnections: [],
    toolDescriptors: toolDescriptors.map(({ toolName, descriptor }) => ({
      toolName,
      descriptor: cloneSemanticDescriptor(descriptor),
    })),
    enabledFamilies: [...new Set(enabledFamilies)],
  };
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
  semanticDescriptors?: Map<string, SemanticActivityDescriptor>;
  enabledFamilies: Set<SemanticTargetFamily>;
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
  const semanticDescriptors = context.toolDescriptors === undefined
    ? undefined
    : new Map(context.toolDescriptors.flatMap(({ toolName, descriptor }) => {
        if (!toolName || !isSemanticActivityDescriptor(descriptor)) return [];
        return [[toolName, cloneSemanticDescriptor(descriptor)] as const];
      }));
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
    ...(semanticDescriptors ? { semanticDescriptors } : {}),
    enabledFamilies: new Set(context.enabledFamilies ?? []),
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
    // The turn already publishes an admission activity before model work
    // starts. A thinking event contains no new user-facing fact and must not
    // replace a more specific action such as "Drafting the initial skill".
    return undefined;
  }
  if (
    event.type !== 'tool_start' ||
    typeof event.instanceId !== 'string' ||
    typeof event.toolName !== 'string'
  ) {
    return undefined;
  }
  if (context.semanticDescriptors) {
    const descriptor = context.semanticDescriptors.get(event.toolName) ??
      (event.toolName.startsWith('mcp__') && context.enabledFamilies.has('custom_connection')
        ? genericSemanticDescriptor('custom_connection')
        : unknownSemanticDescriptor());
    return narrateSemanticActivity(
      descriptor,
      { phase: 'started' },
    );
  }
  return toolActivityStatus(event.toolName, event.args, context);
}

function cloneSemanticDescriptor(
  descriptor: SemanticActivityDescriptor,
): SemanticActivityDescriptor {
  return {
    operation: descriptor.operation,
    target: descriptor.target,
    ...(descriptor.label
      ? {
          label: {
            kind: descriptor.label.kind,
            id: descriptor.label.id,
            label: descriptor.label.label,
          },
        }
      : {}),
    object: descriptor.object,
    effect: descriptor.effect,
    role: descriptor.role,
    trust: descriptor.trust,
  };
}

export function toolActivityStatus(
  toolName: string,
  args?: unknown,
  context?: RegisteredActivityContext,
): ActivityStatus {
  if (toolName === SLACK_STREAM_ANSWER_TOOL_NAME) {
    return activityStatus('writing', 'Drafting', 'the response');
  }
  if (toolName === 'activate_skill') {
    const name = objectString(args, 'name');
    const displayName = name ? context?.skills.get(name) : undefined;
    return displayName
      ? activityStatus('preparing', 'Loading', `the ${displayName} skill`)
      : activityStatus('preparing', 'Loading', 'a skill');
  }
  if (toolName === 'bash') {
    return bashActivityStatus(args, context?.apiConnections ?? []);
  }
  if (toolName === 'read') {
    return activityStatus('reading', 'Reading', 'a workspace file');
  }
  if (toolName === 'write') {
    return activityStatus('writing', 'Writing', 'a workspace file');
  }
  if (toolName === 'edit') {
    return activityStatus('updating', 'Editing', 'a workspace file');
  }
  if (toolName === 'grep') {
    return activityStatus('checking', 'Searching', 'the workspace');
  }
  if (toolName === 'glob') {
    return activityStatus('checking', 'Finding', 'workspace files');
  }
  if (toolName === 'read_skill_resource') {
    return activityStatus('reading', 'Reading', 'a skill resource');
  }
  if (toolName.startsWith('mcp__')) {
    const serverId = mcpServerId(toolName);
    const displayName = serverId ? context?.mcpConnections.get(serverId) : undefined;
    return displayName
      ? activityStatus('checking', 'Checking', displayName)
      : activityStatus('checking', 'Checking', 'a connection');
  }
  if (toolName === 'lookup_thread_history') {
    return activityStatus('checking', 'Checking', 'thread history');
  }
  if (toolName === 'post_artifact') {
    return activityStatus('finishing', 'Sharing', 'a workspace artifact');
  }
  return activityStatus('running', 'Working with', 'a tool');
}

export function connectingActivityStatus(displayName: string): ActivityStatus {
  return activityStatus('checking', 'Connecting to', displayName);
}

/** Calm admission activity, upgraded to a safe request object when known. */
export function initialActivityStatus(
  taskLabels?: readonly string[],
  requestText?: string,
): TypedActivityStatus {
  const firstTask = taskLabels?.find((label) => label.trim())?.trim();
  if (firstTask) return activityStatus('writing', 'Drafting', firstTask);
  return activityStatus('writing', 'Drafting', requestedDraftObject(requestText));
}

/**
 * Infer only from an allowlist of common product artifacts. User wording is
 * never copied into Slack, so credentials, mentions, and prompt injection
 * cannot become presentation text.
 */
function requestedDraftObject(requestText: string | undefined): string {
  const text = requestText?.toLowerCase() ?? '';
  const drafting = /\b(?:author|build|create|design|draft|edit|outline|revise|write)\b/.test(text);
  if (!drafting) return 'the response';
  if (/\binitial\s+skill\b/.test(text)) return 'the initial skill';
  if (/\bskills?\b/.test(text)) return 'the skill';
  if (/\bagents?\b/.test(text)) return 'the Agent';
  if (/\bplans?\b/.test(text)) return 'the plan';
  if (/\breports?\b/.test(text)) return 'the report';
  if (/\bproposals?\b/.test(text)) return 'the proposal';
  if (/\bdocuments?\b/.test(text)) return 'the document';
  if (/\b(?:emails?|messages?)\b/.test(text)) return 'the message';
  return 'the response';
}

function bashActivityStatus(
  args: unknown,
  apiConnections: RegisteredActivityContext['apiConnections'],
): ActivityStatus {
  const command = objectString(args, 'command');
  if (!command) return activityStatus('running', 'Running', 'a workspace command');

  const commands = parseShellCommands(command);
  const curlRequests = extractCurlRequests(command);
  if (!commands || !curlRequests) {
    return activityStatus('running', 'Running', 'a workspace command');
  }

  if (commands.some((parsed) => isGitCommand(parsed, 'clone'))) {
    return activityStatus('running', 'Cloning', 'the repository');
  }
  if (commands.some(isDependencyInstallCommand)) {
    return activityStatus('running', 'Installing', 'dependencies');
  }
  if (commands.some(isTestCommand)) {
    return activityStatus('running', 'Running', 'the test suite');
  }
  if (commands.some(isScreenshotCommand)) {
    return activityStatus('running', 'Capturing', 'a screenshot');
  }
  if (commands.some(isStartCommand)) {
    return activityStatus('running', 'Starting', 'the app');
  }
  if (curlRequests.some(isGitHubPullCreation)) {
    return activityStatus('finishing', 'Opening', 'the pull request');
  }
  if (commands.some((parsed) => isGitCommand(parsed, 'push'))) {
    return activityStatus('finishing', 'Pushing', 'the branch');
  }
  if (commands.some((parsed) => isGitCommand(parsed, 'commit'))) {
    return activityStatus('finishing', 'Committing', 'the changes');
  }
  const connection = apiConnectionForRequests(curlRequests, apiConnections);
  if (connection) {
    return activityStatus('checking', 'Checking', connection.displayName);
  }
  if (commands.some(isEditCommand)) {
    return activityStatus('updating', 'Editing', 'the code');
  }
  if (commands.some(isInspectionCommand)) {
    return activityStatus('checking', 'Inspecting', 'the workspace');
  }

  return activityStatus('running', 'Running', 'a workspace command');
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
