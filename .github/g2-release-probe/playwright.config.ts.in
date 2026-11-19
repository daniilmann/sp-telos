/// <reference types="node" />
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  outputDir: join(tmpdir(), 'sp-telos-e2e', String(process.pid)),
  use: {
    browserName: 'chromium',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
});
