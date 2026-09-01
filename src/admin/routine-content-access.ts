import type { RoutineDefinition } from '../routines/types.ts';
import type { SlackTransport } from '../slack/transport/types.ts';
import type { WorkStore } from '../work/types.ts';

export type RoutineContentAccess =
  | 'public'
  | 'private_member'
  | 'private_nonmember'
  | 'authorization_unknown';

interface RoutineAdminSlackActor {
  slackTeamId: string;
  slackUserId: string;
}

interface RoutineContentAccessResolverOptions {
  work?: WorkStore | undefined;
  actor?: (() => Promise<RoutineAdminSlackActor>) | undefined;
  transport?: ((workspaceId: string) => Promise<SlackTransport>) | undefined;
}

/**
 * Request-scoped routine content authorization. Work and Binding integrity are
 * checked before Slack authority, and one Slack membership set is shared by
 * every routine projected for the same authenticated actor and workspace.
 */
export class RoutineContentAccessResolver {
  private actorResult?: Promise<RoutineAdminSlackActor | undefined>;
  private readonly membershipResults = new Map<string, Promise<ReadonlySet<string> | undefined>>();
  private readonly accessResults = new Map<string, Promise<RoutineContentAccess>>();

  constructor(private readonly options: RoutineContentAccessResolverOptions) {}

  resolve(routine: RoutineDefinition): Promise<RoutineContentAccess> {
    if (routine.destination.kind === 'direct_thread') {
      return Promise.resolve('authorization_unknown');
    }
    const key = `${routine.id}\0${routine.version}\0${routine.workId ?? ''}\0${routine.bindingId ?? ''}`;
    const current = this.accessResults.get(key);
    if (current) return current;
    const result = this.resolveUncached(routine);
    this.accessResults.set(key, result);
    return result;
  }

  private async resolveUncached(routine: RoutineDefinition): Promise<RoutineContentAccess> {
    const store = this.options.work;
    if (!store || !routine.workId || !routine.bindingId) return 'authorization_unknown';
    try {
      const [work, binding] = await Promise.all([
        store.getWork(routine.workId as Parameters<WorkStore['getWork']>[0]),
        store.getBinding(routine.bindingId as Parameters<WorkStore['getBinding']>[0]),
      ]);
      if (!work || !binding ||
          work.id !== routine.workId || binding.id !== routine.bindingId ||
          binding.workId !== work.id || work.kind !== 'routine' ||
          binding.adapterKind !== 'routine') {
        return 'authorization_unknown';
      }
      if (work.maximumSensitivity === 'public' && binding.sourceVisibility === 'public') {
        return 'public';
      }
      // Visibility resolution is best-effort at schedule creation time. Older
      // schedules, and schedules created while Slack visibility lookup is
      // temporarily unavailable, carry `unknown`. Treat that value as private
      // rather than making a proven Channel member lose all controls. This is
      // still fail-closed: only a live Slack membership check below can reveal
      // the content, and public content still requires an exact public/public
      // integrity match above.
      if (work.maximumSensitivity !== 'private' ||
          !['private', 'unknown'].includes(binding.sourceVisibility)) {
        return 'authorization_unknown';
      }
    } catch {
      return 'authorization_unknown';
    }

    const actor = await this.resolveActor();
    if (!actor || actor.slackTeamId !== routine.workspaceId) return 'authorization_unknown';
    const channels = await this.resolveMemberChannels(actor);
    if (!channels) return 'authorization_unknown';
    return channels.has(routine.channelId) ? 'private_member' : 'private_nonmember';
  }

  private resolveActor(): Promise<RoutineAdminSlackActor | undefined> {
    if (!this.actorResult) {
      this.actorResult = this.options.actor
        ? this.options.actor().catch(() => undefined)
        : Promise.resolve(undefined);
    }
    return this.actorResult;
  }

  private resolveMemberChannels(
    actor: RoutineAdminSlackActor,
  ): Promise<ReadonlySet<string> | undefined> {
    const key = `${actor.slackTeamId}\0${actor.slackUserId}`;
    const current = this.membershipResults.get(key);
    if (current) return current;
    const result = this.options.transport
      ? this.options.transport(actor.slackTeamId)
          .then((transport) => transport.listMemberChannels(actor.slackUserId))
          .catch(() => undefined)
      : Promise.resolve(undefined);
    this.membershipResults.set(key, result);
    return result;
  }
}

export function routineContentReadable(
  access: RoutineContentAccess,
): access is Extract<RoutineContentAccess, 'public' | 'private_member'> {
  return access === 'public' || access === 'private_member';
}
