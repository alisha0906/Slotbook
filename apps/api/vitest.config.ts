import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests hit a real Postgres, so give them room and run files serially to
    // avoid cross-test interference on shared tables.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    include: ["test/**/*.test.ts"],
  },
});
