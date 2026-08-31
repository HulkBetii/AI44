import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentMatchGlobs: [['src/web/**', 'jsdom']],
    setupFiles: ['src/web/test-setup.ts'],
    fileParallelism: false,
  },
});
