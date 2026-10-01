import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // An empty suite must fail CI, never pass silently.
    passWithNoTests: false,
  },
});
