import { defineTool, type SandboxFactory, type SessionEnv } from '@flue/runtime';
import * as v from 'valibot';

import type { SandboxSelection } from './select.ts';
import type {
  SlackArtifactInput,
  SlackArtifactResult,
} from '../slack/web-client-presenter.ts';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

interface WorkspaceArtifactCapabilityOptions {
  sandbox: SandboxFactory;
  selection: Exclude<SandboxSelection, 'bash'>;
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
      const path = workspaceArtifactPath(input.path, options.selection);
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
      const bytes = await sessionEnv.readFileBuffer(path);
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

function workspaceArtifactPath(
  path: string,
  selection: Exclude<SandboxSelection, 'bash'>,
): string {
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
  // The local adapter roots relative paths at its configured workspace.
  return selection === 'local' ? relative : `/workspace/${relative}`;
}
