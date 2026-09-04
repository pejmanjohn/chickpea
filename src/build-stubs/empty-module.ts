// Aliased in place of dependencies whose code paths Chickpea never reaches
// (Agents SDK email replies via `mimetext`, Composio trigger subscriptions via
// `pusher-js`). The Cloudflare Worker has a hard compressed-size limit, and a
// dynamic import still ships as an uploaded chunk. Any call fails loudly.
function unavailable(): never {
  throw new Error('This dependency is not bundled in the Chickpea Worker.');
}

export default unavailable;
export const createMimeMessage = unavailable;
