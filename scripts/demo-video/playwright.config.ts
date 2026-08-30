import { defineConfig } from "@playwright/test";

/**
 * Recording config for the PotatoGuard unified demo.
 *
 * Points at an ALREADY RUNNING server (npm run poc) rather than starting one,
 * so the recording uses your real ARK credentials and real seeded state.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /demo\.spec\.ts/,
  // One take, start to finish. Retries would produce half-recorded video files.
  retries: 0,
  workers: 1,
  // The team task does real model work; the whole take can run past 5 minutes.
  timeout: 15 * 60 * 1000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? "http://localhost:3000",
    viewport: { width: 1920, height: 1080 },
    video: {
      mode: "on",
      size: { width: 1920, height: 1080 },
    },
    // Cursor movement and clicks need to be legible to a viewer, not instant.
    launchOptions: { slowMo: Number(process.env.DEMO_SLOWMO ?? 260) },
    actionTimeout: 30_000,
  },
  outputDir: "./recordings",
});
