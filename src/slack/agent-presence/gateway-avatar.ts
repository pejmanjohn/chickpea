import { generatedAgentAvatarPng } from './avatar-assets.ts';
import { SlackTransportError } from '../transport/types.ts';

const MAX_AVATAR_PUBLICATION_ATTEMPTS = 3;

interface PublishedGeneratedAgentAvatar {
  url: string;
  revision: number;
}

export interface GeneratedAgentAvatarPublishInput {
  agentId: string;
  revision: number;
  contentType: 'image/png';
  bytes: Uint8Array;
}

/**
 * Publish the Worker's exact generated PNG through immutable gateway storage.
 * A revision can already contain bytes from the retired gateway renderer, so
 * advance narrowly on that one collision instead of changing the selected art.
 */
export async function publishGeneratedAgentAvatar(input: {
  agentId: string;
  revision: number;
  seed: string;
  publish: (input: GeneratedAgentAvatarPublishInput) => Promise<string>;
}): Promise<PublishedGeneratedAgentAvatar> {
  const bytes = await generatedAgentAvatarPng(input.seed);
  let revision = input.revision;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return {
        url: await input.publish({
          agentId: input.agentId,
          revision,
          contentType: 'image/png',
          bytes,
        }),
        revision,
      };
    } catch (error) {
      if (!(error instanceof SlackTransportError) ||
          error.code !== 'avatar_revision_exists' ||
          attempt >= MAX_AVATAR_PUBLICATION_ATTEMPTS ||
          revision >= Number.MAX_SAFE_INTEGER) {
        throw error;
      }
      revision += 1;
    }
  }
}
