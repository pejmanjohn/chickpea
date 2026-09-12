import {
  createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool,
  createWriteTool, defineTool, useAgentFinish, useDataWriter, useDelivery,
  usePersistentState, useResponseStart,
  type SandboxFactory, type SessionEnv, type StateSetter,
} from '@flue/runtime';
import * as v from 'valibot';
import { bindFileDeliveryCheck } from './presentation-tool-policy.ts';
import { validateArtifactPresentation } from './artifact-staging.ts';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { assertArtifactDeliveryAllowed, currentRequestEnvelopeText } from '../memory/tool-policy.ts';
import {
  ArtifactSizeError, MAX_ARTIFACT_BYTES, readSandboxArtifact, sandboxArtifactPath, workspaceArtifactPath,
  type ArtifactDestinationBinding, type ArtifactToolResult,
} from '../sandbox/artifact-tool.ts';

export const COMPLETE_FILE_DELIVERY_TOOL = 'complete_file_delivery';
export const FILE_DELIVERY_DATA_NAME = 'fileDeliveryCompletion';
export const FILE_DELIVERY_SIGNAL_TYPE = 'slack.file_delivery_check';
export const FILE_DELIVERY_SIGNAL_TAG = 'slack_file_delivery_check';
const MAX_TRACKED_FILES = 64;

const FileOutcomeSchema = v.strictObject({
  path: v.string(), filename: v.string(), digest: v.optional(v.string()),
  attached: v.boolean(), reason: v.optional(v.string()),
  byteLength: v.optional(v.number()), inline: v.optional(v.string()), fileId: v.optional(v.string()),
  maxBytes: v.optional(v.number()),
});
type FileOutcome = v.InferOutput<typeof FileOutcomeSchema>;
const CompletionStateSchema = v.strictObject({
  pending: v.array(v.string()), shellPending: v.boolean(), generation: v.number(),
  outcomes: v.array(FileOutcomeSchema), repairRequested: v.boolean(), stagingAttempted: v.boolean(),
});
export type FileDeliveryState = v.InferOutput<typeof CompletionStateSchema>;
export const FileDeliveryResultSchema = v.strictObject({
  unresolved: v.boolean(), files: v.array(FileOutcomeSchema),
});
const initialState = (): FileDeliveryState => ({ pending: [], shellPending: false, generation: 0, outcomes: [], repairRequested: false, stagingAttempted: false });
const FileInputSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
});
export type FileDeliveryInput = v.InferOutput<typeof FileInputSchema>;

export const FILE_COMPLETION_INSTRUCTION = [
  'After shell work, call complete_file_delivery before your final answer or submit_routine_result. List all final sandbox files, including revised files and files already passed to post_artifact; it attaches missing files and reuses prepared files. An empty files list confirms no additional deliverables and preserves files already prepared. Keep scratch files, intermediate scripts and working repository files private unless the user requests them as final deliverables.',
  'For a file written directly with write/edit, post_artifact accounts for that file. If other written files are scratch, complete_file_delivery confirms the final selection. Do all file work before completing delivery. Never declare stream_answer or present_table while file delivery is unchecked. Respect text-only or no-attachment requests. Use excludedPaths only to withdraw files previously prepared that the user no longer wants or that have become intermediate; omission alone never removes an attachment.',
  'A file-delivery check is internal continuation of the same request, not a new task. Complete only the omitted export, preserve already prepared files, and never repeat unrelated actions. Report individual attachment failures honestly.',
].join('\n');

/** Durable bookkeeping lives beside upload receipts; it never scans or publishes the filesystem. */
export function createFileDeliveryCompletion(update: StateSetter<FileDeliveryState>, discard: (fileIds: string[]) => void = () => {}, repairing = false) {
  // Runtime tools execute serially, but protect overlapping calls as well.
  let deliveryTail = Promise.resolve();
  // An in-flight counter must not survive an interrupted process. Durable
  // pending paths/generation retain its unfinished work across replay.
  let activeWrites = 0;
  function state(): FileDeliveryState {
    let current = initialState();
    update((previous) => { current = v.parse(CompletionStateSchema, previous); return previous; });
    return current;
  }
  function mark(path?: string) {
    update((previous) => ({ ...previous, generation: previous.generation + 1,
      shellPending: previous.shellPending || path === undefined || previous.pending.length >= MAX_TRACKED_FILES,
      pending: path === undefined ? previous.pending : [...new Set([...previous.pending, path])].slice(0, MAX_TRACKED_FILES),
    }));
  }
  function record(outcome: FileOutcome, generation: number) {
    update((previous) => ({ ...previous,
      pending: previous.generation === generation && activeWrites === 0
        ? previous.pending.filter((path) => path !== outcome.path) : previous.pending,
      outcomes: [...previous.outcomes.filter((known) => known.path !== outcome.path), outcome].slice(-MAX_TRACKED_FILES),
    }));
  }
  function wrapSandbox(sandbox: SandboxFactory): SandboxFactory {
    return {
      createSessionEnv: (options) => sandbox.createSessionEnv(options),
      tools(env, options) {
        const tools = sandbox.tools?.(env, options) ?? [createReadTool(env), createWriteTool(env),
          createEditTool(env), createBashTool(env), createGrepTool(env), createGlobTool(env)];
        return tools.map((tool) => !['write', 'edit', 'bash'].includes(tool.name) ? tool : {
          ...tool,
          async execute(...args: Parameters<typeof tool.execute>) {
            if (state().repairRequested) {
              throw new Error('File delivery repair can only read and export existing files. Call complete_file_delivery; do not recreate files or repeat earlier actions.');
            }
            // Mark before execution: a failing shell can still have written files.
            const data: unknown = args[1];
            const path = tool.name !== 'bash' && typeof data === 'object' && data !== null &&
              'path' in data && typeof data.path === 'string' ? sandboxArtifactPath(env, data.path) : undefined;
            mark(path);
            activeWrites++;
            try { return await tool.execute(...args); }
            finally {
              // The completion of a concurrent write invalidates an in-flight selection.
              activeWrites--;
              update((previous) => ({ ...previous, generation: previous.generation + 1 }));
            }
          },
        });
      },
    };
  }
  function noteStagingAttempted() {
    update((previous) => ({ ...previous, stagingAttempted: true }));
  }
  function removeKnown(path: string) {
    const known = state().outcomes.find((file) => file.path === path);
    if (known?.fileId) discard([known.fileId]);
    update((previous) => ({ ...previous, outcomes: previous.outcomes.filter((file) => file.path !== path) }));
  }
  async function deliverOnce(env: SessionEnv, input: FileDeliveryInput, binding: ArtifactDestinationBinding): Promise<ArtifactToolResult> {
    assertArtifactDeliveryAllowed();
    const generation = state().generation;
    let path = input.path;
    let bytes: Uint8Array;
    let presentation: ReturnType<typeof validateArtifactPresentation>;
    try {
      path = resolveFilePath(env, input.path, binding);
      presentation = validateArtifactPresentation(input);
      bytes = await readSandboxArtifact(env, path, binding.sandboxKind);
    } catch (error) {
      removeKnown(path);
      if (error instanceof ArtifactSizeError) {
        record({ path, filename: input.filename, attached: false, reason: 'too-large', maxBytes: error.maxBytes }, generation);
        return { attached: false, reason: 'too-large', maxBytes: error.maxBytes };
      }
      // No upload happened. Preserve actionable tool errors so the agent can
      // correct a filename/path; final selection will account for unresolved ones.
      update((previous) => ({ ...previous,
        pending: [...new Set([...previous.pending, path])].slice(0, MAX_TRACKED_FILES) }));
      throw error;
    }
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
      (byte) => byte.toString(16).padStart(2, '0')).join('');
    const previous = state().outcomes.find((known) => known.path === path && known.digest === digest &&
      (!known.attached || known.filename === presentation.filename));
    // A known receipt or uncertain upload is terminal for these exact source bytes.
    if (previous) {
      record(previous, generation);
      return previous.attached
        ? { attached: true, filename: previous.filename, byteLength: previous.byteLength! }
        : previous.reason === 'too-large' ? { attached: false, reason: 'too-large', maxBytes: previous.maxBytes ?? MAX_ARTIFACT_BYTES }
          : { attached: false, reason: previous.reason === 'missing-scope' ? 'missing-scope' : 'unavailable' };
    }
    removeKnown(path);
    noteStagingAttempted();
    try {
      const result = await binding.stageArtifact({ bytes, ...presentation, kind: 'file' });
      record({ path, filename: presentation.filename, digest, attached: result.attached,
        ...(result.attached ? { byteLength: result.byteLength, ...(result.fileId ? { fileId: result.fileId } : {}) }
          : { reason: result.reason, ...(result.reason === 'too-large' ? { maxBytes: result.maxBytes } : {}), ...inlineOutcome(bytes) }) }, generation);
      return result.attached ? { attached: true, filename: presentation.filename, byteLength: result.byteLength } : result;
    } catch {
      record({ path, filename: presentation.filename, digest, attached: false,
        reason: 'unavailable', ...inlineOutcome(bytes) }, generation);
      return { attached: false, reason: 'unavailable' };
    }
  }
  function deliver(env: SessionEnv, input: FileDeliveryInput, binding: ArtifactDestinationBinding): Promise<ArtifactToolResult> {
    const task = deliveryTail.then(() => deliverOnce(env, input, binding));
    deliveryTail = task.then(() => {}, () => {});
    return task;
  }
  async function complete(env: SessionEnv, files: FileDeliveryInput[], binding: ArtifactDestinationBinding, excludedPaths: string[] = []) {
    assertArtifactDeliveryAllowed();
    // Validate exclusions before any side effect; absence from files is never removal.
    const excluded = new Set(excludedPaths.map((path) => resolveFilePath(env, path, binding)));
    for (const file of files) {
      let path: string;
      try { path = resolveFilePath(env, file.path, binding); } catch { continue; }
      if (excluded.has(path)) throw new Error('A file cannot be both selected and excluded.');
    }
    const before = state();
    const generation = before.generation;
    const outputs: ArtifactToolResult[] = [];
    const selected = new Set<string>();
    const requested = new Set(files.flatMap((file) => {
      try { return [resolveFilePath(env, file.path, binding)]; } catch { return []; }
    }));
    // Retaining a prepared deliverable means retaining its current contents.
    // Shell work may have changed any prepared path, so re-read without uploading
    // again when the digest is unchanged.
    const retainedRechecks = before.outcomes.filter((file) => file.attached &&
      !requested.has(file.path) && !excluded.has(file.path) &&
      (before.shellPending || before.pending.includes(file.path)))
      .map((file) => ({ path: file.path, filename: file.filename }));
    for (const file of [...files, ...retainedRechecks]) {
      let path = file.path;
      try {
        path = resolveFilePath(env, file.path, binding);
        selected.add(path);
        outputs.push(await deliver(env, file, binding));
      } catch {
        selected.add(path);
        record({ path, filename: file.filename, attached: false, reason: 'source-unavailable' }, generation);
        outputs.push({ attached: false, reason: 'unavailable', detail: 'source_unavailable' });
      }
    }
    const current = state();
    const checked = current.generation === generation && activeWrites === 0;
    const removed = checked ? current.outcomes.filter((file) => excluded.has(file.path)) : [];
    if (checked) {
      const ids = removed.flatMap((file) => file.fileId ? [file.fileId] : []);
      if (ids.length) discard(ids);
      update((previous) => ({ ...previous, pending: [], shellPending: false,
        outcomes: previous.outcomes.filter((file) => !excluded.has(file.path) &&
          (file.reason !== 'source-unavailable' || selected.has(file.path))) }));
    }
    return { checked, files: outputs, retained: state().outcomes.filter((file) => file.attached).map((file) => file.filename),
      discarded: removed.map((file) => file.filename) };
  }
  function tool(binding: ArtifactDestinationBinding) {
    return defineTool({
      name: COMPLETE_FILE_DELIVERY_TOOL,
      description: 'Finish sandbox file delivery before answering. List final or revised deliverables only. Prepared files are retained even with files=[]. Use excludedPaths only to explicitly withdraw a previous deliverable. Scratch and working files stay private unless requested as final deliverables. Check each returned outcome; source_unavailable means a selected file could not be read or named correctly.',
      input: v.strictObject({
        files: v.pipe(v.array(FileInputSchema), v.maxLength(10)),
        excludedPaths: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(2048))), v.maxLength(MAX_TRACKED_FILES))),
      }),
      harness: true,
      async run({ data, harness }) {
        return { output: await complete(harness.sandbox, data.files, binding, data.excludedPaths) };
      },
    });
  }
  return { repairing, state, mark, noteStagingAttempted, wrapSandbox, deliver, complete, tool, unresolved: () => {
    const current = state();
    return current.shellPending || current.pending.length > 0 || activeWrites > 0;
  } };
}

export type FileDeliveryCompletion = ReturnType<typeof createFileDeliveryCompletion>;

/** The supported would-stop hook continues the same response and retains its sandbox and receipts. */
export function useFileDeliveryCompletion(plan: RuntimePlanV2, discard: (fileIds: string[]) => void, enabled = true): FileDeliveryCompletion {
  const [renderState, update] = usePersistentState<FileDeliveryState>(FILE_DELIVERY_DATA_NAME, initialState());
  const write = useDataWriter(FILE_DELIVERY_DATA_NAME, { schema: FileDeliveryResultSchema });
  const delivery = useDelivery();
  const completion = createFileDeliveryCompletion(update, discard, renderState.repairRequested);
  bindFileDeliveryCheck(completion.unresolved, () => completion.state().stagingAttempted, () => completion.state().repairRequested);
  useResponseStart(() => { update(initialState()); });
  useAgentFinish(({ append }) => {
    const state = completion.state();
    if (!enabled) return;
    const unresolved = completion.unresolved();
    const envelope = currentRequestEnvelopeText(delivery.body);
    if (unresolved && !state.repairRequested && envelope && delivery.kind === 'signal') {
      update((previous) => ({ ...previous, repairRequested: true }));
      const { requesterText: _requesterText, ...attributes } = delivery.attributes ?? {};
      append({ kind: 'signal', type: FILE_DELIVERY_SIGNAL_TYPE, tagName: FILE_DELIVERY_SIGNAL_TAG,
        attributes: { ...attributes, workspaceId: plan.conversation.workspaceId,
          channelId: plan.conversation.channelId, boundThreadTs: plan.conversation.threadTs,
          originalType: delivery.attributes?.originalType ?? delivery.type },
        body: [
          'The response has unchecked sandbox file work. Before answering, call complete_file_delivery with all existing final files the user should receive. Use files=[] if every remaining file is scratch or the user requested text only. This continuation can only read and export existing files: do not recreate files, generate images or charts, run shell commands, rerun the task, or retry failed/uncertain uploads. Do not merely repeat a sandbox path. Already prepared files will be retained. If this is a scheduled occurrence, resubmit the complete corrected message with submit_routine_result after the check.',
          envelope,
        ].join('\n\n'),
      });
      return;
    }
    // Never publish an earlier revision if unchecked work may have changed it.
    const invalidated = unresolved ? state.outcomes.filter((file) => state.shellPending || state.pending.includes(file.path)) : [];
    const invalidIds = invalidated.flatMap((file) => file.fileId ? [file.fileId] : []);
    if (invalidIds.length) discard(invalidIds);
    write({ unresolved, files: state.outcomes.filter((file) => !invalidated.includes(file)) });
  });
  return completion;
}

/** Failed delivery replaces unverified success prose rather than adding a contradictory footnote. */
export function resolveFileDeliveryText(text: string, data: unknown): string {
  if (data === undefined) return text;
  const latest = Array.isArray(data) ? data.at(-1) : undefined;
  const result = v.safeParse(FileDeliveryResultSchema, latest);
  if (!result.success) throw new Error('File delivery completion data is invalid.');
  const { unresolved, files } = result.output;
  const failures = files.filter((file) => !file.attached);
  if (!unresolved && failures.length === 0) return text;
  const lines = files.some((file) => file.attached) ? ['I attached the files I could deliver.'] : [];
  if (unresolved) lines.push("I couldn't finish checking the requested files for delivery. The sandbox paths are not accessible from Slack.");
  let inlineBudget = 6_000;
  for (const file of failures) {
    const name = file.filename.replace(/[\r\n`<>]/g, '-').slice(0, 256);
    lines.push(`I couldn't attach ${name}${file.reason === 'too-large' ? ' because it exceeds the upload limit' : file.reason === 'missing-scope' ? ' because this workspace does not permit uploads' : ''}.`);
    if (file.inline && file.inline.length <= inlineBudget) {
      inlineBudget -= file.inline.length;
      lines.push(`Contents of ${name}:\n${file.inline}`);
    }
  }
  return lines.join('\n\n');
}

function inlineText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > 1_500) return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return undefined;
    const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
    return `${fence}\n${text}\n${fence}`;
  } catch { return undefined; }
}

function inlineOutcome(bytes: Uint8Array): { inline?: string } {
  const inline = inlineText(bytes);
  return inline === undefined ? {} : { inline };
}

function resolveFilePath(env: SessionEnv, path: string, binding: ArtifactDestinationBinding): string {
  const resolved = sandboxArtifactPath(env, path);
  return binding.sandboxKind === 'cloudflare' ? workspaceArtifactPath(resolved) : resolved;
}
