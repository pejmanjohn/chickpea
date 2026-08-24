import { defineTool, type SandboxFactory, type SessionEnv } from '@flue/runtime';
import * as v from 'valibot';

import { assertCurrentRequestSideEffectAllowed } from '../memory/tool-policy.ts';
import type {
  SlackArtifactInput,
  SlackArtifactResult,
} from '../slack/web-client-presenter.ts';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

interface WorkspaceArtifactCapabilityOptions {
  sandbox: SandboxFactory;
  channel: string;
  threadTs: string;
  postArtifact(input: SlackArtifactInput): Promise<SlackArtifactResult>;
}

export interface WorkspaceArtifactToolOptions {
  channel: string;
  threadTs: string;
  postArtifact(input: SlackArtifactInput): Promise<SlackArtifactResult>;
}

/** Flue 2 hook-agent variant: the harness supplies the initialized sandbox. */
export function createWorkspaceArtifactTool(options: WorkspaceArtifactToolOptions) {
  return defineTool({
    name: 'post_artifact',
    description:
      'Attach a file written under /workspace to the current Slack thread. If Slack file uploads are unavailable, describe the verified artifact in the final reply instead.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      filename: v.pipe(v.string(), v.minLength(1)),
      title: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    harness: true,
    async run({ data, harness }) {
      assertCurrentRequestSideEffectAllowed('post_artifact');
      const sessionEnv = harness.sandbox;
      const path = workspaceArtifactPath(data.path);
      const stat = await sessionEnv.stat(path);
      if (!stat.isFile) throw new Error('artifact path must identify a file');
      if (!Number.isSafeInteger(stat.size) || Number(stat.size) < 0) {
        throw new Error('artifact size is unavailable');
      }
      if (Number(stat.size) > MAX_ARTIFACT_BYTES) {
        throw new Error('artifact exceeds the 8 MB upload limit');
      }
      const bytes = await readFrozenWorkspaceArtifact(sessionEnv, path);
      return {
        output: await options.postArtifact({
          channel: options.channel,
          threadTs: options.threadTs,
          bytes,
          filename: data.filename,
          ...(data.title === undefined ? {} : { title: data.title }),
        }),
      };
    },
  });
}

/**
 * Capture the SessionEnv Flue creates for the selected workspace and expose
 * one destination-bound upload tool. The model selects only a file under the
 * workspace root and presentation metadata; trusted code owns the Slack
 * channel and thread.
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
    name: 'post_artifact',
    description:
      'Attach a file written under /workspace to the current Slack thread. If Slack file uploads are unavailable, describe the verified artifact in the final reply instead.',
    input: v.object({
      path: v.pipe(v.string(), v.minLength(1)),
      filename: v.pipe(v.string(), v.minLength(1)),
      title: v.optional(v.pipe(v.string(), v.minLength(1))),
    }),
    async run({ data }) {
      assertCurrentRequestSideEffectAllowed('post_artifact');
      if (!sessionEnv) {
        throw new Error('workspace is not initialized');
      }
      const path = workspaceArtifactPath(data.path);
      const stat = await sessionEnv.stat(path);
      if (!stat.isFile) {
        throw new Error('artifact path must identify a file');
      }
      if (
        typeof stat.size !== 'number' ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0
      ) {
        throw new Error('artifact size is unavailable');
      }
      if (stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('artifact exceeds the 8 MB upload limit');
      }
      const bytes = await readFrozenWorkspaceArtifact(sessionEnv, path);
      return { output: await options.postArtifact({
        channel: options.channel,
        threadTs: options.threadTs,
        bytes,
        filename: data.filename,
        ...(data.title === undefined ? {} : { title: data.title }),
      }) };
    },
  });

  return { sandbox, tool };
}

async function readFrozenWorkspaceArtifact(
  sessionEnv: SessionEnv,
  sourcePath: string,
): Promise<Uint8Array> {
  return freezeWorkspaceArtifact(sessionEnv, sourcePath, MAX_ARTIFACT_BYTES, true);
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
    const sourceStat = await sessionEnv.stat(normalizedSource);
    if (!sourceStat.isFile) throw new Error('artifact path must identify a file');
    if (!Number.isSafeInteger(sourceStat.size) || Number(sourceStat.size) < 0) {
      throw new Error('artifact size is unavailable');
    }
    if (Number(sourceStat.size) > maxBytes) throw artifactSizeError(maxBytes);
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
