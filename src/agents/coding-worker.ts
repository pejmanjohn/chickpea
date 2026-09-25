'use agent';

import {
  useInitialData,
  useModel,
  useSandbox,
  useSkill,
  type AgentProps,
  type SandboxFactory,
} from '@flue/runtime';
import * as v from 'valibot';

import { repositoriesSkillForGrants } from '../config/connector-skills.ts';
import { resolveProfileSkills } from '../config/profile-skills.ts';
import { registerFrozenRuntimeModelRoute, resolveRuntimeModel } from '../config/runtime-model.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  getConfigStore,
  getSettingsStore,
  getSlackStateStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import { thinkingLevelForModel } from '../config/workers-ai-models.ts';
import {
  codingWorkerInstanceId,
  codingWorkerRepositoryGrants,
  parseCodingWorkerBinding,
  type CodingWorkerBindingV1,
} from '../sandbox/coding-worker-binding.ts';
import { CODING_WORKER_INSTRUCTIONS } from '../sandbox/coding-worker-instructions.ts';
import {
  CLOUDFLARE_SANDBOX_OPTIONS,
  contentFreeSandboxExec,
  serializeSandboxActivation,
} from '../sandbox/lifecycle.ts';
import { reconnectingSandboxStub } from '../sandbox/reconnect.ts';
import type { SandboxTurnContext } from '../sandbox/turn-context.ts';
import { WORKSPACE_DIR } from '../sandbox/workspace-lifecycle.ts';
import { useChickpeaResponseMetadata } from '../usage/response-metadata.ts';
import { TurnEnvelopeContext } from './turn-envelope.ts';

/**
 * A coding worker: one Flue agent instance per coding workspace and binding,
 * driven by the coordinator's `workspace_task` tool. It owns the workspace's
 * container as its sandbox, runs on the frozen coding model, and mounts no
 * Chickpea tool with an effect outside the workspace (no Slack, connections,
 * files, browser, or memory), so every approval stays with the coordinator.
 * GitHub access is the workspace's egress policy, bound to the coordinator's
 * turn; this agent carries no credential.
 */
export function CodingWorker({ id }: AgentProps) {
  const binding = parseCodingWorkerBinding(useInitialData());
  // The instance id is derived from the binding; a mismatch means the binding
  // was sent to the wrong instance and must not run.
  if (codingWorkerInstanceId(binding) !== id) {
    throw new Error('Coding worker binding does not match its instance.');
  }
  const { model, runtimeModel, runtimeModelRoute } = binding.codingModel;
  registerFrozenRuntimeModelRoute(model, runtimeModel, runtimeModelRoute);
  const thinkingLevel = thinkingLevelForModel(model);
  useModel(runtimeModel, thinkingLevel ? { thinkingLevel } : {});
  // The task's usage rides back on the reply; the coordinator's turn records it.
  useChickpeaResponseMetadata(model);
  useSandbox(codingWorkerSandbox(binding));
  const repositories = repositoriesSkillForGrants(codingWorkerRepositoryGrants(binding));
  for (const skill of resolveProfileSkills(repositories ? [repositories] : [])) {
    useSkill(skill);
  }
  return CODING_WORKER_INSTRUCTIONS;
}

/**
 * The workspace's container, reached through the same Sandbox Durable Object
 * the coordinator opened for this turn. The coordinator activates it (session
 * cap, checkpoint restore) before dispatching, so this handle only needs the
 * readiness probe and the content-free command wrapper.
 */
function codingWorkerSandbox(binding: CodingWorkerBindingV1): SandboxFactory {
  return {
    async createSandbox(options) {
      if (!isCloudflareTarget()) {
        throw new Error('Coding workers run only on the Cloudflare target.');
      }
      const [{ cloudflareSandbox, getCloudflareContext }, { getSandbox }] = await Promise.all([
        import('@flue/runtime/cloudflare'),
        import('@cloudflare/sandbox'),
      ]);
      const env = getCloudflareContext().env as PlatformEnv & { SANDBOX?: unknown; Sandbox?: unknown };
      const namespace = env.SANDBOX ?? env.Sandbox;
      if (!namespace) throw new Error('The coding workspace binding is unavailable.');
      // A task can run for most of an hour, and Cloudflare may replace the
      // Sandbox Durable Object instance meanwhile (the container survives).
      // Mint the stub lazily and again after a disconnect, never once per task.
      const stub = reconnectingSandboxStub(() =>
        getSandbox(
          namespace as Parameters<typeof getSandbox>[0],
          binding.workspaceId,
          CLOUDFLARE_SANDBOX_OPTIONS,
        ),
      );
      await prepareCodingModel(
        binding,
        env,
        await codingWorkerTurn(binding, stub as unknown as SandboxTurnContext, env),
      );
      const guarded = contentFreeSandboxExec(serializeSandboxActivation(stub, WORKSPACE_DIR));
      return cloudflareSandbox(
        guarded as unknown as Parameters<typeof cloudflareSandbox>[0],
        { cwd: WORKSPACE_DIR },
      ).createSandbox(options);
    },
  };
}

/**
 * The coordinator turn's settings envelope. The coordinator binds the
 * workspace to its TurnJob before dispatching a task, so the workspace's
 * current turn id names it; a routine run's turn has no envelope.
 */
async function codingWorkerTurn(
  binding: CodingWorkerBindingV1,
  workspace: SandboxTurnContext,
  env: PlatformEnv,
): Promise<TurnEnvelopeContext | undefined> {
  const turnId = await workspace.getTurnId().catch(() => undefined);
  if (!turnId || turnId.length > 200) return undefined;
  return new TurnEnvelopeContext(
    turnId,
    binding.agentId,
    async (id) => getSlackStateStore(env).getTurnEnvelope?.(id),
  );
}

/**
 * Bind the coding model's provider credential for this isolate, exactly as
 * the coordinator binds its own model. A disabled Agent or a route that no
 * longer matches the frozen one fails the task instead of switching models.
 * With the coordinator's turn envelope, the Agent and the non-secret routing
 * settings are as of that turn's dispatch; the provider key is read live.
 */
export async function prepareCodingModel(
  binding: CodingWorkerBindingV1,
  env: PlatformEnv,
  turn?: TurnEnvelopeContext,
): Promise<void> {
  const envelope = await turn?.envelope();
  const enabled = envelope
    ? envelope.agent?.enabled === true
    : (await getConfigStore(env).getAgent(binding.agentId)).enabled;
  if (!enabled) throw new Error('The Agent for this coding workspace is disabled.');
  const live = getSettingsStore(env);
  const resolve = (settings: SettingsStore) =>
    resolveRuntimeModel(binding.agentId, binding.codingModel.model, { settings, env });
  const resolved = turn ? await turn.withSettings(live, resolve) : await resolve(live);
  if (resolved.model !== binding.codingModel.runtimeModel) {
    throw new Error('The coding model route changed after this workspace task was sent.');
  }
}

// MUST stay a top-level string literal: see the note on ChickpeaRoutineExecution.
CodingWorker.agentName = 'chickpea-coding-worker-v1';
CodingWorker.initialData = v.custom<CodingWorkerBindingV1>((value) => {
  try {
    parseCodingWorkerBinding(value);
    return true;
  } catch {
    return false;
  }
}, 'Coding worker binding is invalid.');
// A worker settles on its own before the coordinator's longest wait ends, so a
// runaway task can never outlive the turn that asked for it.
CodingWorker.durability = { maxAttempts: 5, timeoutMs: 65 * 60_000 };
