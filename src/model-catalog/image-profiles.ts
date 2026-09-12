import type { ImagesModel } from '@earendil-works/pi-ai';

// pi-ai only ships an `openrouter-images` API name; its `ImagesApi` and
// `ImagesProviderId` types stay open to other strings, so the OpenAI Images
// endpoints are named here without importing pi-ai's images entrypoint, which
// would register every built-in provider SDK and break the Worker size budget.
export const OPENAI_IMAGES_API = 'openai-images';

const OPENAI_API_BASE = 'https://api.openai.com/v1';

/** Edits accept at most 16 input images (OpenAI Images API reference). */
export const IMAGE_EDIT_INPUT_CAP = 16;

export const IMAGE_MODEL_IDS = [
  'openai/gpt-image-2.5-flare',
  'openai/gpt-image-2.5-sunburst',
] as const;

export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];

export interface ImageModelProfile extends ImagesModel<typeof OPENAI_IMAGES_API> {
  id: ImageModelId;
  provider: 'openai';
  /** Wire model id. Catalog ids carry the provider prefix; the API does not. */
  model: string;
  input: ('text' | 'image')[];
  output: ['image'];
  maxEditInputs: typeof IMAGE_EDIT_INPUT_CAP;
}

function imageProfile(id: ImageModelId, name: string): ImageModelProfile {
  const profile: ImageModelProfile = {
    id,
    name,
    api: OPENAI_IMAGES_API,
    provider: 'openai',
    baseUrl: OPENAI_API_BASE,
    model: id.slice('openai/'.length),
    input: ['text', 'image'],
    output: ['image'],
    maxEditInputs: IMAGE_EDIT_INPUT_CAP,
    // pi-ai's model type requires rates. Image calls are not metered in this
    // release (metering is deferred); the provider's own usage object is
    // returned by the client instead of being priced here.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  Object.freeze(profile.input);
  Object.freeze(profile.output);
  Object.freeze(profile.cost);
  return Object.freeze(profile);
}

// Hand-authored: the Images endpoints have no model-list route worth trusting
// for a two-model role, and an Owner-facing picker must not show chat models.
const IMAGE_MODEL_PROFILES: readonly ImageModelProfile[] = Object.freeze([
  imageProfile('openai/gpt-image-2.5-flare', 'GPT Image 2.5 Flare'),
  imageProfile('openai/gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'),
]);

/** Image-capable models for one provider id; empty for every other provider. */
export function listImageModels(providerId: string): ImageModelProfile[] {
  return IMAGE_MODEL_PROFILES.filter((profile) => profile.provider === providerId);
}

export function findImageModel(modelId: string): ImageModelProfile | undefined {
  return IMAGE_MODEL_PROFILES.find((profile) => profile.id === modelId);
}

export function isImageModelId(value: unknown): value is ImageModelId {
  return typeof value === 'string' && findImageModel(value) !== undefined;
}
