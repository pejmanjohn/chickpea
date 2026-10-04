/**
 * Settings keys Chickpea no longer reads or writes. A stored row stays where
 * it is, with no migration to delete it: nothing reads it, and no export
 * carries it. This module is the only source that names them.
 *
 * - `egress.policy`: the standalone Outbound access policy. The Agent sandbox
 *   had stopped reading it, so the setting was removed in both modes.
 */
export const RETIRED_SETTING_KEYS: ReadonlySet<string> = new Set(['egress.policy']);
