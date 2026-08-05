import { defineConfig } from "@playwright/test";

/**
 * Optional UI e2e (requires: bun add -d @playwright/test && bunx playwright install).
 * Run: bun run test:e2e
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    baseURL: process.env.KANBANLY_E2E_URL ?? "http://127.0.0.1:3847",
    headless: true,
  },
  webServer: process.env.KANBANLY_E2E_URL
    ? undefined
    : {
        command:
          "bun run packages/server/src/cli.ts serve --host 127.0.0.1 --port 3847 --repo fixtures/boards-layout-a",
        url: "http://127.0.0.1:3847/health",
        reuseExistingServer: true,
        timeout: 30_000,
      },
});
