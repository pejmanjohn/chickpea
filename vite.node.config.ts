import { assertNodeVersion } from './scripts/lib/node-version.mjs';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

assertNodeVersion();

export default defineConfig({
  publicDir: 'assets',
  plugins: [
    flue({
      // The v2 Cloudflare target rejects custom persistence. Giving only the
      // Node composition this non-discoverable entry removes the old rename,
      // signal-recovery, and postinstall patch choreography.
      db: 'src/db.node.ts',
    }),
  ],
  build: {
    outDir: 'dist',
  },
  server: {
    watch: {
      ignored: ['**/tmp/**', '**/.*/**'],
    },
  },
});
