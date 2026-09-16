import { defineTool, usePersistentState, useResponseStart, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import { IMAGE_QUALITIES, IMAGE_BACKGROUNDS, validImageSize, type ImageBackground } from '../images/output-controls.ts';
import { type ImageOutputStore, SAVED_IMAGE_ID } from '../images/output-store.ts';
import { prepareImageOutput, type PreparedImage, type ImageFacts } from '../images/prepare-output.ts';
import type { ImageInspection, ImageInspectionInput } from '../images/inspect-output.ts';

import type {
  ImageCallFailureReason,
  ImageCallResult,
  ImageCallUsage,
  ImageFormatPolicy,
  ImageInput,
  ImageOutputFormat,
  OpenAiImagesClient,
} from '../images/openai-images-client.ts';
import { assertArtifactDeliveryAllowed } from '../memory/tool-policy.ts';
import {
  DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES,
  THREAD_IMAGE_HANDLE_PREFIX,
  type ThreadImageInventory,
  type ThreadImageReader,
  type ThreadImageRecord,
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
 * Images one response may attach across every image call it makes. One call
 * asking for variations and several calls with different prompts draw on the
 * same quota, which bounds provider spend and how long the turn holds the
 * lane, since separate calls render sequentially.
 */
export const MAX_IMAGES_PER_RESPONSE = 4;
/**
 * Variations one call may ask for; the provider renders them in one round
 * trip. Equal to the response quota, so a single call can spend all of it.
 */
export const MAX_IMAGE_TOOL_OUTPUTS = MAX_IMAGES_PER_RESPONSE;
/**
 * Stall guard, not a budget cap: above the provider's documented
 * two-minute worst case, so only a network-level stall releases the lane.
 */
export const IMAGE_CALL_DEADLINE_MS = 180_000;
/** The response's image quota; the state records how many images each tool call reserved. */
export const SLACK_IMAGE_CALL_BUDGET_NAME = 'slackImageCallBudget';

const DEFAULT_IMAGE_BASENAME = 'image';
/** Detail codes are diagnosis tokens, not messages. */
const MAX_IMAGE_DETAIL_CHARS = 64;
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

/** Whether the call may render `count` images; `remaining` is what the response still has. */
export interface ImageReservationOutcome {
  ok: boolean;
  remaining: number;
}

/**
 * The response's image quota. A call reserves the images it will render
 * before the provider runs; a replay of the same call keeps what it already
 * reserved. `release` is present when the Root Agent's budget hook supplied
 * it, so a call that fails before the provider hands its images back instead
 * of burning part of the response's quota.
 */
export interface ImageCallReservation {
  (toolCallId: string, count: number): ImageReservationOutcome;
  release?(toolCallId: string): void;
}

export type ImageClientResolution =
  | { ok: true; client: OpenAiImagesClient }
  | { ok: false; reason: 'misconfigured' };

export interface ImageArtifactToolOptions {
  outputStore?: ImageOutputStore;
  prepareOutput?: typeof prepareImageOutput;
  inspectOutput?: (input: ImageInspectionInput) => Promise<ImageInspection>;
  /** From the frozen plan's capability: image input fields exist only here. */
  acceptsImageInput: boolean;
  /** A stricter call limit from the resolved image model's frozen capability. */
  maxOutputsPerCall?: number;
  supportsOutputControls?: boolean;
  /** Per-turn handles for images already in this conversation. */
  inventory: ThreadImageInventory;
  /** Keyed by tool call id so a durable replay keeps the images it already reserved. */
  reserveImageCall: ImageCallReservation;
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
  reuseImage?(input: { record: ThreadImageRecord; filename: string; byteLength: number }): Promise<SlackArtifactStageOutcome>;
}

/**
 * Which half of the pipeline produced an `unavailable` result. The two look
 * identical from Slack, so the Agent could not previously tell "the provider
 * never returned an image" from "the image exists but would not attach"; the
 * source and detail make the reply say which, without naming internals.
 */
export type ImageUnavailableSource = 'provider' | 'staging';

/**
 * A bounded diagnosis token for an `unavailable` result. With `source:
 * 'staging'` it is a `SlackArtifactStagingDetail`, or `bytes_unavailable` when
 * a replay no longer holds the generated bytes. With `source: 'provider'` it is
 * the images client's own code — `redirect_rejected`, `response_too_large`,
 * `invalid_response`, `rate_limited`, `network_error`, `http_<status>`, or an
 * identifier-shaped code the provider named — and `unknown` when it named none.
 */
export type ImageUnavailableDetail = string;

/** One attached variation, in the order the provider returned them. */
export interface ImageArtifactFile {
  filename: string;
  byteLength: number;
  savedImage?: string | undefined;
  expiresAt?: number | undefined;
  format?: ImageOutputFormat;
  width?: number;
  height?: number;
  transparent?: boolean;
  inspection?: ImageInspection;
  corrected?: boolean;
  compressed?: boolean;
  resized?: boolean;
}

/** Why one generated variation could not be attached while the rest still may be. */
export type ImageUnattachedFailure =
  | Extract<SlackArtifactStageOutcome, { attached: false; reason: 'missing-scope' | 'too-large' }>
  | { attached: false; reason: 'unavailable'; source: ImageUnavailableSource; detail: ImageUnavailableDetail };

/** A variation that was generated but could not be attached, named by its file. */
export type ImageArtifactUnattachedFile = { filename: string; savedImage?: string | undefined; expiresAt?: number | undefined } & ImageUnattachedFailure;

/**
 * Every outcome is a returned value; only the delivery gate throws. An
 * attached result names its first file at the top level, as it always has,
 * and lists every attached variation under `files`; variations that failed
 * to attach are listed under `unattached` so the reply can say which.
 */
export type ImageArtifactResult =
  | {
      attached: true;
      filename: string;
      byteLength: number;
      appliedModel: string;
      appliedSize: string;
      appliedFormat: ImageOutputFormat;
      requestedQuality?: string;
      requestedBackground?: string;
      usage?: ImageCallUsage;
      files: ImageArtifactFile[];
      unattached?: ImageArtifactUnattachedFile[];
    }
  | Extract<SlackArtifactStageOutcome, { attached: false; reason: 'missing-scope' | 'too-large' }>
  | {
      attached: false;
      reason: 'unavailable';
      source: ImageUnavailableSource;
      detail: ImageUnavailableDetail;
      savedImage?: string | undefined;
      expiresAt?: number | undefined;
    }
  | { attached: false; reason: 'timeout' }
  | { attached: false; reason: 'rejected' }
  | { attached: false; reason: 'misconfigured' }
  | { attached: false; reason: 'limit'; remaining: number }
  | {
      attached: false;
      reason: 'input-unavailable';
      detail: ThreadImageUnavailableDetail;
      handle: string;
    };

/** Recorded by each staging step: the mapped outcome and never bytes. */
type ImageStagingStep =
  | { ok: true; byteLength: number; file?: ImageArtifactFile }
  | { ok: false; failure: Extract<ImageArtifactResult, { attached: false }>; savedImage?: string | undefined; expiresAt?: number | undefined };

/** One generated variation as the generate step records it: size only, never bytes. */
type ImageGeneratedOutput = {
  byteLength: number; tooLarge?: true; savedImage?: string; expiresAt?: number;
  facts?: ImageFacts; inspection?: ImageInspection; corrected?: boolean;
};

/**
 * Recorded by `step.do('generate')`: metadata and never bytes. `outputs`
 * arrived with variations; a record written before it carries the single
 * image's `byteLength` at the top level and replays as one output.
 */
type ImageGenerationStep =
  | {
      ok: true;
      pipelineVersion?: 1;
      byteLength: number;
      outputs?: ImageGeneratedOutput[];
      /** The upload cap the outputs were judged against; recorded so a replay reports the same limit. */
      maxBytes?: number;
      appliedModel: string;
      appliedSize: string;
      appliedFormat: ImageOutputFormat;
      usage?: ImageCallUsage;
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
const COUNT_FIELD = v.optional(
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_IMAGE_TOOL_OUTPUTS)),
);
const OUTPUT_FIELDS = {
  size: v.optional(v.pipe(v.string(), v.check(validImageSize, 'Use auto or valid WIDTHxHEIGHT dimensions.'))),
  quality: v.optional(v.picklist(IMAGE_QUALITIES)),
  background: v.optional(v.picklist(IMAGE_BACKGROUNDS)),
};

const IMAGE_EDIT_INPUT = v.object({
  ...OUTPUT_FIELDS,
  prompt: PROMPT_FIELD,
  filename: FILENAME_FIELD,
  count: COUNT_FIELD,
  inputs: v.optional(
    v.pipe(
      v.array(v.pipe(v.string(), v.check((value) => IMAGE_HANDLE.test(value) || SAVED_IMAGE_ID.test(value)))),
      v.maxLength(MAX_IMAGE_TOOL_INPUTS),
    ),
  ),
});

type ImageToolData = v.InferOutput<typeof IMAGE_EDIT_INPUT>;

function imageToolDescription(acceptsImageInput: boolean, maxOutputsPerCall: number, supportsOutputControls: boolean): string {
  return [
    'Generate an image and attach it to your final reply in the bound Slack destination.',
    supportsOutputControls
      ? 'Write the whole prompt from the conversation. Choose size, quality and background from the user request; defaults are auto. Use 1024x1024 for square, 1536x1024 for landscape, 1024x1536 for portrait, low quality for a quick draft, and background transparent for a cutout or transparent logo. Custom WIDTHxHEIGHT dimensions must be multiples of 16, no edge above 3840, aspect ratio from 1:3 to 3:1, and 655360 to 8294400 pixels. Explain unsupported exact dimensions instead of silently rounding. The workspace owns the model and transport format.'
      : 'Write the whole prompt from the conversation. ChatGPT chooses the output dimensions, quality and background. Describe composition and appearance preferences in the prompt, but explain that exact dimensions and transparency cannot be guaranteed with this service. The result reports actual dimensions, format and transparency.',
    acceptsImageInput
      ? `To edit or combine images already in this conversation, list their img:N handles in inputs (at most ${MAX_IMAGE_TOOL_INPUTS}); with no inputs the model generates from the prompt alone.`
      : 'This model generates from the prompt alone and cannot take an existing image as input.',
    `At most ${MAX_IMAGES_PER_RESPONSE} images per reply across every call. ` + (maxOutputsPerCall === 1
      ? 'This model generates one image per call. For multiple images, make separate calls with a prompt for each image; omit count or set it to 1.'
      : `For variations of one prompt, make one call with count (1-${maxOutputsPerCall}); for different subjects, make separate calls with their own prompts.`) + ' Each image attaches as its own file, and the result lists a call\'s files under files.',
    ...(maxOutputsPerCall > 1 ? ['With count above 1, the provider renders count separate images from the prompt, so write the prompt as one single image: never say "variations", "versions", "options", or a number of images in the prompt, or each rendered image becomes a collage of several.'] : []),
    supportsOutputControls ? 'The result reports the model and settings the provider applied.'
      : 'A ChatGPT Image result identifies the subscription service, not an exact underlying image model. Inspect the returned facts and disclose any mismatch with the user request instead of claiming preferences were applied.',
    'If the result reports attached: false, explain the returned reason and never say an image was attached or edited. A result may attach some variations and list the rest under unattached; say how many attached and why the others did not.',
  ].join(' ');
}

/**
 * Retain generated bytes before checkpointing; completed generation, inspection,
 * preparation and staging steps replay their metadata without repeating work.
 */
export function createImageArtifactTool(options: ImageArtifactToolOptions) {
  const maxOutputsPerCall = options.maxOutputsPerCall ?? MAX_IMAGE_TOOL_OUTPUTS;
  if (!Number.isInteger(maxOutputsPerCall) || maxOutputsPerCall < 1 || maxOutputsPerCall > MAX_IMAGE_TOOL_OUTPUTS) {
    throw new Error('Invalid image output limit.');
  }
  const supportsOutputControls = options.supportsOutputControls !== false;
  const input = v.object({
    ...(supportsOutputControls ? OUTPUT_FIELDS : {}),
    prompt: PROMPT_FIELD,
    filename: FILENAME_FIELD,
    ...(options.acceptsImageInput ? { inputs: IMAGE_EDIT_INPUT.entries.inputs } : {}),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maxOutputsPerCall))),
  });
  return defineTool({
    name: GENERATE_IMAGE_TOOL_NAME,
    description: imageToolDescription(options.acceptsImageInput, maxOutputsPerCall, supportsOutputControls),
    input: input as typeof IMAGE_EDIT_INPUT,
    durable: true,
    async run({ data, toolCallId, step, signal }) {
      assertArtifactDeliveryAllowed();
      const count = data.count ?? 1;
      const reservation = options.reserveImageCall(toolCallId, count);
      if (!reservation.ok) {
        return imageToolOutput({ attached: false, reason: 'limit', remaining: reservation.remaining });
      }
      let generatedImages: Uint8Array[] | undefined;
      let referenceImages: ImageInput[] | undefined;
      const background = data.background ?? 'auto';
      const retain = async (bytes: Uint8Array, metadata: Record<string, unknown>) => {
        try { return await options.outputStore?.save(bytes, metadata); } catch { return undefined; }
      };
      const readRetained = async (id: string | undefined) => {
        try { return id ? (await options.outputStore?.read(id))?.bytes : undefined; } catch { return undefined; }
      };
      const generated = await step.do('generate', async (): Promise<ImageGenerationStep> => {
        const transport = await options.resolveTransport();
        const format = imageFormatPolicyForTransport(transport.maxBytes, data.prompt, data.background);
        const inputs = await resolveImageInputs(options, data, signal);
        if ('failure' in inputs) return { ok: false, failure: inputs.failure };
        referenceImages = inputs.images;
        const resolved = await options.resolveClient();
        if (!resolved.ok) return { ok: false, failure: { attached: false, reason: 'misconfigured' } };
        const request = {
          prompt: data.prompt,
          size: data.size ?? 'auto',
          quality: data.quality ?? 'auto',
          format,
          deadlineMs: IMAGE_CALL_DEADLINE_MS,
          count,
          ...(signal ? { signal } : {}),
        };
        const result = inputs.images.length > 0
          ? await resolved.client.edit({ ...request, inputs: inputs.images })
          : await resolved.client.generate(request);
        if (!result.ok) {
          return { ok: false, failure: providerFailure(result) };
        }
        // Persist the paid-for bytes before checkpointing generation. Durable
        // steps keep only opaque, destination-bound references and metadata.
        const outputs: ImageGeneratedOutput[] = [];
        for (const image of result.images) {
          const saved = await retain(image, {
            format: result.appliedFormat, model: result.appliedModel,
            size: data.size ?? 'auto', background: format.background ?? 'auto',
          });
          outputs.push({ byteLength: image.byteLength,
            ...(saved ? { savedImage: saved.id, expiresAt: saved.expiresAt } : {}) });
        }
        generatedImages = result.images;
        return {
          ok: true,
          pipelineVersion: 1,
          byteLength: outputs[0]!.byteLength,
          outputs,
          maxBytes: transport.maxBytes,
          appliedModel: result.appliedModel,
          appliedSize: result.appliedSize,
          appliedFormat: result.appliedFormat,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      });
      if (!generated.ok) {
        // Nothing was spent yet, so a corrective retry in this response should
        // not meet `limit`. Provider-side outcomes keep the images reserved.
        if (isPreProviderFailure(generated.failure)) {
          options.reserveImageCall.release?.(toolCallId);
        }
        return imageToolOutput(generated.failure);
      }

      const outputs = generated.outputs ?? [{ byteLength: generated.byteLength }];
      const filenames = imageFilenames(data.filename, generated.appliedFormat, outputs.length);
      const files: ImageArtifactFile[] = [];
      const unattached: ImageArtifactUnattachedFile[] = [];
      let firstFailure: Extract<ImageArtifactResult, { attached: false }> | undefined;
      let correctionUsed = false;
      const supersededImages = new Set<string>();
      for (const [index, output] of outputs.entries()) {
        let filename = filenames[index]!;
        // Old checkpoints have no retained reference or preparation step. A
        // completed upload remains successful across this upgrade.
        if (!generated.pipelineVersion && !output.savedImage && !generatedImages?.[index]) {
          const legacy = await step.do(stagingStepName(index), async (): Promise<ImageStagingStep> => ({
            ok: false, failure: { attached: false, reason: 'unavailable', source: 'staging', detail: 'bytes_unavailable' },
          }));
          if (legacy.ok) files.push({ filename, byteLength: legacy.byteLength });
          else { firstFailure ??= legacy.failure; if (isUnattachedFileFailure(legacy.failure)) unattached.push({ filename, ...legacy.failure }); }
          continue;
        }
        if (output.tooLarge) {
          const maxBytes = generated.maxBytes ?? (await options.resolveTransport()).maxBytes;
          const failure = { attached: false, reason: 'too-large', maxBytes } as const;
          unattached.push({ filename, ...failure });
          firstFailure ??= failure;
          continue;
        }
        const maxBytes = generated.maxBytes ?? (await options.resolveTransport()).maxBytes;
        let currentBytes = generatedImages?.[index];
        const baseMetadata = { model: generated.appliedModel, size: data.size ?? 'auto', background };
        const prepareOutput = async (name: string, source: () => Promise<Uint8Array | undefined>) => step.do(name, async () => {
          const bytes = await source();
          if (!bytes) return { ok: false as const, detail: 'bytes_unavailable' };
          let image: PreparedImage;
          try { image = (options.prepareOutput ?? prepareImageOutput)(bytes, maxBytes, data.size !== undefined && data.size !== 'auto'); }
          catch { return { ok: false as const, detail: 'invalid_image' }; }
          const { bytes: preparedBytes, ...facts } = image;
          currentBytes = preparedBytes;
          const saved = await retain(preparedBytes, { ...baseMetadata, ...facts });
          return { ok: true as const, ...facts, byteLength: preparedBytes.length,
            savedImage: saved?.id, expiresAt: saved?.expiresAt };
        });
        let prepared = await prepareOutput(`prepare:${index + 1}`, async () => currentBytes ?? await readRetained(output.savedImage));
        const originalPrepared = prepared;
        let inspection: ImageInspection = { status: 'unavailable', observations: 'Visual inspection is unavailable.' };
        let originalInspection = inspection;
        let corrected = false;
        let correctionAttempted = false;
        let correctionSavedImage: string | undefined;
        if (prepared.ok) {
          const inspect = async (): Promise<ImageInspection> => {
            if (!options.inspectOutput) return inspection;
            if (!referenceImages) {
              const resolved = await resolveImageInputs(options, data, signal);
              if ('failure' in resolved) return { status: 'unavailable', observations: 'The original references could not be retrieved for visual comparison.' };
              referenceImages = resolved.images;
            }
            const bytes = currentBytes ?? (prepared.ok ? await readRetained(prepared.savedImage) : undefined);
            if (!bytes || !prepared.ok) return { status: 'unavailable', observations: 'The generated image could not be retrieved for visual inspection.' };
            return options.inspectOutput({ prompt: data.prompt, image: { bytes, mimeType: `image/${prepared.format}` },
              references: referenceImages, ...(signal ? { signal } : {}) });
          };
          inspection = await step.do(`inspect:${index + 1}`, inspect);
          originalInspection = inspection;
          // Reserve this decision in a sibling checkpoint. Replays keep one
          // correction across the batch even if an earlier variation is cached.
          const decision = await step.do(`correction-choice:${index + 1}`, () => ({
            attempt: options.acceptsImageInput && !correctionUsed && (data.inputs?.length ?? 0) < MAX_IMAGE_TOOL_INPUTS &&
              (inspection.verdict === 'needs_changes' || (prepared.ok && backgroundMismatch(background, prepared.transparent))) &&
              options.reserveImageCall(`${toolCallId}:correction`, 1).ok,
          }));
          correctionAttempted = decision.attempt;
          correctionUsed ||= decision.attempt;
          if (decision.attempt) {
            let correctionBytes: Uint8Array | undefined;
            const correction = await step.do(`correct:${index + 1}`, async () => {
              const client = await options.resolveClient();
              const originalBytes = generatedImages?.[index] ?? await readRetained(output.savedImage);
              const bytes = originalBytes ?? currentBytes ?? (prepared.ok ? await readRetained(prepared.savedImage) : undefined);
              if (!client.ok || !bytes || !prepared.ok) {
                options.reserveImageCall.release?.(`${toolCallId}:correction`);
                return { ok: false as const };
              }
              if (!referenceImages) {
                const references = await resolveImageInputs(options, data, signal);
                if ('failure' in references) { options.reserveImageCall.release?.(`${toolCallId}:correction`); return { ok: false as const }; }
                referenceImages = references.images;
              }
              const result = await client.client.edit({
                prompt: `Preserve all correct regions. Fix only these problems: ${inspection.observations.slice(0, 1000)}. Required size: ${data.size ?? 'auto'}; background: ${background}. Original request: ${data.prompt}`.slice(0, MAX_IMAGE_PROMPT_CHARS),
                size: data.size ?? 'auto', quality: data.quality ?? 'auto', count: 1,
                format: imageFormatPolicyForTransport(maxBytes, data.prompt, data.background),
                inputs: [{ bytes, mimeType: `image/${originalBytes ? generated.appliedFormat : prepared.format}` }, ...referenceImages],
                deadlineMs: IMAGE_CALL_DEADLINE_MS, ...(signal ? { signal } : {}),
              });
              // Ambiguous provider failures keep the reservation: they may
              // already have incurred spend. Only pre-provider failures release.
              if (!result.ok || !result.images[0]) return { ok: false as const };
              correctionBytes = result.images[0];
              const saved = await retain(correctionBytes, { ...baseMetadata, format: result.appliedFormat });
              return { ok: true as const, savedImage: saved?.id };
            });
            if (correction.ok) {
              correctionSavedImage = correction.savedImage;
              const correctedOutput = await prepareOutput(`prepare-correction:${index + 1}`, async () => correctionBytes ?? await readRetained(correction.savedImage));
              // A failed or unavailable correction must not discard the valid
              // original, including a replay whose correction was not retained.
              if (correctedOutput.ok) {
                prepared = correctedOutput;
                corrected = true;
                inspection = await step.do(`inspect-correction:${index + 1}`, inspect);
              }
            }
          }
        }
        const finalized = await step.do(`finalize:${index + 1}`, async () => {
          if (!prepared.ok) return prepared;
          const bytes = currentBytes ?? await readRetained(prepared.savedImage);
          const { width, height, format, transparent, compressed, resized } = prepared;
          const saved = bytes ? await retain(bytes, { ...baseMetadata, width, height, format, transparent, compressed, resized, inspection }) : undefined;
          return { ...prepared, savedImage: saved?.id ?? prepared.savedImage, expiresAt: saved?.expiresAt ?? prepared.expiresAt,
            inspection, corrected, correctionAttempted,
            mismatch: Boolean((data.size && data.size !== 'auto' && data.size !== `${prepared.width}x${prepared.height}`) ||
              backgroundMismatch(background, prepared.transparent)) };
        });
        // Keep live bytes available even when retention failed. Recovery after
        // interruption can only promise bytes for a returned savedImage handle.
        generatedImages ??= [];
        if (currentBytes) generatedImages[index] = currentBytes;
        if (!finalized.ok) {
          const failure = { attached: false, reason: 'unavailable', source: 'staging', detail: finalized.detail,
            ...(output.savedImage ? { savedImage: output.savedImage, expiresAt: output.expiresAt } : {}) } as const;
          unattached.push({ filename, ...failure }); firstFailure ??= failure; continue;
        }
        correctionUsed ||= finalized.correctionAttempted;
        if (finalized.savedImage) {
          for (const id of [output.savedImage, correctionSavedImage]) {
            if (id && id !== finalized.savedImage) supersededImages.add(id);
          }
        }
        filename = imageFilename(filename.replace(/\.[^.]+$/, ''), finalized.format);
        if (finalized.mismatch) {
          const failure = { attached: false, reason: 'unavailable', source: 'staging', detail: 'output_requirements_not_met',
            savedImage: finalized.savedImage, expiresAt: finalized.expiresAt } as const;
          unattached.push({ filename, ...failure }); firstFailure ??= failure; continue;
        }
        if (finalized.byteLength > (generated.maxBytes ?? MAX_ARTIFACT_BYTES)) {
          const failure = { attached: false, reason: 'too-large', maxBytes: generated.maxBytes ?? MAX_ARTIFACT_BYTES,
            savedImage: finalized.savedImage, expiresAt: finalized.expiresAt } as const;
          unattached.push({ filename, ...failure }); firstFailure ??= failure; continue;
        }
        // The mapped outcome is what the step records, so a replay reports the
        // same source and detail the first execution actually met. The first
        // variation keeps the step name a single-image record already used.
        const staged = await step.do(stagingStepName(index), async (): Promise<ImageStagingStep> => {
          // A replay can load retained bytes when staging was not checkpointed.
          let bytes = finalized.savedImage
            ? generatedImages?.[index] ?? await readRetained(finalized.savedImage)
            : generatedImages?.[index];
          let delivery = { ...finalized, filename };
          // A corrected image may have been deliverable live but not retained.
          // Select the retained original inside the staging checkpoint so a
          // replay after either preparation or finalization reports the actual
          // uploaded image and its original inspection, never corrected facts.
          if (!bytes && finalized.corrected && originalPrepared.ok && originalPrepared.savedImage &&
              originalPrepared.byteLength <= maxBytes &&
              (!data.size || data.size === 'auto' || data.size === `${originalPrepared.width}x${originalPrepared.height}`) &&
              !backgroundMismatch(background, originalPrepared.transparent)) {
            bytes = await readRetained(originalPrepared.savedImage);
            if (bytes) delivery = { ...finalized, ...originalPrepared, corrected: false, inspection: originalInspection,
              filename: imageFilename(filename.replace(/\.[^.]+$/, ''), originalPrepared.format) };
          }
          if (!bytes) {
            return {
              ok: false,
              failure: {
                attached: false, reason: 'unavailable', source: 'staging', detail: 'bytes_unavailable',
              },
            };
          }
          const outcome = await options.stageArtifact({ bytes, filename: delivery.filename, kind: 'image' });
          return outcome.attached
            ? { ok: true, byteLength: outcome.byteLength, file: {
              filename: delivery.filename, byteLength: delivery.byteLength, format: delivery.format,
              width: delivery.width, height: delivery.height, transparent: delivery.transparent,
              savedImage: delivery.savedImage, expiresAt: delivery.expiresAt, inspection: delivery.inspection,
              corrected: delivery.corrected, compressed: delivery.compressed, resized: delivery.resized,
            } }
            : { ok: false, failure: stagingFailure(outcome), savedImage: delivery.savedImage, expiresAt: delivery.expiresAt };
        });
        if (staged.ok) {
          files.push(staged.file ?? { filename, byteLength: finalized.byteLength, format: finalized.format,
            width: finalized.width, height: finalized.height, transparent: finalized.transparent,
            savedImage: finalized.savedImage, expiresAt: finalized.expiresAt,
            inspection: finalized.inspection, corrected: finalized.corrected,
            compressed: finalized.compressed, resized: finalized.resized });
        } else {
          const failure = { ...staged.failure, savedImage: staged.savedImage ?? finalized.savedImage, expiresAt: staged.expiresAt ?? finalized.expiresAt };
          firstFailure ??= failure;
          if (isUnattachedFileFailure(staged.failure)) unattached.push({ filename, ...staged.failure,
            savedImage: failure.savedImage, expiresAt: failure.expiresAt });
        }
      }
      const activeImages = new Set([...files, ...unattached].map((file) => file.savedImage));
      for (const id of supersededImages) {
        if (!activeImages.has(id)) {
          try { await options.outputStore?.remove(id); } catch { /* TTL maintenance remains the fallback. */ }
        }
      }
      if (files.length === 0) return imageToolOutput(firstFailure!);
      return imageToolOutput({
        attached: true,
        filename: files[0]!.filename,
        byteLength: files[0]!.byteLength,
        appliedModel: generated.appliedModel,
        appliedSize: files[0]?.width ? `${files[0].width}x${files[0].height}` : generated.appliedSize,
        appliedFormat: files[0]?.format ?? generated.appliedFormat,
        requestedQuality: data.quality ?? 'auto',
        requestedBackground: background,
        ...(generated.usage ? { usage: generated.usage } : {}),
        files,
        ...(unattached.length > 0 ? { unattached } : {}),
      });
    },
  });
}

/** The first variation keeps the `stage` name earlier records used; the rest are numbered. */
function stagingStepName(index: number): string {
  return index === 0 ? 'stage' : `stage:${index + 1}`;
}

/** Staging outcomes that describe one file rather than the whole call. */
function isUnattachedFileFailure(
  failure: Extract<ImageArtifactResult, { attached: false }>,
): failure is ImageUnattachedFailure {
  return failure.reason === 'missing-scope' || failure.reason === 'too-large' ||
    failure.reason === 'unavailable';
}

/**
 * The result the model sees. Every field is host-shaped — the client already
 * projected the provider's usage onto known numeric fields — so the JSON
 * contract is asserted here rather than re-validated field by field.
 */
function imageToolOutput(result: ImageArtifactResult): { output: JsonValue } {
  return { output: result as unknown as JsonValue };
}

async function resolveImageInputs(
  options: ImageArtifactToolOptions,
  data: Pick<ImageToolData, 'inputs'>,
  signal: AbortSignal | undefined,
): Promise<{ images: ImageInput[] } | { failure: Extract<ImageArtifactResult, { attached: false }> }> {
  const handles = options.acceptsImageInput ? data.inputs ?? [] : [];
  if (handles.length === 0) return { images: [] };
  const reader = await options.createImageReader({
    // The transport cap bounds the image this call sends back to Slack, not
    // the inputs it reads: the same gateway reads attachments to the Slack cap.
    perFileLimitBytes: DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES,
    totalLimitBytes: MAX_ARTIFACT_BYTES,
    ...(signal ? { signal } : {}),
  });
  const images: ImageInput[] = [];
  let totalBytes = 0;
  for (const handle of handles) {
    if (SAVED_IMAGE_ID.test(handle)) {
      const saved = await options.outputStore?.read(handle).catch(() => undefined);
      if (!saved) return { failure: inputUnavailable(handle, 'not_found') };
      const format = saved.metadata.format;
      if (format !== 'png' && format !== 'jpeg' && format !== 'webp') return { failure: inputUnavailable(handle, 'unsupported_type') };
      totalBytes += saved.bytes.length;
      if (saved.bytes.length > DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES || totalBytes > MAX_ARTIFACT_BYTES) {
        return { failure: inputUnavailable(handle, 'too_large') };
      }
      images.push({ bytes: saved.bytes, mimeType: `image/${format}` });
      continue;
    }
    const resolution = options.inventory.resolveHandle(handle);
    if (!resolution.ok) return { failure: inputUnavailable(handle, resolution.detail) };
    const read = await reader.read(resolution.record);
    if (!read.ok) return { failure: inputUnavailable(handle, read.detail) };
    if (!PROVIDER_INPUT_MIME_TYPES.has(read.mimeType)) {
      return { failure: inputUnavailable(handle, 'unsupported_type') };
    }
    totalBytes += read.bytes.length;
    if (totalBytes > MAX_ARTIFACT_BYTES) return { failure: inputUnavailable(handle, 'too_large') };
    images.push({ bytes: read.bytes, mimeType: read.mimeType });
  }
  return { images };
}

/** Explicit upload recovery never resolves a provider or spends the image quota. */
export function createRecoverImageTool(options: ImageArtifactToolOptions) {
  return defineTool({
    name: 'recover_image',
    description: 'Reattach an existing image without generating or paying for another image. For an image already visible in Slack, prefer its matching img:N handle: this shares the original Slack file exactly, without downloading and reuploading it for delivery. An optional filename is only the link label; the original download filename stays unchanged. Explain this distinction when a different filename was requested. Use a savedImage handle from generate_image for a failed upload; this retries an upload, whose downloaded bytes may be changed by Slack. Saved images expire after 24 hours and may be evicted earlier by the bounded cache; conversation images depend on Slack access. Never call generate_image just to retry delivery. Optional allowResize applies only to saved-image uploads and permits a smaller delivery when compression alone cannot fit; get this preference from the user request.',
    input: v.object({
      image: v.pipe(v.string(), v.check((value) => IMAGE_HANDLE.test(value) || SAVED_IMAGE_ID.test(value))),
      filename: FILENAME_FIELD,
      allowResize: v.optional(v.boolean()),
    }),
    durable: true,
    async run({ data, step, signal }) {
      assertArtifactDeliveryAllowed();
      return { output: await step.do('recover', async () => {
        let saved: { bytes: Uint8Array; metadata: Record<string, unknown>; expiresAt?: number } | undefined;
        const retained = SAVED_IMAGE_ID.test(data.image);
        if (retained) {
          saved = await options.outputStore?.read(data.image).catch(() => undefined);
        } else {
          const resolved = options.inventory.resolveHandle(data.image);
          if (!resolved.ok) return inputUnavailable(data.image, resolved.detail) as unknown as JsonValue;
          if (!resolved.record.permalink || !options.reuseImage) {
            return { attached: false, reason: 'original_file_unavailable', sourceImage: data.image };
          }
          // Verify current access through the authenticated, bounded reader,
          // then share the original id. Do not decode, compress, or re-upload.
          const reader = await options.createImageReader({ perFileLimitBytes: DEFAULT_THREAD_IMAGE_FILE_LIMIT_BYTES,
            totalLimitBytes: MAX_ARTIFACT_BYTES, ...(signal ? { signal } : {}) });
          const read = await reader.read(resolved.record);
          if (!read.ok) return inputUnavailable(data.image, read.detail) as unknown as JsonValue;
          const extension = resolved.record.mimeType === 'image/jpeg' ? 'jpg' : resolved.record.mimeType.slice('image/'.length);
          const filename = data.filename ? artifactFilename(data.filename, DEFAULT_IMAGE_BASENAME, extension) : resolved.record.filename;
          const outcome = await options.reuseImage({ record: resolved.record, filename, byteLength: read.bytes.length });
          return { ...outcome, sourceImage: data.image, filename, originalFilename: resolved.record.filename,
            reusedExistingFile: true, renamed: false, compressed: false, resized: false };
        }
        if (!saved) return { attached: false, reason: 'expired_or_unavailable' };
        const source: Record<string, JsonValue> = retained
          ? { savedImage: data.image, ...(saved.expiresAt === undefined ? {} : { expiresAt: saved.expiresAt }) }
          : { sourceImage: data.image };
        const { maxBytes } = await options.resolveTransport();
        let image: PreparedImage;
        try {
          // Prepared metadata came from decoded pixels on these immutable bytes.
          // A fitting resend does not need another full decode/alpha scan.
          const facts = retainedImageFacts(saved.metadata);
          image = saved.bytes.length <= maxBytes && facts
            ? { ...facts, bytes: saved.bytes, compressed: false, resized: false }
            : (options.prepareOutput ?? prepareImageOutput)(saved.bytes, maxBytes, !data.allowResize);
        }
        catch { return { attached: false, reason: 'invalid_image', ...source }; }
        if ((!data.allowResize && saved.metadata.size && saved.metadata.size !== 'auto' && saved.metadata.size !== `${image.width}x${image.height}`) ||
            backgroundMismatch(saved.metadata.background, image.transparent)) {
          return { attached: false, reason: 'output_requirements_not_met', ...source };
        }
        const filename = imageFilename(data.filename, image.format);
        if (image.bytes.length > maxBytes) return { attached: false, reason: 'too-large', maxBytes, ...source };
        const outcome = await options.stageArtifact({ bytes: image.bytes, filename, kind: 'image' });
        return { ...outcome, filename, ...source,
          width: image.width, height: image.height, transparent: image.transparent, format: image.format,
          ...(saved.metadata.inspection ? { inspection: saved.metadata.inspection as unknown as JsonValue } : {}),
          compressed: image.compressed, resized: image.resized };
      }) };
    },
  });
}

function backgroundMismatch(background: unknown, transparent: boolean): boolean {
  return (background === 'transparent' && !transparent) || (background === 'opaque' && transparent);
}

function retainedImageFacts(metadata: Record<string, unknown>): ImageFacts | undefined {
  const { width, height, transparent, format } = metadata;
  if (typeof width !== 'number' || !Number.isInteger(width) || width < 1 || width > 3840 ||
      typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > 3840 ||
      typeof transparent !== 'boolean' || !['png', 'jpeg', 'webp'].includes(String(format))) return undefined;
  return { width, height, transparent, format: format as ImageOutputFormat };
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
export function imageFormatPolicyForTransport(maxBytes: number, prompt: string, background?: ImageBackground): ImageFormatPolicy {
  const resolvedBackground = background ?? 'auto';
  if (maxBytes >= MAX_ARTIFACT_BYTES) return { format: 'png', background: resolvedBackground };
  return {
    format: resolvedBackground === 'transparent' || (background === undefined && wantsTransparentBackground(prompt)) ? 'webp' : 'jpeg',
    background: resolvedBackground,
    compression: compressionForCap(maxBytes),
  };
}

/** Fallback for callers that omit the explicit background field. */
function wantsTransparentBackground(prompt: string): boolean {
  return /\btransparen(?:t|cy)\b/i.test(prompt);
}

function compressionForCap(maxBytes: number): number {
  if (maxBytes >= 4 * 1024 * 1024) return 90;
  if (maxBytes >= 1024 * 1024) return 80;
  return 60;
}

/**
 * Client failures the tool reports. Nothing carries prompt text; an
 * `unavailable` result names the provider as its source and carries the
 * client's bounded detail code, so an unreachable provider and a file that
 * would not attach stop reading identically to the Agent.
 */
function providerFailure(
  result: Extract<ImageCallResult, { ok: false }>,
): Extract<ImageArtifactResult, { attached: false }> {
  const reason = providerFailureReason(result.reason);
  return reason === 'unavailable'
    ? {
        attached: false,
        reason: 'unavailable',
        source: 'provider',
        detail: providerDetail(result.detail),
      }
    : { attached: false, reason };
}

function providerFailureReason(
  reason: ImageCallFailureReason,
): 'rejected' | 'misconfigured' | 'timeout' | 'unavailable' {
  if (reason === 'rejected' || reason === 'misconfigured' || reason === 'timeout') return reason;
  // A transport failure and a request this build should never have sent are
  // both "no image, try later"; neither is the content's fault.
  return 'unavailable';
}

/** The client already bounds its codes; an empty one still needs a name. */
function providerDetail(detail: string): ImageUnavailableDetail {
  const trimmed = detail.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_IMAGE_DETAIL_CHARS ? trimmed : 'unknown';
}

/**
 * A staging outcome as the image tool reports it: `unavailable` gains the
 * staging source and the host-authored category.
 */
function stagingFailure(
  outcome: Extract<SlackArtifactStageOutcome, { attached: false }>,
): Extract<ImageArtifactResult, { attached: false }> {
  if (outcome.reason !== 'unavailable') return outcome;
  return {
    attached: false,
    reason: 'unavailable',
    source: 'staging',
    detail: outcome.detail ?? 'unknown',
  };
}

/** Failures raised before the provider ran: no image was paid for. */
function isPreProviderFailure(
  failure: Extract<ImageArtifactResult, { attached: false }>,
): boolean {
  return failure.reason === 'input-unavailable' || failure.reason === 'misconfigured';
}

/** Keep the Slack-visible filename a safe basename matching the applied format. */
export function imageFilename(
  requested: string | undefined,
  format: ImageOutputFormat,
): string {
  return artifactFilename(requested, DEFAULT_IMAGE_BASENAME, FORMAT_EXTENSIONS[format]);
}

/**
 * One safe filename per variation. A single image keeps the requested name;
 * variations share its basename with a 1-based suffix (`ad-1.jpg`, `ad-2.jpg`)
 * so the files stay distinguishable in Slack and in the next turn's listing.
 */
export function imageFilenames(
  requested: string | undefined,
  format: ImageOutputFormat,
  count: number,
): string[] {
  const single = imageFilename(requested, format);
  if (count <= 1) return [single];
  const extension = `.${FORMAT_EXTENSIONS[format]}`;
  const suffixLength = `-${count}`.length;
  // Trim separators the sanitizer left at the end and leave room for the
  // suffix, so `weird-name-` becomes `weird-name-1` and a basename at the
  // length cap still yields distinct names.
  const base = single
    .slice(0, single.length - extension.length)
    .slice(0, MAX_ARTIFACT_FILENAME_CHARS - suffixLength)
    .replace(/[-.]+$/, '');
  return Array.from({ length: count }, (_, index) => (
    imageFilename(`${base || DEFAULT_IMAGE_BASENAME}-${index + 1}`, format)
  ));
}

/**
 * The quota state. Version 1 recorded the single call that owned the
 * response's one image; a response interrupted on that build resumes here
 * with that call holding one image.
 */
type ImageCallBudgetState =
  | { schemaVersion: 1; toolCallId: string | null }
  | { schemaVersion: 2; reservations: Record<string, number> };

const EMPTY_BUDGET: ImageCallBudgetState = { schemaVersion: 2, reservations: {} };

function budgetReservations(state: ImageCallBudgetState | undefined): Record<string, number> {
  if (!state) return {};
  if (state.schemaVersion === 2) return { ...state.reservations };
  return state.toolCallId === null ? {} : { [state.toolCallId]: 1 };
}

function reservedTotal(reservations: Record<string, number>): number {
  return Object.values(reservations).reduce((sum, count) => sum + count, 0);
}

/**
 * Root-Agent hook: a quota of `MAX_IMAGES_PER_RESPONSE` images per response.
 * Reservations are keyed by tool call id, so a durable replay of the same
 * call keeps the images it already reserved, and another call is refused
 * once the quota would be exceeded.
 */
export function useImageCallBudget(): ImageCallReservation {
  const [, update] = usePersistentState<ImageCallBudgetState>(
    SLACK_IMAGE_CALL_BUDGET_NAME,
    EMPTY_BUDGET,
  );
  useResponseStart(() => { update(EMPTY_BUDGET); });
  const reserve = (toolCallId: string, count: number): ImageReservationOutcome => {
    let outcome: ImageReservationOutcome = { ok: false, remaining: 0 };
    update((previous) => {
      const reservations = budgetReservations(previous);
      const owned = reservations[toolCallId];
      if (owned !== undefined) {
        // A replay keeps what it reserved, whatever the quota looks like now.
        outcome = { ok: true, remaining: MAX_IMAGES_PER_RESPONSE - reservedTotal(reservations) };
        return { schemaVersion: 2, reservations };
      }
      const remaining = MAX_IMAGES_PER_RESPONSE - reservedTotal(reservations);
      if (count < 1 || count > remaining) {
        outcome = { ok: false, remaining };
        return { schemaVersion: 2, reservations };
      }
      reservations[toolCallId] = count;
      outcome = { ok: true, remaining: remaining - count };
      return { schemaVersion: 2, reservations };
    });
    return outcome;
  };
  return Object.assign(reserve, {
    // Only the owner's images are handed back, so a refused call cannot free
    // what another call is still using.
    release(toolCallId: string) {
      update((previous) => {
        const reservations = budgetReservations(previous);
        delete reservations[toolCallId];
        return { schemaVersion: 2, reservations };
      });
    },
  });
}
