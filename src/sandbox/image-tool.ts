import { defineTool, usePersistentState, useResponseStart, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import type {
  ImageFormatPolicy,
  ImageInput,
  ImageOutputFormat,
  OpenAiImagesClient,
} from '../images/openai-images-client.ts';
import { assertArtifactDeliveryAllowed } from '../memory/tool-policy.ts';
import {
  THREAD_IMAGE_HANDLE_PREFIX,
  type ThreadImageInventory,
  type ThreadImageReader,
  type ThreadImageUnavailableDetail,
} from '../slack/thread-images.ts';
import {
  artifactFilename,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_FILENAME_CHARS,
  type SlackArtifactStageInput,
  type SlackArtifactStageOutcome,
} from './artifact-tool.ts';

export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';
/** The Agent composes the prompt; the cap keeps one tool call bounded. */
export const MAX_IMAGE_PROMPT_CHARS = 4_000;
/** Thread image handles one call may reference. */
export const MAX_IMAGE_TOOL_INPUTS = 4;
/**
 * Stall guard, not a budget cap: above the provider's documented
 * two-minute worst case, so only a network-level stall releases the lane.
 */
export const IMAGE_CALL_DEADLINE_MS = 180_000;
/** One image per response; the state records which tool call owns the slot. */
export const SLACK_IMAGE_CALL_BUDGET_NAME = 'slackImageCallBudget';

const DEFAULT_IMAGE_BASENAME = 'image';
const IMAGE_HANDLE = new RegExp(`^${THREAD_IMAGE_HANDLE_PREFIX}[1-9][0-9]{0,2}$`);
// The provider's edit endpoint takes these; a thread GIF is an image the
// inventory can address but not an input this adapter may send.
const PROVIDER_INPUT_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const FORMAT_EXTENSIONS: Record<ImageOutputFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

/** The transport facts the format policy needs; resolved lazily. */
export interface ImageToolTransport {
  maxBytes: number;
}

export type ImageClientResolution =
  | { ok: true; client: OpenAiImagesClient }
  | { ok: false; reason: 'misconfigured' };

export interface ImageArtifactToolOptions {
  /** From the frozen plan's capability: image input fields exist only here. */
  acceptsImageInput: boolean;
  /** Per-turn handles for images already in this conversation. */
  inventory: ThreadImageInventory;
  /** Keyed by tool call id so a durable replay keeps the slot it already took. */
  reserveImageCall(toolCallId: string): boolean;
  /** The installation's upload cap, known only after transport resolution. */
  resolveTransport(): Promise<ImageToolTransport>;
  /** Resolves the model id and provider credential at call time. */
  resolveClient(): Promise<ImageClientResolution>;
  /** Bounded reads through the existing attachment path. */
  createImageReader(limits: {
    perFileLimitBytes: number;
    totalLimitBytes: number;
    signal?: AbortSignal;
  }): Promise<ThreadImageReader>;
  stageArtifact(input: SlackArtifactStageInput): Promise<SlackArtifactStageOutcome>;
}

/** Every outcome is a returned value; only the delivery gate throws. */
export type ImageArtifactResult =
  | {
      attached: true;
      filename: string;
      byteLength: number;
      appliedModel: string;
      appliedSize: string;
      appliedFormat: ImageOutputFormat;
      handle: string;
      usage?: Record<string, unknown>;
    }
  | Extract<SlackArtifactStageOutcome, { attached: false }>
  | { attached: false; reason: 'timeout' }
  | { attached: false; reason: 'rejected' }
  | { attached: false; reason: 'misconfigured' }
  | { attached: false; reason: 'limit' }
  | {
      attached: false;
      reason: 'input-unavailable';
      detail: ThreadImageUnavailableDetail;
      handle: string;
    };

/** Recorded by `step.do('generate')`: metadata and never bytes. */
type ImageGenerationStep =
  | {
      ok: true;
      byteLength: number;
      appliedModel: string;
      appliedSize: string;
      appliedFormat: ImageOutputFormat;
      usage?: Record<string, unknown>;
    }
  | { ok: false; failure: Extract<ImageArtifactResult, { attached: false }> };

const PROMPT_FIELD = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(MAX_IMAGE_PROMPT_CHARS),
);
const FILENAME_FIELD = v.optional(
  v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_ARTIFACT_FILENAME_CHARS)),
);

const IMAGE_GENERATE_INPUT = v.object({ prompt: PROMPT_FIELD, filename: FILENAME_FIELD });
const IMAGE_EDIT_INPUT = v.object({
  prompt: PROMPT_FIELD,
  filename: FILENAME_FIELD,
  inputs: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.regex(IMAGE_HANDLE))),
      v.maxLength(MAX_IMAGE_TOOL_INPUTS),
    ),
  ),
  intent: v.optional(v.picklist(['generate', 'edit'])),
});

type ImageToolData = v.InferOutput<typeof IMAGE_EDIT_INPUT>;

function imageToolDescription(acceptsImageInput: boolean): string {
  return [
    'Generate an image and attach it to your final reply in the bound Slack destination.',
    'Write the whole prompt yourself from the conversation; the workspace owns the model, so pass no model, size, or quality.',
    acceptsImageInput
      ? `To edit or combine images already in this conversation, list their img:N handles in inputs (at most ${MAX_IMAGE_TOOL_INPUTS}) and set intent to edit; with no inputs the model generates from the prompt alone.`
      : 'This model generates from the prompt alone and cannot take an existing image as input.',
    'One image per reply. The result reports the model and settings the provider applied.',
    'If the result reports attached: false, explain the returned reason and never say an image was attached or edited.',
  ].join(' ');
}

/**
 * The one image tool. The host owns the destination, the model, and the
 * output format; the model chooses only the prompt, optional thread image
 * handles, and a filename. Generation and staging each run inside a durable
 * step, so a replayed tool call neither pays for a second image nor stages a
 * second file.
 */
export function createImageArtifactTool(options: ImageArtifactToolOptions) {
  return defineTool({
    name: GENERATE_IMAGE_TOOL_NAME,
    description: imageToolDescription(options.acceptsImageInput),
    input: (options.acceptsImageInput
      ? IMAGE_EDIT_INPUT
      : IMAGE_GENERATE_INPUT) as typeof IMAGE_EDIT_INPUT,
    durable: true,
    async run({ data, toolCallId, step, signal }) {
      assertArtifactDeliveryAllowed();
      if (!options.reserveImageCall(toolCallId)) {
        return imageToolOutput({ attached: false, reason: 'limit' });
      }
      // Held only for this execution: a replay resumes with the recorded
      // metadata and no bytes, and reports honestly instead of regenerating.
      let generatedBytes: Uint8Array | undefined;
      const generated = await step.do('generate', async (): Promise<ImageGenerationStep> => {
        const transport = await options.resolveTransport();
        const format = imageFormatPolicyForTransport(transport.maxBytes, data.prompt);
        const inputs = await resolveImageInputs(options, data, signal, transport.maxBytes);
        if ('failure' in inputs) return { ok: false, failure: inputs.failure };
        const resolved = await options.resolveClient();
        if (!resolved.ok) return { ok: false, failure: { attached: false, reason: 'misconfigured' } };
        const request = {
          prompt: data.prompt,
          format,
          deadlineMs: IMAGE_CALL_DEADLINE_MS,
          ...(signal ? { signal } : {}),
        };
        const result = inputs.images.length > 0
          ? await resolved.client.edit({ ...request, inputs: inputs.images })
          : await resolved.client.generate(request);
        if (!result.ok) {
          return { ok: false, failure: { attached: false, reason: providerFailureReason(result.reason) } };
        }
        if (result.bytes.byteLength > transport.maxBytes) {
          return {
            ok: false,
            failure: { attached: false, reason: 'too-large', maxBytes: transport.maxBytes },
          };
        }
        generatedBytes = result.bytes;
        return {
          ok: true,
          byteLength: result.bytes.byteLength,
          appliedModel: result.appliedModel,
          appliedSize: result.appliedSize,
          appliedFormat: result.appliedFormat,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      });
      if (!generated.ok) return imageToolOutput(generated.failure);

      const filename = imageFilename(data.filename, generated.appliedFormat);
      const staged = await step.do('stage', async (): Promise<SlackArtifactStageOutcome> => {
        // Reached only when this execution generated the bytes. A replay that
        // lost them never stages a second file for the same tool call.
        if (!generatedBytes) return { attached: false, reason: 'unavailable' };
        return options.stageArtifact({ bytes: generatedBytes, filename, kind: 'image' });
      });
      if (!staged.attached) return imageToolOutput(staged);
      return imageToolOutput({
        attached: true,
        filename,
        byteLength: generated.byteLength,
        appliedModel: generated.appliedModel,
        appliedSize: generated.appliedSize,
        appliedFormat: generated.appliedFormat,
        handle: nextThreadImageHandle(options.inventory),
        ...(generated.usage ? { usage: generated.usage } : {}),
      });
    },
  });
}

/**
 * The result the model sees. `usage` is the provider's own object, passed
 * through unchanged, so the bounded contract is asserted here rather than
 * re-typed field by field.
 */
function imageToolOutput(result: ImageArtifactResult): { output: JsonValue } {
  return { output: result as unknown as JsonValue };
}

async function resolveImageInputs(
  options: ImageArtifactToolOptions,
  data: ImageToolData,
  signal: AbortSignal | undefined,
  perFileLimitBytes: number,
): Promise<{ images: ImageInput[] } | { failure: Extract<ImageArtifactResult, { attached: false }> }> {
  const handles = options.acceptsImageInput ? data.inputs ?? [] : [];
  if (handles.length === 0) return { images: [] };
  const reader = await options.createImageReader({
    perFileLimitBytes,
    totalLimitBytes: MAX_ARTIFACT_BYTES,
    ...(signal ? { signal } : {}),
  });
  const images: ImageInput[] = [];
  for (const handle of handles) {
    const resolution = options.inventory.resolveHandle(handle);
    if (!resolution.ok) return { failure: inputUnavailable(handle, resolution.detail) };
    const read = await reader.read(resolution.record);
    if (!read.ok) return { failure: inputUnavailable(handle, read.detail) };
    if (!PROVIDER_INPUT_MIME_TYPES.has(read.mimeType)) {
      return { failure: inputUnavailable(handle, 'unsupported_type') };
    }
    images.push({ bytes: read.bytes, mimeType: read.mimeType });
  }
  return { images };
}

function inputUnavailable(
  handle: string,
  detail: ThreadImageUnavailableDetail,
): Extract<ImageArtifactResult, { reason: 'input-unavailable' }> {
  return { attached: false, reason: 'input-unavailable', detail, handle };
}

/**
 * Direct installations take the provider default as PNG. A shared gateway
 * caps uploads far lower, so it asks for a compressed format: WebP when the
 * request wants transparency, JPEG otherwise.
 */
export function imageFormatPolicyForTransport(maxBytes: number, prompt: string): ImageFormatPolicy {
  if (maxBytes >= MAX_ARTIFACT_BYTES) return { format: 'png' };
  return {
    format: wantsTransparentBackground(prompt) ? 'webp' : 'jpeg',
    compression: compressionForCap(maxBytes),
  };
}

/**
 * Only the container format is chosen here: `background` stays unset so the
 * provider's own default decides, and a prompt that merely mentions
 * transparency cannot force an alpha channel onto an opaque image.
 */
function wantsTransparentBackground(prompt: string): boolean {
  return /\btransparen(?:t|cy)\b/i.test(prompt);
}

function compressionForCap(maxBytes: number): number {
  if (maxBytes >= 4 * 1024 * 1024) return 90;
  if (maxBytes >= 1024 * 1024) return 80;
  return 60;
}

/** Client failures the tool reports; nothing carries provider or prompt text. */
function providerFailureReason(
  reason: 'rejected' | 'misconfigured' | 'timeout' | 'unreachable' | 'invalid-request',
): 'rejected' | 'misconfigured' | 'timeout' | 'unavailable' {
  if (reason === 'rejected' || reason === 'misconfigured' || reason === 'timeout') return reason;
  // A transport failure and a request this build should never have sent are
  // both "no image, try later"; neither is the content's fault.
  return 'unavailable';
}

/** The handle the staged image takes in the next turn's inventory. */
function nextThreadImageHandle(inventory: ThreadImageInventory): string {
  return `img:${inventory.entries.length + 1}`;
}

/** Keep the Slack-visible filename a safe basename matching the applied format. */
export function imageFilename(
  requested: string | undefined,
  format: ImageOutputFormat,
): string {
  return artifactFilename(requested, DEFAULT_IMAGE_BASENAME, FORMAT_EXTENSIONS[format]);
}

interface ImageCallBudgetState {
  schemaVersion: 1;
  /** The tool call that owns this response's one image call. */
  toolCallId: string | null;
}

/**
 * Root-Agent hook: one image call per response. The reservation is
 * keyed by tool call id, so a durable replay of the same call keeps the slot
 * it already took and a second call in the same response is refused.
 */
export function useImageCallBudget(): (toolCallId: string) => boolean {
  const [, update] = usePersistentState<ImageCallBudgetState>(
    SLACK_IMAGE_CALL_BUDGET_NAME,
    { schemaVersion: 1, toolCallId: null },
  );
  useResponseStart(() => { update({ schemaVersion: 1, toolCallId: null }); });
  return (toolCallId: string) => {
    let allowed = false;
    update((previous) => {
      const owner = previous?.toolCallId ?? null;
      allowed = owner === null || owner === toolCallId;
      return allowed ? { schemaVersion: 1, toolCallId } : { schemaVersion: 1, toolCallId: owner };
    });
    return allowed;
  };
}
