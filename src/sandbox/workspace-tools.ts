import { defineTool, SandboxDiedError, type Sandbox } from '@flue/runtime';
import * as v from 'valibot';

import {
  ArtifactSizeError,
  MAX_ARTIFACT_BYTES,
  freezeWorkspaceArtifact,
  readSandboxArtifact,
  workspaceArtifactPath,
} from './artifact-tool.ts';
import {
  SandboxConnectionDroppedError,
  SandboxSessionCapError,
  SandboxUnavailableError,
} from './errors.ts';
import { WORKSPACE_DIR } from './workspace-lifecycle.ts';
import {
  DEFAULT_WORKSPACE_NAME,
  MAX_OPEN_WORKSPACES,
  MAX_WORKSPACE_NAME_CHARS,
  WorkspaceLimitError,
  WorkspaceNameError,
  defaultOnlyWorkspaceRoster,
  normalizeWorkspaceName,
  openWorkspaceNames,
  rosterWorkspaceNames,
  type WorkspaceRoster,
} from './workspace-limits.ts';
import type { WorkspaceSession } from './workspace-session.ts';

export const WORKSPACE_OPEN_TOOL_NAME = 'workspace_open';
export const WORKSPACE_LIST_TOOL_NAME = 'workspace_list';
export const WORKSPACE_CLOSE_TOOL_NAME = 'workspace_close';
export const WORKSPACE_EXEC_TOOL_NAME = 'workspace_exec';
export const WORKSPACE_READ_TOOL_NAME = 'workspace_read';
export const WORKSPACE_WRITE_TOOL_NAME = 'workspace_write';
export const WORKSPACE_LIST_FILES_TOOL_NAME = 'workspace_list_files';
/** Delegation to a coding worker; defined in ./workspace-task.ts. */
export const WORKSPACE_TASK_TOOL_NAME = 'workspace_task';

export const WORKSPACE_TOOL_NAMES = [
  WORKSPACE_OPEN_TOOL_NAME,
  WORKSPACE_LIST_TOOL_NAME,
  WORKSPACE_CLOSE_TOOL_NAME,
  WORKSPACE_EXEC_TOOL_NAME,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAME,
  WORKSPACE_LIST_FILES_TOOL_NAME,
  WORKSPACE_TASK_TOOL_NAME,
] as const;

/** Output kept per stream from one `workspace_exec` call. */
export const MAX_WORKSPACE_EXEC_OUTPUT_BYTES = 48 * 1024;
/** Longest command `workspace_exec` runs; multi-step work belongs elsewhere. */
export const MAX_WORKSPACE_EXEC_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WORKSPACE_EXEC_TIMEOUT_MS = 2 * 60_000;
/** Text returned inline by `workspace_read`. */
export const MAX_WORKSPACE_READ_TEXT_BYTES = 256 * 1024;
/** Inline text accepted by `workspace_write`. */
export const MAX_WORKSPACE_WRITE_TEXT_CHARS = 1024 * 1024;
const MAX_LISTED_FILES = 500;

const SHORT_TIMEOUT_MS = 60_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
// The tool deadline sits past the command's own deadline so a slow command
// reports its own timeout before the harness abandons the call.
const EXEC_TOOL_TIMEOUT_MS = MAX_WORKSPACE_EXEC_TIMEOUT_MS + 30_000;

export type WorkspaceFailureReason =
  | 'workspace_unavailable'
  | 'connection_dropped'
  | 'session_cap'
  | 'timeout'
  | 'workspace_limit'
  | 'busy'
  | 'invalid_path'
  | 'invalid_input'
  | 'too_large'
  | 'not_found';

export type WorkspaceFailure = {
  ok: false;
  reason: WorkspaceFailureReason;
  message: string;
  maxBytes?: number;
};

/**
 * Why a tool reaches a workspace: `use` opens it (and counts against the open
 * cap); `inspect` only looks at or closes one the conversation already has.
 */
export type WorkspaceAccess = 'use' | 'inspect';

/**
 * The session for a normalized workspace name this request, or undefined when
 * it has none. Resolving builds a handle only; it never starts a container.
 * A `use` past the open cap throws {@link WorkspaceLimitError}.
 */
export type WorkspaceResolver = (
  name: string,
  access: WorkspaceAccess,
) => Promise<WorkspaceSession | undefined> | WorkspaceSession | undefined;

export interface WorkspaceToolsOptions {
  resolve: WorkspaceResolver;
  /** The conversation's workspace names; only the default workspace without one. */
  roster?: WorkspaceRoster;
  /** Whether a coding task is running in the workspace with this id. */
  taskRunning?: (workspaceId: string) => boolean;
}

const WORKSPACE_NAME_DESCRIPTION =
  `Workspace name (default "${DEFAULT_WORKSPACE_NAME}"). Use one workspace per repository or line of work, for example "api" and "web"; at most ${MAX_OPEN_WORKSPACES} can be open in this thread.`;

export const WORKSPACE_NAME = v.optional(v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_WORKSPACE_NAME_CHARS),
  v.description(WORKSPACE_NAME_DESCRIPTION),
));

export const WORKSPACE_UNAVAILABLE_MESSAGE =
  'The coding workspace is temporarily unavailable. Say so, and use the Repositories API path if it covers the request; do not retry this call in the same reply.';
export const WORKSPACE_SESSION_CAP_MESSAGE =
  'The coding workspace monthly session limit has been reached. Say so; an administrator can review the coding sandbox limit in Settings. Do not retry.';

/**
 * Coordinator-side tools on a coding workspace. Each holds its own Flue
 * Sandbox on the workspace's Durable Object, so it works whether or not the
 * Agent's own environment is that container. Expected failures come back as
 * `{ ok: false, reason, message }` results; only unexpected faults throw.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions) {
  const roster = options.roster ?? defaultOnlyWorkspaceRoster();
  const session = async (
    name: string,
    access: WorkspaceAccess,
  ): Promise<WorkspaceSession | WorkspaceFailure> => {
    await roster.ready();
    if (access === 'inspect' && !roster.knows(name)) {
      return failure('not_found', `This thread has no workspace named "${name}".`);
    }
    return (await options.resolve(name, access)) ??
      failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE);
  };

  // Every tool body runs under `guard`, so path normalization inside it
  // surfaces as an `invalid_path` result like any other expected refusal.
  const withWorkspace = async <T>(
    name: string | undefined,
    work: (target: WorkspaceSession, name: string) => Promise<T>,
    signal: AbortSignal | undefined,
    access: WorkspaceAccess,
  ): Promise<T | WorkspaceFailure> => {
    // Resolving runs under `guard` too: a workspace that cannot be reached is
    // a typed result the model sees, never a failed turn.
    return guard(async () => {
      const normalized = normalizeWorkspaceName(name);
      const target = await session(normalized, access);
      return 'ok' in target ? target : work(target, normalized);
    }, signal);
  };

  const open = defineTool({
    name: WORKSPACE_OPEN_TOOL_NAME,
    description:
      `Open a coding workspace (a real Linux container with the granted repositories reachable). Prepares it without starting the container; the first command or file operation starts it. Each workspace is its own container: at most ${MAX_OPEN_WORKSPACES} can be open in this thread, and each counts as one coding session. A workspace is ephemeral: its files survive only while it is warm or checkpointed, dependencies are never checkpointed, and a pushed branch is the only durable result. Never assume a file from an earlier request exists without checking, and never store secrets in it.`,
    input: v.object({ workspace: WORKSPACE_NAME }),
    timeoutMs: SHORT_TIMEOUT_MS,
    async run({ data }) {
      return {
        output: await withWorkspace(data.workspace, async (target, name) => ({
          ok: true as const,
          workspace: name,
          state: await target.open(),
        }), undefined, 'use'),
      };
    },
  });

  const list = defineTool({
    name: WORKSPACE_LIST_TOOL_NAME,
    description:
      `List this thread's coding workspaces. For each: whether it is open (at most ${MAX_OPEN_WORKSPACES} can be), its state (running: the container is up; checkpointed: asleep with its files saved; empty: nothing kept), whether a coding task is running in it, and when it was last used. Never starts a container.`,
    input: v.object({}),
    timeoutMs: SHORT_TIMEOUT_MS,
    annotations: { readOnlyHint: true },
    async run({ signal }) {
      return {
        output: await guard(async () => {
          await roster.ready();
          const snapshot = roster.snapshot();
          const open = openWorkspaceNames(snapshot, Date.now());
          const workspaces = await Promise.all(rosterWorkspaceNames(snapshot).map(async (name) => {
            const unavailable = { workspace: name, open: open.includes(name), state: 'unavailable' as const };
            // One workspace that cannot be read never hides the others.
            const target = await Promise.resolve(options.resolve(name, 'inspect')).catch(() => undefined);
            if (!target) return unavailable;
            const described = await target.describe().catch(() => undefined);
            if (!described) return unavailable;
            const { running, hasCheckpoint } = described;
            const lastUsedAt = snapshot.workspaces[name]?.lastUsedAt;
            return {
              workspace: name,
              // The roster is the record of what is open; a plan without one
              // has only the default workspace, open once this request used it.
              open: options.roster ? open.includes(name) : target.isOpen,
              state: running ? 'running' as const : hasCheckpoint ? 'checkpointed' as const : 'empty' as const,
              hasCheckpoint,
              taskRunning: options.taskRunning?.(target.id) ?? false,
              ...(lastUsedAt === undefined ? {} : { lastUsedAt: new Date(lastUsedAt).toISOString() }),
            };
          }));
          return { ok: true as const, maxOpen: MAX_OPEN_WORKSPACES, workspaces };
        }, signal),
      };
    },
  });

  const close = defineTool({
    name: WORKSPACE_CLOSE_TOOL_NAME,
    description:
      'Close a coding workspace so it no longer counts as open. By default its files stay warm for follow-ups and are checkpointed when this request ends; opening it again by name picks them up. With discard: true the container is destroyed and its checkpoint dropped (use it when the workspace is broken or its contents must not carry over); the next open of that name starts fresh with a new coding worker.',
    input: v.object({ workspace: WORKSPACE_NAME, discard: v.optional(v.boolean()) }),
    timeoutMs: SHORT_TIMEOUT_MS,
    async run({ data }) {
      const discarded = data.discard === true;
      return {
        output: await withWorkspace(data.workspace, async (target, name) => {
          // Closing under a running task would destroy its container or free
          // its slot while it still runs.
          if (options.taskRunning?.(target.id)) {
            return failure('busy', `A coding task is running in the "${name}" workspace. Wait for its answer before closing it.`);
          }
          if (discarded) await target.discard();
          roster.close(name, { discard: discarded });
          await roster.flush();
          return { ok: true as const, workspace: name, closed: true, discarded };
        }, undefined, 'inspect'),
      };
    },
  });

  const exec = defineTool({
    name: WORKSPACE_EXEC_TOOL_NAME,
    description:
      `Run one shell command in the coding workspace (working directory ${WORKSPACE_DIR} unless cwd is given) and return its exit code and output. For quick checks and single steps; each stream keeps its last ${MAX_WORKSPACE_EXEC_OUTPUT_BYTES / 1024} KB. timeoutMs defaults to ${DEFAULT_WORKSPACE_EXEC_TIMEOUT_MS / 60_000} minutes, at most ${MAX_WORKSPACE_EXEC_TIMEOUT_MS / 60_000}.`,
    input: v.object({
      workspace: WORKSPACE_NAME,
      command: v.pipe(v.string(), v.minLength(1), v.maxLength(64 * 1024)),
      cwd: v.optional(v.pipe(v.string(), v.minLength(1))),
      timeoutMs: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(MAX_WORKSPACE_EXEC_TIMEOUT_MS)),
      ),
    }),
    timeoutMs: EXEC_TOOL_TIMEOUT_MS,
    async run({ data, signal }) {
      return {
        output: await withWorkspace(data.workspace, async (target) => {
          const cwd = workspaceDirectoryPath(data.cwd ?? WORKSPACE_DIR);
          const sandbox = await target.sandbox();
          const result = await sandbox.exec(data.command, {
            cwd,
            timeoutMs: data.timeoutMs ?? DEFAULT_WORKSPACE_EXEC_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          });
          const stdout = keepTail(result.stdout ?? '');
          const stderr = keepTail(result.stderr ?? '');
          return {
            ok: true as const,
            exitCode: result.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
          };
        }, signal, 'use'),
      };
    },
  });

  const read = defineTool({
    name: WORKSPACE_READ_TOOL_NAME,
    description:
      `Read a file from the coding workspace (a path under ${WORKSPACE_DIR}). Returns its text, up to ${MAX_WORKSPACE_READ_TEXT_BYTES / 1024} KB. With to, copies the file (up to ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB, any content) into your own sandbox at that path instead, for further processing there.`,
    input: v.object({
      workspace: WORKSPACE_NAME,
      path: v.pipe(v.string(), v.minLength(1)),
      to: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    harness: true,
    timeoutMs: TRANSFER_TIMEOUT_MS,
    async run({ data, harness, signal }) {
      return {
        output: await withWorkspace(data.workspace, async (target) => {
          const path = workspaceFilePath(data.path);
          const sandbox = await target.sandbox();
          if (!(await sandbox.exists(path))) {
            return failure('not_found', `${path} does not exist in the workspace.`);
          }
          if (data.to !== undefined) {
            const bytes = await freezeWorkspaceArtifact(sandbox, path, MAX_ARTIFACT_BYTES);
            await harness.sandbox.writeFile(data.to, bytes);
            return { ok: true as const, path: data.to, byteLength: bytes.byteLength };
          }
          const bytes = await freezeWorkspaceArtifact(sandbox, path, MAX_WORKSPACE_READ_TEXT_BYTES);
          return {
            ok: true as const,
            path,
            byteLength: bytes.byteLength,
            content: new TextDecoder().decode(bytes),
          };
        }, signal, 'use'),
      };
    },
  });

  const write = defineTool({
    name: WORKSPACE_WRITE_TOOL_NAME,
    description:
      `Write a file into the coding workspace (a path under ${WORKSPACE_DIR}; parent directories are created). Give exactly one source: content (text, such as a script), or from (a file in your own sandbox, up to ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB, copied byte for byte).`,
    input: v.object({
      workspace: WORKSPACE_NAME,
      path: v.pipe(v.string(), v.minLength(1)),
      content: v.optional(v.pipe(v.string(), v.maxLength(MAX_WORKSPACE_WRITE_TEXT_CHARS))),
      from: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    harness: true,
    timeoutMs: TRANSFER_TIMEOUT_MS,
    async run({ data, harness, signal }) {
      return {
        output: await withWorkspace(data.workspace, async (target) => {
          if ((data.content === undefined) === (data.from === undefined)) {
            return failure('invalid_input', 'Give exactly one of content or from.');
          }
          const path = workspaceFilePath(data.path);
          let content: string | Uint8Array;
          if (data.from !== undefined) {
            try {
              content = await readSandboxArtifact(harness.sandbox, data.from, 'bash');
            } catch (error) {
              if (error instanceof ArtifactSizeError) {
                return failure('too_large', 'That file is over the copy limit.', error.maxBytes);
              }
              return failure('not_found', `${data.from} could not be read from your sandbox.`);
            }
          } else {
            content = data.content!;
          }
          const sandbox = await target.sandbox();
          await sandbox.writeFile(path, content);
          const byteLength = typeof content === 'string'
            ? new TextEncoder().encode(content).byteLength
            : content.byteLength;
          return { ok: true as const, path, byteLength };
        }, signal, 'use'),
      };
    },
  });

  const listFiles = defineTool({
    name: WORKSPACE_LIST_FILES_TOOL_NAME,
    description:
      `List files under a directory in the coding workspace (default ${WORKSPACE_DIR}), to the given depth (default 2, at most 4). The contents of .git and node_modules are not listed. At most ${MAX_LISTED_FILES} entries.`,
    input: v.object({
      workspace: WORKSPACE_NAME,
      path: v.optional(v.pipe(v.string(), v.minLength(1))),
      depth: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(4))),
    }),
    timeoutMs: SHORT_TIMEOUT_MS,
    annotations: { readOnlyHint: true },
    async run({ data, signal }) {
      return {
        output: await withWorkspace(data.workspace, async (target) => {
          const path = workspaceDirectoryPath(data.path ?? WORKSPACE_DIR);
          const sandbox = await target.sandbox();
          return listWorkspaceFiles(sandbox, path, data.depth ?? 2, signal);
        }, signal, 'use'),
      };
    },
  });

  return [open, list, close, exec, read, write, listFiles];
}

/**
 * List a workspace directory with one bounded `find`. Pruned directories are
 * reported but not descended into.
 */
async function listWorkspaceFiles(
  sandbox: Pick<Sandbox, 'exec'>,
  path: string,
  depth: number,
  signal?: AbortSignal,
) {
  const format = `-printf '%y\\t%s\\t%P\\n'`;
  const result = await sandbox.exec(
    // `test -d` first: without pipefail the pipeline's status is head's, so a
    // missing directory would otherwise read as an empty listing.
    `test -d ${shellQuote(path)} && find ${shellQuote(path)} -mindepth 1 -maxdepth ${depth} \\( -name .git -o -name node_modules \\) -prune ${format} -o ${format} | head -n ${MAX_LISTED_FILES + 1}`,
    { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
  );
  if (result.exitCode !== 0) {
    return failure('not_found', `${path} could not be listed in the workspace.`);
  }
  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  const entries = lines.slice(0, MAX_LISTED_FILES).flatMap((line) => {
    const [kind, size, relative] = line.split('\t');
    if (!kind || relative === undefined || relative.length === 0) return [];
    const type = kind === 'd' ? 'directory' : kind === 'l' ? 'link' : kind === 'f' ? 'file' : 'other';
    return [{
      path: `${path === '/' ? '' : path}/${relative}`,
      type,
      ...(type === 'file' ? { size: Number(size) } : {}),
    }];
  });
  return { ok: true as const, path, entries, truncated: lines.length > MAX_LISTED_FILES };
}

/** A model-supplied file path: relative paths are under the workspace root. */
export function workspaceFilePath(path: string): string {
  const trimmed = path.trim();
  return workspaceArtifactPath(trimmed.startsWith('/') ? trimmed : `${WORKSPACE_DIR}/${trimmed}`);
}

/** A model-supplied directory: the workspace root or a normalized path under it. */
export function workspaceDirectoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '.') return WORKSPACE_DIR;
  const withoutSlash = trimmed.replace(/\/+$/, '');
  if (withoutSlash === WORKSPACE_DIR) return WORKSPACE_DIR;
  // A bare "/" strips to "" and must stay outside the workspace, not map onto it.
  return workspaceFilePath(withoutSlash === '' ? trimmed : withoutSlash);
}

/**
 * Map the workspace's public-safe refusals to typed results. Anything else is
 * an unexpected fault and throws, so the model sees an error result.
 */
async function guard<T>(
  work: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T | WorkspaceFailure> {
  try {
    return await work();
  } catch (error) {
    const mapped = workspaceFailure(error, signal);
    if (mapped) return mapped;
    throw error;
  }
}

function workspaceFailure(error: unknown, signal?: AbortSignal): WorkspaceFailure | undefined {
  if (error instanceof SandboxSessionCapError) return failure('session_cap', WORKSPACE_SESSION_CAP_MESSAGE);
  // The Durable Object connection dropped under a call that is not replayed:
  // the workspace is intact and the next call reconnects.
  if (error instanceof SandboxConnectionDroppedError) {
    return failure('connection_dropped', error.message);
  }
  if (error instanceof SandboxUnavailableError || error instanceof SandboxDiedError) {
    return failure('workspace_unavailable', WORKSPACE_UNAVAILABLE_MESSAGE);
  }
  if (error instanceof WorkspaceLimitError) return failure('workspace_limit', error.message);
  if (error instanceof WorkspaceNameError) return failure('invalid_input', error.message);
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return failure('timeout', 'The workspace operation did not finish in time.');
  }
  if (error instanceof ArtifactSizeError) {
    return failure('too_large', 'That file is over the size limit for this call.', error.maxBytes);
  }
  if (error instanceof Error && /must be (?:under|a normalized file under) \/workspace/.test(error.message)) {
    return failure('invalid_path', error.message);
  }
  if (error instanceof Error && error.message === 'artifact path must identify a file') {
    return failure('not_found', 'That path is not a file in the workspace.');
  }
  return undefined;
}

function failure(reason: WorkspaceFailureReason, message: string, maxBytes?: number): WorkspaceFailure {
  return { ok: false, reason, message, ...(maxBytes === undefined ? {} : { maxBytes }) };
}

function keepTail(text: string): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_WORKSPACE_EXEC_OUTPUT_BYTES) return { text, truncated: false };
  // Decoding a mid-character start yields one replacement character, not an error.
  return {
    text: new TextDecoder().decode(bytes.subarray(bytes.byteLength - MAX_WORKSPACE_EXEC_OUTPUT_BYTES)),
    truncated: true,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
