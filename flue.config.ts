import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  // Node target (Stage 4): file-backed persistence via `src/db.ts` is only
  // supported on Node — the Cloudflare target rejects a custom db.ts (it uses
  // Durable Object SQLite automatically).
  target: 'node',
});

export const vite = {
  server: {
    watch: {
      // Default SQLite dev files live in tmp/. Ignore them and their WAL/SHM
      // sidecars so Flue watch mode does not reload on every DB write.
      ignored: ['**/tmp/**'],
    },
  },
};
