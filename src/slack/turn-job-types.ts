import type { ResolvedAssignment } from '../config/types.ts';
import type { NormalizedSlackTurn } from './types.ts';

/** JSON-clonable durable relay payload shared by Node and Cloudflare state. */
export interface TurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  /** Observational canonical Run correlation; never execution authority. */
  runId?: string;
}
