import type { ImagesModel } from '@earendil-works/pi-ai';

// pi-ai only ships an `openrouter-images` API name; its `ImagesApi` and
// `ImagesProviderId` types stay open to other strings, so the OpenAI Images
// endpoints are named here without importing pi-ai's images entrypoint, which
// would register every built-in provider SDK and break the Worker size budget.
export const OPENAI_IMAGES_API = 'openai-images';

const OPENAI_API_BASE = 'https://api.openai.com/v1';
const OPENAI_SUBSCRIPTION_BASE = 'https://chatgpt.com/backend-api';

export const OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID = 'openai/chatgpt-image' as const;

/** Edits accept at most 16 input images (OpenAI Images API reference). */
export const IMAGE_EDIT_INPUT_CAP = 16;
/** Generations and edits return at most 10 images per call (`n`, OpenAI Images API reference). */
export const IMAGE_OUTPUT_CAP = 10;

export const IMAGE_MODEL_IDS = [
  OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
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
  authMethod: 'api_key' | 'subscription';
  maxEditInputs: number;
  maxOutputs: number;
  supportsOutputControls: boolean;
}

function apiKeyImageProfile(
  id: Exclude<ImageModelId, typeof OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID>,
  name: string,
): ImageModelProfile {
  const profile: ImageModelProfile = {
    id,
    name,
    api: OPENAI_IMAGES_API,
    provider: 'openai',
    baseUrl: OPENAI_API_BASE,
    model: id.slice('openai/'.length),
    input: ['text', 'image'],
    output: ['image'],
    authMethod: 'api_key',
    maxEditInputs: IMAGE_EDIT_INPUT_CAP,
    maxOutputs: IMAGE_OUTPUT_CAP,
    supportsOutputControls: true,
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

function subscriptionImageProfile(): ImageModelProfile {
  const profile: ImageModelProfile = {
    id: OPENAI_SUBSCRIPTION_IMAGE_MODEL_ID,
    name: 'ChatGPT Image',
    api: OPENAI_IMAGES_API,
    provider: 'openai',
    baseUrl: OPENAI_SUBSCRIPTION_BASE,
    // This is only the bounded request hint verified by the private proof. The
    // catalog id and returned appliedModel stay generic because the response
    // did not attest which image model actually rendered the output.
    model: 'gpt-image-2.5-flare',
    input: ['text'],
    output: ['image'],
    authMethod: 'subscription',
    maxEditInputs: 0,
    maxOutputs: 1,
    supportsOutputControls: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  Object.freeze(profile.input);
  Object.freeze(profile.output);
  Object.freeze(profile.cost);
  return Object.freeze(profile);
}

// Hand-authored: the Images endpoints have no model-list route worth trusting
// for this small role, and an Owner-facing picker must not show chat models.
const IMAGE_MODEL_PROFILES: readonly ImageModelProfile[] = Object.freeze([
  subscriptionImageProfile(),
  apiKeyImageProfile('openai/gpt-image-2.5-flare', 'GPT Image 2.5 Flare'),
  apiKeyImageProfile('openai/gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'),
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
