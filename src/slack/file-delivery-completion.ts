import {
  createBashTool, createEditTool, createGlobTool, createGrepTool, createReadTool,
  createWriteTool, defineTool, useAgentFinish, useDataWriter, useDelivery,
  usePersistentState, useResponseStart,
  type SandboxFactory, type SessionEnv, type StateSetter,
} from '@flue/runtime';
import * as v from 'valibot';
import { bindFileDeliveryCheck } from './presentation-tool-policy.ts';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import { assertArtifactDeliveryAllowed, currentRequestEnvelopeText } from '../memory/tool-policy.ts';
import {
  MAX_ARTIFACT_BYTES, readSandboxArtifact, sandboxArtifactPath, workspaceArtifactPath,
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
  outcomes: v.array(FileOutcomeSchema), repairRequested: v.boolean(),
});
export type FileDeliveryState = v.InferOutput<typeof CompletionStateSchema>;
export const FileDeliveryResultSchema = v.strictObject({
  unresolved: v.boolean(), files: v.array(FileOutcomeSchema),
});
const initialState = (): FileDeliveryState => ({ pending: [], shellPending: false, generation: 0, outcomes: [], repairRequested: false });
const FileInputSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  filename: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
});
export type FileDeliveryInput = v.InferOutput<typeof FileInputSchema>;

export const FILE_COMPLETION_INSTRUCTION = [
  'After shell work, call complete_file_delivery before your final answer or submit_routine_result. List every final sandbox file for the user, including files already passed to post_artifact; it attaches missing files and reuses prepared files. Use an empty files list only when the work was scratch, a text-only answer, or the user explicitly asked for no attachment. Do not create or attach scratch scripts, temporary files, or repository source files as deliverables.',
  'For a file written directly with write/edit, post_artifact accounts for that file. If other written files are scratch, complete_file_delivery confirms the final selection. Do all file work before completing delivery. Never declare stream_answer or present_table while file delivery is unchecked.',
  'A file-delivery check is internal continuation of the same request, not a new task. Complete only the omitted export, preserve already prepared files, and never repeat unrelated actions. Report individual attachment failures honestly.',
].join('\n');

/** Durable bookkeeping lives beside upload receipts; it never scans or publishes the filesystem. */
export function createFileDeliveryCompletion(update: StateSetter<FileDeliveryState>, discard: (fileIds: string[]) => void = () => {}) {
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
  async function deliverOnce(env: SessionEnv, input: FileDeliveryInput, binding: ArtifactDestinationBinding): Promise<ArtifactToolResult> {
    assertArtifactDeliveryAllowed();
    const generation = state().generation;
    let path = input.path;
    let digest: string | undefined;
    let bytes: Uint8Array | undefined;
    try {
      path = binding.sandboxKind === 'cloudflare' ? workspaceArtifactPath(input.path) : sandboxArtifactPath(env, input.path);
      bytes = await readSandboxArtifact(env, path, binding.sandboxKind);
      digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)),
        (byte) => byte.toString(16).padStart(2, '0')).join('');
      const previous = state().outcomes.find((known) => known.path === path && known.digest === digest &&
        (!known.attached || known.filename === input.filename));
      // Both success and uncertain failure are terminal for these exact bytes in this response.
      if (previous) {
        record(previous, generation);
        return previous.attached
          ? { attached: true, filename: previous.filename, byteLength: previous.byteLength! }
          : previous.reason === 'too-large' ? { attached: false, reason: 'too-large', maxBytes: previous.maxBytes ?? MAX_ARTIFACT_BYTES }
            : { attached: false, reason: previous.reason === 'missing-scope' ? 'missing-scope' : 'unavailable' };
      }
      const superseded = state().outcomes.find((known) => known.path === path);
      if (superseded?.fileId) discard([superseded.fileId]);
      const result = await binding.stageArtifact({ bytes, filename: input.filename,
        ...(input.title ? { title: input.title } : {}), kind: 'file' });
      record({ path, filename: input.filename, digest, attached: result.attached,
        ...(result.attached ? { byteLength: result.byteLength, ...(result.fileId ? { fileId: result.fileId } : {}) }
          : { reason: result.reason, ...(result.reason === 'too-large' ? { maxBytes: result.maxBytes } : {}), ...inlineOutcome(bytes) }) }, generation);
      return result.attached ? { attached: true, filename: input.filename, byteLength: result.byteLength } : result;
    } catch (error) {
      const tooLarge = error instanceof Error && /size|limit/.test(error.message);
      const superseded = state().outcomes.find((known) => known.path === path);
      if (superseded?.fileId) discard([superseded.fileId]);
      record({ path, filename: input.filename, ...(digest ? { digest } : {}), attached: false,
        reason: tooLarge ? 'too-large' : 'unavailable', ...(tooLarge ? { maxBytes: MAX_ARTIFACT_BYTES } : {}), ...(bytes ? inlineOutcome(bytes) : {}) }, generation);
      return tooLarge ? { attached: false, reason: 'too-large', maxBytes: MAX_ARTIFACT_BYTES } : { attached: false, reason: 'unavailable' };
    }
  }
  function deliver(env: SessionEnv, input: FileDeliveryInput, binding: ArtifactDestinationBinding): Promise<ArtifactToolResult> {
    const task = deliveryTail.then(() => deliverOnce(env, input, binding));
    deliveryTail = task.then(() => {}, () => {});
    return task;
  }
  async function complete(env: SessionEnv, files: FileDeliveryInput[], binding: ArtifactDestinationBinding) {
    assertArtifactDeliveryAllowed();
    const generation = state().generation;
    const outputs: ArtifactToolResult[] = [];
    for (const file of files) outputs.push(await deliver(env, file, binding));
    const selected = new Set(files.map((file) => binding.sandboxKind === 'cloudflare'
      ? workspaceArtifactPath(file.path) : sandboxArtifactPath(env, file.path)));
    const current = state();
    const checked = current.generation === generation && activeWrites === 0;
    if (checked) {
      discard(current.outcomes.filter((known) => !selected.has(known.path)).flatMap((known) => known.fileId ? [known.fileId] : []));
      update((previous) => ({ ...previous, pending: [], shellPending: false,
        outcomes: previous.outcomes.filter((known) => selected.has(known.path)) }));
    }
    return { checked, files: outputs };
  }
  function tool(binding: ArtifactDestinationBinding) {
    return defineTool({
      name: COMPLETE_FILE_DELIVERY_TOOL,
      description: 'Finish sandbox file delivery before answering. List final deliverables only. Missing files are attached; prepared files are reused. An empty list confirms scratch or text-only work. Never include intermediate scripts or private workspace files.',
      input: v.strictObject({ files: v.pipe(v.array(FileInputSchema), v.maxLength(10)) }),
      harness: true,
      async run({ data, harness }) {
        return { output: await complete(harness.sandbox, data.files, binding) };
      },
    });
  }
  return { state, mark, wrapSandbox, deliver, complete, tool, unresolved: () => {
    const current = state();
    return current.shellPending || current.pending.length > 0 || activeWrites > 0;
  } };
}

export type FileDeliveryCompletion = ReturnType<typeof createFileDeliveryCompletion>;

/** The supported would-stop hook continues the same response and retains its sandbox and receipts. */
export function useFileDeliveryCompletion(plan: RuntimePlanV2, discard: (fileIds: string[]) => void, enabled = true): FileDeliveryCompletion {
  const [, update] = usePersistentState<FileDeliveryState>(FILE_DELIVERY_DATA_NAME, initialState());
  const write = useDataWriter(FILE_DELIVERY_DATA_NAME, { schema: FileDeliveryResultSchema });
  const delivery = useDelivery();
  const completion = createFileDeliveryCompletion(update, discard);
  bindFileDeliveryCheck(completion.unresolved);
  useResponseStart(() => { update(initialState()); });
  useAgentFinish(({ append }) => {
    const state = completion.state();
    if (!enabled) return;
    const unresolved = completion.unresolved();
    const envelope = currentRequestEnvelopeText(delivery.body);
    if (unresolved && !state.repairRequested && envelope && delivery.kind === 'signal') {
      update((previous) => ({ ...previous, repairRequested: true }));
      append({ kind: 'signal', type: FILE_DELIVERY_SIGNAL_TYPE, tagName: FILE_DELIVERY_SIGNAL_TAG,
        attributes: { ...delivery.attributes, workspaceId: plan.conversation.workspaceId,
          channelId: plan.conversation.channelId, boundThreadTs: plan.conversation.threadTs,
          originalType: delivery.attributes?.originalType ?? delivery.type },
        body: [
          'The response has unchecked sandbox file work. Before answering, call complete_file_delivery with all final files the user should receive. Use files=[] if every remaining file is scratch or the user requested text only. Do not merely repeat a sandbox path. Do not rerun the task or retry failed/uncertain uploads. Already prepared files will be reused.',
          envelope,
        ].join('\n\n'),
      });
      return;
    }
    // Never publish an earlier revision if unchecked work may have changed it.
    const invalidated = unresolved ? state.outcomes.filter((file) => state.shellPending || state.pending.includes(file.path)) : [];
    discard(invalidated.flatMap((file) => file.fileId ? [file.fileId] : []));
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
