import { fileURLToPath } from 'node:url';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Workspace packages export their TypeScript source under the "quorum-source" condition,
// so tests run against source without a build step (config/tsconfig.base.json does the same for tsc).
const conditions = ['quorum-source', ...defaultServerConditions];

export default defineConfig({
  // This file lives in config/; tests and paths are relative to the repository root.
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // An empty suite must fail CI, never pass silently.
    passWithNoTests: false,
    // Many tests start real servers. With every file running at once, the first start in a file
    // can take more than vitest's default 5 s / 10 s (seen 2026-10-19); a hang still fails.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
