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
  },
});
