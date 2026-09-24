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
/** Workspaces the roster remembers, open or closed, so retirement survives a close. */
const MAX_REMEMBERED_WORKSPACES = 16;
/**
 * An open workspace unused this long holds nothing: its container slept long
 * ago and its checkpoint has expired. It stops counting as open.
 */
const OPEN_WORKSPACE_IDLE_MS = WORKSPACE_CHECKPOINT_TTL_SECONDS * 1000;

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
  constructor(readonly open: readonly string[]) {
    super(
      `At most ${MAX_OPEN_WORKSPACES} coding workspaces can be open in this thread (open: ${open.join(', ')}). Close one you no longer need with workspace_close, or use an open one.`,
    );
    this.name = 'WorkspaceLimitError';
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
 * generation (part of its workspace id).
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
  return Object.entries(rosterEntries(state))
    .filter(([, entry]) => entry.open && now - entry.lastUsedAt < OPEN_WORKSPACE_IDLE_MS)
    .map(([name]) => name)
    .sort();
}

export function workspaceGeneration(state: WorkspaceRosterState, name: string): number {
  return rosterEntries(state)[name]?.generation ?? 0;
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
  const workspaces = { ...rosterEntries(state) };
  const open = openWorkspaceNames(state, now);
  if (!open.includes(name) && open.length >= MAX_OPEN_WORKSPACES) {
    return { state, admission: { ok: false, open } };
  }
  const generation = workspaces[name]?.generation ?? 0;
  workspaces[name] = { generation, open: true, lastUsedAt: now };
  return {
    state: { schemaVersion: 1, workspaces: forgetOldest(workspaces, now) },
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
  const workspaces = { ...rosterEntries(state) };
  const current = workspaces[name];
  const generation = current?.generation ?? 0;
  workspaces[name] = {
    generation: options.discard ? generation + 1 : generation,
    open: false,
    lastUsedAt: current?.lastUsedAt ?? options.now,
  };
  return { schemaVersion: 1, workspaces: forgetOldest(workspaces, options.now) };
}

/** Names the roster knows, with the default workspace always first. */
export function rosterWorkspaceNames(state: WorkspaceRosterState): string[] {
  const names = Object.keys(rosterEntries(state)).filter((name) => name !== DEFAULT_WORKSPACE_NAME).sort();
  return [DEFAULT_WORKSPACE_NAME, ...names];
}

export function rosterEntry(state: WorkspaceRosterState, name: string): WorkspaceRosterEntry | undefined {
  return rosterEntries(state)[name];
}

/**
 * The coordinator's roster as the workspace tools use it. Reads see this
 * render's writes at once, so parallel tool calls in one step agree.
 */
export interface WorkspaceRoster {
  /** Open `name` for use; throws {@link WorkspaceLimitError} past the cap. */
  admit(name: string): number;
  close(name: string, options: { discard: boolean }): void;
  generation(name: string): number;
  /** Whether the conversation has ever used `name` (the default always counts). */
  knows(name: string): boolean;
  snapshot(): WorkspaceRosterState;
}

export function createWorkspaceRoster(
  initial: WorkspaceRosterState,
  update: (updater: (previous: WorkspaceRosterState) => WorkspaceRosterState) => void,
  now: () => number = Date.now,
): WorkspaceRoster {
  let latest = parseRoster(initial);
  const write = (next: (previous: WorkspaceRosterState) => WorkspaceRosterState) => {
    update((previous) => {
      latest = next(parseRoster(previous));
      return latest;
    });
  };
  return {
    admit(name) {
      let admission: WorkspaceAdmission | undefined;
      write((previous) => {
        const result = admitWorkspace(previous, name, now());
        admission = result.admission;
        return result.state;
      });
      const outcome = admission as WorkspaceAdmission | undefined;
      if (!outcome) throw new Error('Workspace roster update did not run');
      if (!outcome.ok) throw new WorkspaceLimitError(outcome.open);
      return outcome.generation;
    },
    close(name, options) {
      write((previous) => closeWorkspace(previous, name, { ...options, now: now() }));
    },
    generation: (name) => workspaceGeneration(latest, name),
    knows: (name) => name === DEFAULT_WORKSPACE_NAME || rosterEntry(latest, name) !== undefined,
    snapshot: () => latest,
  };
}

/** A roster with only the default workspace, for plans that have no persistent roster. */
export function defaultOnlyWorkspaceRoster(): WorkspaceRoster {
  return {
    admit(name) {
      if (name !== DEFAULT_WORKSPACE_NAME) throw new WorkspaceLimitError([DEFAULT_WORKSPACE_NAME]);
      return 0;
    },
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

function rosterEntries(state: WorkspaceRosterState): Record<string, WorkspaceRosterEntry> {
  return state.workspaces;
}

/** Drop the least recently used closed or idle names past the remembered bound. */
function forgetOldest(
  workspaces: Record<string, WorkspaceRosterEntry>,
  now: number,
): Record<string, WorkspaceRosterEntry> {
  const names = Object.keys(workspaces);
  if (names.length <= MAX_REMEMBERED_WORKSPACES) return workspaces;
  const closed = names
    .filter((name) => !workspaces[name]!.open || now - workspaces[name]!.lastUsedAt >= OPEN_WORKSPACE_IDLE_MS)
    .sort((left, right) => workspaces[left]!.lastUsedAt - workspaces[right]!.lastUsedAt);
  const kept = { ...workspaces };
  for (const name of closed.slice(0, names.length - MAX_REMEMBERED_WORKSPACES)) delete kept[name];
  return kept;
}
