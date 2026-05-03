import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // Integration tests download Mongo on first run and start a replica set.
    // 60s gives plenty of headroom; unit tests still finish in milliseconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
