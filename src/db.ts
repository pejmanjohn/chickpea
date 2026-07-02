import { sqlite } from '@flue/runtime/node';

// File-backed persistence for the Flue lane (Stage 4). The default Node
// persistence is an in-memory SQLite DB that is lost on process exit, so a
// Slack redelivery after a restart would re-run a turn and lose the thread's
// conversation history. A file-backed adapter makes the agent's conversation
// transcript survive restarts, so a second turn in the same thread replays the
// prior turn from durable storage. (Claims and the session registry are NOT
// durable — they live in process memory; see the claim-store follow-up.)
//
// The path defaults to `./tmp/flue.db` (tmp/ is git-ignored). Override with
// FLUE_DB_PATH — parity/offline harnesses pass `:memory:` for per-process
// isolation. NOTE: db.ts is only supported on the Node build target; the
// Cloudflare target uses Durable Object SQLite automatically and rejects it,
// which is why flue.config.ts and `flue:build` target Node.
export default sqlite(process.env.FLUE_DB_PATH ?? './tmp/flue.db');
