import { WORKSPACE_CHECKPOINT_TTL_SECONDS } from './workspace-lifecycle.ts';

/**
 * Coding workspaces one Agent may hold open in one Slack thread. Each one is
 * its own container start and counts against the monthly session cap.
 */
export const MAX_OPEN_WORKSPACES = 2;
/**
 * Coding tasks running at once in one workspace. A second task is refused as
 * busy rather than left for Flue to queue behind the first.
 */
export const MAX_RUNNING_TASKS_PER_WORKSPACE = 1;

/** The workspace a conversation gets when no name is given. */
export const DEFAULT_WORKSPACE_NAME = 'main';
/** Longest workspace name. The id hashes it, so this bounds nothing but readability. */
export const MAX_WORKSPACE_NAME_CHARS = 32;
const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
/**
 * An open workspace unused this long holds nothing: its container slept long
 * ago and its checkpoint has expired. It stops counting as open.
 */
const OPEN_WORKSPACE_IDLE_MS = WORKSPACE_CHECKPOINT_TTL_SECONDS * 1000;
/**
 * How stale an open workspace's last use may be before a use records it
 * again, so a chain of commands is not one persistent write each.
 */
const LAST_USED_RESOLUTION_MS = 60_000;

/** A model-supplied workspace name that is not a valid name. */
export class WorkspaceNameError extends Error {
  constructor() {
    super(
      `A workspace name is 1 to ${MAX_WORKSPACE_NAME_CHARS} lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    );
    this.name = 'WorkspaceNameError';
  }
}

/** Opening another workspace would exceed {@link MAX_OPEN_WORKSPACES}. */
export class WorkspaceLimitError extends Error {
  constructor(readonly open: readonly string[], message?: string) {
    super(
      message ??
        `At most ${MAX_OPEN_WORKSPACES} coding workspaces can be open in this thread (open: ${open.join(', ')}). Close one you no longer need with workspace_close, or use an open one.`,
    );
    this.name = 'WorkspaceLimitError';
  }

  /** A plan that has only the default workspace. */
  static defaultOnly(): WorkspaceLimitError {
    return new WorkspaceLimitError(
      [DEFAULT_WORKSPACE_NAME],
      `This request has only the "${DEFAULT_WORKSPACE_NAME}" workspace; use it, or omit the workspace name.`,
    );
  }
}

/** The workspace name a tool call addresses: trimmed, lowercased, validated. */
export function normalizeWorkspaceName(name: string | undefined): string {
  if (name === undefined) return DEFAULT_WORKSPACE_NAME;
  const normalized = name.trim().toLowerCase();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_WORKSPACE_NAME_CHARS ||
    !WORKSPACE_NAME_PATTERN.test(normalized)
  ) {
    throw new WorkspaceNameError();
  }
  return normalized;
}

export interface WorkspaceRosterEntry {
  /** Retirement generation; a discard moves the name to a new workspace id. */
  generation: number;
  open: boolean;
  lastUsedAt: number;
}

/**
 * The conversation's coding workspaces, kept in the coordinator's persistent
 * state: which names are open (for the open cap), and each name's retirement
 * generation (part of its workspace id). Names are never forgotten, so a
 * retired generation is never reused.
 */
export interface WorkspaceRosterState {
  schemaVersion: 1;
  workspaces: Record<string, WorkspaceRosterEntry>;
}

export const EMPTY_WORKSPACE_ROSTER: WorkspaceRosterState = { schemaVersion: 1, workspaces: {} };

export type WorkspaceAdmission =
  | { ok: true; generation: number }
  | { ok: false; open: string[] };

/** Names that count against the open cap at `now`. */
export function openWorkspaceNames(state: WorkspaceRosterState, now: number): string[] {
  return Object.entries(state.workspaces)
    .filter(([, entry]) => entry.open && now - entry.lastUsedAt < OPEN_WORKSPACE_IDLE_MS)
    .map(([name]) => name)
    .sort();
}

/**
 * Open `name` for use, or refuse when {@link MAX_OPEN_WORKSPACES} other
 * workspaces are already open. Using an open workspace is always admitted.
 */
export function admitWorkspace(
  state: WorkspaceRosterState,
  name: string,
  now: number,
): { state: WorkspaceRosterState; admission: WorkspaceAdmission } {
  const open = openWorkspaceNames(state, now);
  const current = state.workspaces[name];
  const generation = current?.generation ?? 0;
  if (open.includes(name)) {
    // Already open: refresh its last use only once it has gone stale.
    if (now - current!.lastUsedAt < LAST_USED_RESOLUTION_MS) {
      return { state, admission: { ok: true, generation } };
    }
  } else if (open.length >= MAX_OPEN_WORKSPACES) {
    return { state, admission: { ok: false, open } };
  }
  return {
    state: { schemaVersion: 1, workspaces: { ...state.workspaces, [name]: { generation, open: true, lastUsedAt: now } } },
    admission: { ok: true, generation },
  };
}

/**
 * Close `name`: it stops counting as open. A discard also retires it, so the
 * name's next use addresses a new workspace (and a new coding worker) instead
 * of the destroyed one.
 */
export function closeWorkspace(
  state: WorkspaceRosterState,
  name: string,
  options: { discard: boolean; now: number },
): WorkspaceRosterState {
  const current = state.workspaces[name];
  const generation = current?.generation ?? 0;
  return {
    schemaVersion: 1,
    workspaces: {
      ...state.workspaces,
      [name]: {
        generation: options.discard ? generation + 1 : generation,
        open: false,
        lastUsedAt: current?.lastUsedAt ?? options.now,
      },
    },
  };
}

/** Names the roster knows, with the default workspace always first. */
export function rosterWorkspaceNames(state: WorkspaceRosterState): string[] {
  const names = Object.keys(state.workspaces).filter((name) => name !== DEFAULT_WORKSPACE_NAME).sort();
  return [DEFAULT_WORKSPACE_NAME, ...names];
}

/**
 * The coordinator's roster as the workspace tools use it. Reads see this
 * render's writes at once, so parallel tool calls in one step agree.
 */
export interface WorkspaceRoster {
  /** Open `name` for use; throws {@link WorkspaceLimitError} past the cap. */
  admit(name: string): number;
  /** Put `name` back as it was before an admission whose workspace never came up. */
  restore(name: string, entry: WorkspaceRosterEntry | undefined): void;
  close(name: string, options: { discard: boolean }): void;
  generation(name: string): number;
  /** Whether the conversation has ever used `name` (the default always counts). */
  knows(name: string): boolean;
  snapshot(): WorkspaceRosterState;
}

export function createWorkspaceRoster(
  initial: unknown,
  update: (updater: (previous: WorkspaceRosterState) => WorkspaceRosterState) => void,
  now: () => number = Date.now,
): WorkspaceRoster {
  // The mirror is the source of truth for this render; every write goes
  // through it, so the updater's previous value is always the mirror.
  let latest = parseRoster(initial);
  const write = (next: WorkspaceRosterState) => {
    if (next === latest) return;
    latest = next;
    update(() => next);
  };
  return {
    admit(name) {
      const { state, admission } = admitWorkspace(latest, name, now());
      if (!admission.ok) throw new WorkspaceLimitError(admission.open);
      write(state);
      return admission.generation;
    },
    restore(name, entry) {
      const { [name]: _removed, ...rest } = latest.workspaces;
      write({ schemaVersion: 1, workspaces: entry ? { ...rest, [name]: entry } : rest });
    },
    close(name, options) {
      write(closeWorkspace(latest, name, { ...options, now: now() }));
    },
    generation: (name) => latest.workspaces[name]?.generation ?? 0,
    knows: (name) => name === DEFAULT_WORKSPACE_NAME || latest.workspaces[name] !== undefined,
    snapshot: () => latest,
  };
}

/** A roster with only the default workspace, for plans that have no persistent roster. */
export function defaultOnlyWorkspaceRoster(): WorkspaceRoster {
  return {
    admit(name) {
      if (name !== DEFAULT_WORKSPACE_NAME) throw WorkspaceLimitError.defaultOnly();
      return 0;
    },
    restore() {},
    close() {},
    generation: () => 0,
    knows: (name) => name === DEFAULT_WORKSPACE_NAME,
    snapshot: () => EMPTY_WORKSPACE_ROSTER,
  };
}

/** Persisted state is data from an earlier release: keep only well-formed entries. */
export function parseRoster(value: unknown): WorkspaceRosterState {
  const record = value as Partial<WorkspaceRosterState> | undefined;
  if (!record || record.schemaVersion !== 1 || typeof record.workspaces !== 'object' || !record.workspaces) {
    return EMPTY_WORKSPACE_ROSTER;
  }
  const workspaces: Record<string, WorkspaceRosterEntry> = {};
  for (const [name, entry] of Object.entries(record.workspaces)) {
    if (
      WORKSPACE_NAME_PATTERN.test(name) && name.length <= MAX_WORKSPACE_NAME_CHARS &&
      entry && Number.isSafeInteger(entry.generation) && entry.generation >= 0 &&
      typeof entry.open === 'boolean' && Number.isFinite(entry.lastUsedAt)
    ) {
      workspaces[name] = { generation: entry.generation, open: entry.open, lastUsedAt: entry.lastUsedAt };
    }
  }
  return { schemaVersion: 1, workspaces };
}
