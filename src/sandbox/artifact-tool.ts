import { defineTool, type SandboxFactory, type SessionEnv } from '@flue/runtime';
import * as v from 'valibot';

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
    async run({ input }) {
      if (!sessionEnv) {
        throw new Error('workspace is not initialized');
      }
      const path = workspaceArtifactPath(input.path);
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
      return options.postArtifact({
        channel: options.channel,
        threadTs: options.threadTs,
        bytes,
        filename: input.filename,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
    },
  });

  return { sandbox, tool };
}

async function readFrozenWorkspaceArtifact(
  sessionEnv: SessionEnv,
  sourcePath: string,
): Promise<Uint8Array> {
  const tempPath = randomWorkspaceArtifactPath();
  try {
    // The model controls sourcePath and can mutate it after the fast pre-stat.
    // Copy at most the cap into a new trusted-name file, then inspect and read
    // only that frozen object. Noclobber keeps the random path new even in the
    // vanishingly unlikely event of a collision.
    const copy = await sessionEnv.exec(
      `umask 077; set -C; head -c ${MAX_ARTIFACT_BYTES} -- ${shellQuote(sourcePath)} > ${shellQuote(tempPath)}`,
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
    if (stat.size > MAX_ARTIFACT_BYTES) {
      throw new Error('artifact exceeds the 8 MB upload limit');
    }

    const bytes = await sessionEnv.readFileBuffer(tempPath);
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error('artifact exceeds the 8 MB upload limit');
    }
    return bytes;
  } finally {
    await sessionEnv.rm(tempPath, { force: true }).catch(() => {});
  }
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

function workspaceArtifactPath(path: string): string {
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
