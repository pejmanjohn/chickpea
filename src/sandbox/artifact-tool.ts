import { defineTool, type SandboxFactory, type SessionEnv } from '@flue/runtime';
import * as v from 'valibot';

import { assertArtifactDeliveryAllowed } from '../memory/tool-policy.ts';
import type {
  SlackArtifactInput,
  SlackArtifactResult,
} from '../slack/web-client-presenter.ts';
import type { SandboxSelection } from './select.ts';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const POST_ARTIFACT_TOOL_NAME = 'post_artifact';

/**
 * Model-facing guidance shared by every lane that mounts the artifact tools.
 * It is deliberately short: the tool descriptions carry the mechanics.
 */
export const ARTIFACT_TOOLS_INSTRUCTION =
  'Use `render_chart` when the user asks for a chart, graph, plot, or an image of numbers; use `post_artifact` to attach another file you wrote in the sandbox (CSV, Markdown, JSON, text, SVG, or a workspace build output). These tools deliver to the bound Slack destination. State the key figures in the final reply as well. If a tool reports uploaded: false with reason missing-scope, explain that this workspace does not permit uploads and include the content in the reply. If the reason is too-large, explain the returned size limit and offer a smaller file; do not retry the same file. If the current-request policy denies delivery because the user did not explicitly ask for a file or chart, answer in text and say they can ask explicitly for a chart or file. Never claim an upload succeeded without a successful tool result.';

export interface ArtifactDestinationBinding {
  channel: string;
  threadTs?: string;
  postArtifact(input: SlackArtifactInput): Promise<SlackArtifactResult>;
  /**
   * Which sandbox holds the file. The container sandbox freezes a bounded
   * copy through the shell; the in-memory sandbox reads bytes directly,
   * because just-bash pipes are string-based and would re-encode binary data.
   */
  sandboxKind: SandboxSelection;
}

interface WorkspaceArtifactCapabilityOptions extends ArtifactDestinationBinding {
  sandbox: SandboxFactory;
}

const ARTIFACT_INPUT = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  filename: v.pipe(v.string(), v.minLength(1)),
  title: v.optional(v.pipe(v.string(), v.minLength(1))),
});

function artifactToolDescription(sandboxKind: SandboxSelection): string {
  return sandboxKind === 'cloudflare'
    ? 'Attach a file from the coding workspace (a path under /workspace, up to 8 MiB for direct Slack apps or 700 KiB through the shared gateway) to the bound Slack destination. If the result reports uploaded: false, explain the reason and describe the verified artifact in the final reply instead.'
    : 'Attach a file you wrote in the sandbox filesystem (an absolute path, or a path relative to the working directory, up to 8 MiB for direct Slack apps or 700 KiB through the shared gateway) to the bound Slack destination. Write the file first with the write tool or the shell, then call this with a filename the user will see. If the result reports uploaded: false, explain the reason and include the content in the final reply instead.';
}

/** Flue 2 hook-agent variant: the harness supplies the initialized sandbox. */
export function createWorkspaceArtifactTool(options: ArtifactDestinationBinding) {
  return defineTool({
    name: POST_ARTIFACT_TOOL_NAME,
    description: artifactToolDescription(options.sandboxKind),
    input: ARTIFACT_INPUT,
    harness: true,
    async run({ data, harness }) {
      return { output: await deliverArtifact(harness.sandbox, data, options) };
    },
  });
}

/**
 * Capture the SessionEnv Flue creates for the selected sandbox and expose
 * one destination-bound upload tool. The model selects only a file path and
 * presentation metadata; trusted code owns the Slack channel and thread.
 */
export function createWorkspaceArtifactCapability(
  options: WorkspaceArtifactCapabilityOptions,
) {
  let sessionEnv: SessionEnv | undefined;
  const sandbox: SandboxFactory = {
    async createSessionEnv(createOptions) {
      const created = await options.sandbox.createSessionEnv(createOptions);
      sessionEnv = created;
      return created;
    },
    ...(options.sandbox.tools === undefined ? {} : { tools: options.sandbox.tools }),
  };

  const tool = defineTool({
    name: POST_ARTIFACT_TOOL_NAME,
    description: artifactToolDescription(options.sandboxKind),
    input: ARTIFACT_INPUT,
    async run({ data }) {
      if (!sessionEnv) {
        throw new Error('workspace is not initialized');
      }
      return { output: await deliverArtifact(sessionEnv, data, options) };
    },
  });

  return { sandbox, tool };
}

async function deliverArtifact(
  sessionEnv: SessionEnv,
  data: v.InferOutput<typeof ARTIFACT_INPUT>,
  binding: ArtifactDestinationBinding,
): Promise<SlackArtifactResult> {
  assertArtifactDeliveryAllowed();
  const bytes = await readSandboxArtifact(sessionEnv, data.path, binding.sandboxKind);
  return binding.postArtifact({
    channel: binding.channel,
    ...(binding.threadTs ? { threadTs: binding.threadTs } : {}),
    bytes,
    filename: data.filename,
    ...(data.title === undefined ? {} : { title: data.title }),
  });
}

/**
 * Read a model-selected file with the strategy that is safe for its sandbox.
 * Both strategies stat first, refuse anything over the cap without reading,
 * and re-check the bytes actually obtained.
 */
export async function readSandboxArtifact(
  sessionEnv: SessionEnv,
  requestedPath: string,
  sandboxKind: SandboxSelection,
): Promise<Uint8Array> {
  if (sandboxKind === 'cloudflare') {
    const path = workspaceArtifactPath(requestedPath);
    await assertArtifactWithinCap(sessionEnv, path, MAX_ARTIFACT_BYTES);
    return freezeWorkspaceArtifact(sessionEnv, path, MAX_ARTIFACT_BYTES, true);
  }
  const path = sandboxArtifactPath(sessionEnv, requestedPath);
  await assertArtifactWithinCap(sessionEnv, path, MAX_ARTIFACT_BYTES);
  // The in-memory filesystem hands back a complete buffer in one call, so a
  // concurrent tool cannot grow the file between this read and the check.
  const bytes = await sessionEnv.readFileBuffer(path);
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw artifactSizeError(MAX_ARTIFACT_BYTES);
  return bytes;
}

async function assertArtifactWithinCap(
  sessionEnv: SessionEnv,
  path: string,
  maxBytes: number,
): Promise<void> {
  const stat = await sessionEnv.stat(path);
  if (!stat.isFile) throw new Error('artifact path must identify a file');
  if (
    typeof stat.size !== 'number' ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0
  ) {
    throw new Error('artifact size is unavailable');
  }
  if (stat.size > maxBytes) throw artifactSizeError(maxBytes);
}

/** Freeze a workspace-owned file under a trusted random name before reading it. */
export async function freezeWorkspaceArtifact(
  sessionEnv: SessionEnv,
  sourcePath: string,
  maxBytes: number,
  sourceAlreadyValidated = false,
): Promise<Uint8Array> {
  const normalizedSource = workspaceArtifactPath(sourcePath);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
    throw new Error('artifact size limit is invalid');
  }
  if (!sourceAlreadyValidated) {
    await assertArtifactWithinCap(sessionEnv, normalizedSource, maxBytes);
  }
  const tempPath = randomWorkspaceArtifactPath();
  try {
    // The model controls sourcePath and can mutate it after the fast pre-stat.
    // Copy at most the cap into a new trusted-name file, then inspect and read
    // only that frozen object. Noclobber keeps the random path new even in the
    // vanishingly unlikely event of a collision.
    const copy = await sessionEnv.exec(
      `umask 077; set -C; head -c ${maxBytes + 1} -- ${shellQuote(normalizedSource)} > ${shellQuote(tempPath)}`,
      { timeoutMs: 30_000 },
    );
    if (copy.exitCode !== 0) {
      throw new Error('artifact could not be copied for upload');
    }

    const stat = await sessionEnv.stat(tempPath);
    if (!stat.isFile) {
      throw new Error('artifact copy must identify a file');
    }
    if (
      typeof stat.size !== 'number' ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0
    ) {
      throw new Error('artifact copy size is unavailable');
    }
    if (stat.size > maxBytes) {
      throw artifactSizeError(maxBytes);
    }

    const bytes = await sessionEnv.readFileBuffer(tempPath);
    if (bytes.byteLength > maxBytes) {
      throw artifactSizeError(maxBytes);
    }
    return bytes;
  } finally {
    await sessionEnv.rm(tempPath, { force: true }).catch(() => {});
  }
}

function artifactSizeError(maxBytes: number): Error {
  return new Error(maxBytes === MAX_ARTIFACT_BYTES
    ? 'artifact exceeds the 8 MB upload limit'
    : 'artifact exceeds its upload limit');
}

function randomWorkspaceArtifactPath(): string {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hex = [...random]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return workspaceArtifactPath(`/workspace/.chickpea-artifact-${hex}.tmp`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function workspaceArtifactPath(path: string): string {
  if (!path.startsWith('/workspace/')) {
    throw new Error('artifact path must be under /workspace');
  }
  const relative = path.slice('/workspace/'.length);
  const segments = relative.split('/');
  if (
    relative.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('artifact path must be a normalized file under /workspace');
  }
  return `/workspace/${relative}`;
}

/**
 * Resolve a path inside the in-memory sandbox. Relative paths follow the
 * session's working directory; the result must be an absolute, normalized
 * file path so the model cannot smuggle traversal segments past the check.
 */
export function sandboxArtifactPath(
  sessionEnv: Pick<SessionEnv, 'resolvePath'>,
  requestedPath: string,
): string {
  const trimmed = requestedPath.trim();
  if (trimmed.length === 0) throw new Error('artifact path is required');
  const resolved = sessionEnv.resolvePath(trimmed);
  if (!resolved.startsWith('/')) throw new Error('artifact path must resolve to an absolute path');
  const segments = resolved.slice(1).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('artifact path must be a normalized file path');
  }
  return resolved;
}
