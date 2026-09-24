import { defineTool, SandboxDiedError, type Sandbox } from '@flue/runtime';
import * as v from 'valibot';

import {
  ArtifactSizeError,
  MAX_ARTIFACT_BYTES,
  freezeWorkspaceArtifact,
  readSandboxArtifact,
  workspaceArtifactPath,
} from './artifact-tool.ts';
import { SandboxSessionCapError, SandboxUnavailableError } from './errors.ts';
import { WORKSPACE_DIR } from './workspace-lifecycle.ts';
import { DEFAULT_WORKSPACE_NAME, type WorkspaceSession } from './workspace-session.ts';

export const WORKSPACE_OPEN_TOOL_NAME = 'workspace_open';
export const WORKSPACE_LIST_TOOL_NAME = 'workspace_list';
export const WORKSPACE_CLOSE_TOOL_NAME = 'workspace_close';
export const WORKSPACE_EXEC_TOOL_NAME = 'workspace_exec';
export const WORKSPACE_READ_TOOL_NAME = 'workspace_read';
export const WORKSPACE_WRITE_TOOL_NAME = 'workspace_write';
export const WORKSPACE_LIST_FILES_TOOL_NAME = 'workspace_list_files';

export const WORKSPACE_TOOL_NAMES = [
  WORKSPACE_OPEN_TOOL_NAME,
  WORKSPACE_LIST_TOOL_NAME,
  WORKSPACE_CLOSE_TOOL_NAME,
  WORKSPACE_EXEC_TOOL_NAME,
  WORKSPACE_READ_TOOL_NAME,
  WORKSPACE_WRITE_TOOL_NAME,
  WORKSPACE_LIST_FILES_TOOL_NAME,
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
  | 'session_cap'
  | 'timeout'
  | 'unknown_workspace'
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

export interface WorkspaceToolsOptions {
  /** The session for a workspace name this request, or undefined when it has none. */
  resolve: (name: string) => WorkspaceSession | undefined;
}

const WORKSPACE_NAME = v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64)));

const UNAVAILABLE_MESSAGE =
  'The coding workspace is temporarily unavailable. Say so, and use the Repositories API path if it covers the request; do not retry this call in the same reply.';
const SESSION_CAP_MESSAGE =
  'The coding workspace monthly session limit has been reached. Say so; an administrator can review the coding sandbox limit in Settings. Do not retry.';

/**
 * Coordinator-side tools on a coding workspace. Each holds its own Flue
 * Sandbox on the workspace's Durable Object, so it works whether or not the
 * Agent's own environment is that container. Expected failures come back as
 * `{ ok: false, reason, message }` results; only unexpected faults throw.
 */
export function createWorkspaceTools(options: WorkspaceToolsOptions) {
  const session = (name: string | undefined): WorkspaceSession | WorkspaceFailure => {
    const requested = name ?? DEFAULT_WORKSPACE_NAME;
    if (requested !== DEFAULT_WORKSPACE_NAME) {
      return failure('unknown_workspace', `Only the "${DEFAULT_WORKSPACE_NAME}" workspace is available.`);
    }
    return options.resolve(requested) ?? failure('workspace_unavailable', UNAVAILABLE_MESSAGE);
  };

  // Every tool body runs under `guard`, so path normalization inside it
  // surfaces as an `invalid_path` result like any other expected refusal.
  const withWorkspace = async <T>(
    name: string | undefined,
    work: (target: WorkspaceSession) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T | WorkspaceFailure> => {
    const target = session(name);
    return 'ok' in target ? target : guard(() => work(target), signal);
  };

  const open = defineTool({
    name: WORKSPACE_OPEN_TOOL_NAME,
    description:
      'Open the coding workspace (a real Linux container with the granted repositories reachable) for this request. Prepares it without starting the container; the first command or file operation starts it. A workspace is ephemeral: its files survive only while it is warm or checkpointed, dependencies are never checkpointed, and a pushed branch is the only durable result. Never assume a file from an earlier request exists without checking, and never store secrets in it.',
    input: v.object({ workspace: WORKSPACE_NAME }),
    timeoutMs: SHORT_TIMEOUT_MS,
    async run({ data }) {
      return {
        output: await withWorkspace(data.workspace, async (target) => ({
          ok: true as const,
          workspace: target.name,
          state: await target.open(),
        })),
      };
    },
  });

  const list = defineTool({
    name: WORKSPACE_LIST_TOOL_NAME,
    description:
      'List this conversation\'s coding workspaces: whether each is open in this request, running, and has a saved checkpoint. Never starts a container.',
    input: v.object({}),
    timeoutMs: SHORT_TIMEOUT_MS,
    annotations: { readOnlyHint: true },
    async run() {
      return {
        output: await withWorkspace(undefined, async (target) => ({
          ok: true as const,
          workspaces: [{ workspace: target.name, open: target.isOpen, ...(await target.describe()) }],
        })),
      };
    },
  });

  const close = defineTool({
    name: WORKSPACE_CLOSE_TOOL_NAME,
    description:
      'Close a coding workspace. By default it stays warm for follow-ups and is checkpointed when this request ends. With discard: true the container is destroyed and its checkpoint dropped (use it when the workspace is broken or its contents must not carry over); the next open starts fresh.',
    input: v.object({ workspace: WORKSPACE_NAME, discard: v.optional(v.boolean()) }),
    timeoutMs: SHORT_TIMEOUT_MS,
    async run({ data }) {
      const discarded = data.discard === true;
      return {
        output: await withWorkspace(data.workspace, async (target) => {
          if (discarded) await target.discard();
          return { ok: true as const, workspace: target.name, closed: true, discarded };
        }),
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
        }, signal),
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
        }, signal),
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
        }, signal),
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
        }, signal),
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
    `find ${shellQuote(path)} -mindepth 1 -maxdepth ${depth} \\( -name .git -o -name node_modules \\) -prune ${format} -o ${format} | head -n ${MAX_LISTED_FILES + 1}`,
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
  const trimmed = path.trim().replace(/\/+$/, '');
  if (trimmed === WORKSPACE_DIR || trimmed === '' || trimmed === '.') return WORKSPACE_DIR;
  return workspaceFilePath(trimmed);
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
  if (error instanceof SandboxSessionCapError) return failure('session_cap', SESSION_CAP_MESSAGE);
  if (error instanceof SandboxUnavailableError || error instanceof SandboxDiedError) {
    return failure('workspace_unavailable', UNAVAILABLE_MESSAGE);
  }
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return failure('timeout', 'The workspace operation did not finish in time.');
  }
  if (error instanceof ArtifactSizeError) {
    return failure('too_large', 'That file is over the size limit for this call.', error.maxBytes);
  }
  if (error instanceof Error && /must be (?:under|a normalized file under) \/workspace/.test(error.message)) {
    return failure('invalid_path', error.message);
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
