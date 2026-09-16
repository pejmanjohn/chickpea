import { ModelRoleRevisionConflictError } from './errors.ts';
import type { ConfigStore } from './store.ts';
import type { ImageModelId } from '../model-catalog/image-profiles.ts';

export const OPENAI_API_IMAGE_DEFAULT_MODEL_ID = 'openai/gpt-image-2.5-flare' as const;

interface WorkspaceImageDefaultInput {
  config: ConfigStore;
  workspaceId: string;
  modelId: ImageModelId;
  membershipId?: string;
}

function reportImageDefaultInitializationFailure(): void {
  try {
    console.error('[chickpea] optional image default initialization failed');
  } catch {
    // Logging must not turn this optional convenience into a credential failure.
  }
}

/**
 * Seeds an image role only when this workspace has never configured one.
 * A row with no model is an intentional "Not set" selection and is preserved.
 */
async function initializeWorkspaceImageDefault(input: WorkspaceImageDefaultInput): Promise<boolean> {
  const installation = await input.config.getWorkspaceInstallation(input.workspaceId);
  if (!installation) return false;
  if (await input.config.getWorkspaceModelRole(input.workspaceId, 'image')) return false;

  try {
    await input.config.putWorkspaceModelRole({
      workspaceId: input.workspaceId,
      role: 'image',
      modelId: input.modelId,
      ...(input.membershipId ? { lastChangedByMembershipId: input.membershipId } : {}),
    }, 0);
    return true;
  } catch (error) {
    // A concurrent explicit choice, including "Not set", always wins.
    if (error instanceof ModelRoleRevisionConflictError) return false;
    throw error;
  }
}

/** Credential completion must not fail because its optional default could not be written. */
export async function initializeWorkspaceImageDefaultBestEffort(
  resolveInput: () => Promise<WorkspaceImageDefaultInput | undefined>,
): Promise<boolean> {
  try {
    const input = await resolveInput();
    return input ? await initializeWorkspaceImageDefault(input) : false;
  } catch {
    reportImageDefaultInitializationFailure();
    return false;
  }
}
