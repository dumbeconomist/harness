import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

// Ports default to the documented ones; override when something else already occupies them.
const CORE_PORT = process.env.E2E_CORE_PORT ?? '8765';
const MOCK_PORT = process.env.E2E_MOCK_PORT ?? '8642';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '4173';
export const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
export const TOKEN = 'e2e-token';
export const MCP_TOKEN = 'e2e-mcp-token';
const DATA_DIR = path.join(os.tmpdir(), `workbench-e2e-data-${CORE_PORT}`);
const root = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'node tools/mock-hermes/server.js',
      cwd: root,
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      env: { MOCK_HERMES_PORT: MOCK_PORT, MOCK_HERMES_MCP_URL: `${CORE_URL}/mcp`, MOCK_HERMES_MCP_TOKEN: MCP_TOKEN },
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `rm -rf "${DATA_DIR}" && mkdir -p "${DATA_DIR}" && cargo run -q -p workbench-core`,
      cwd: root,
      url: `${CORE_URL}/api/health`,
      env: {
        WORKBENCH_ADDR: `127.0.0.1:${CORE_PORT}`,
        WORKBENCH_TOKEN: TOKEN,
        WORKBENCH_MCP_TOKEN: MCP_TOKEN,
        WORKBENCH_DATA_DIR: DATA_DIR,
        WORKBENCH_APPROVAL_TIMEOUT_SECS: '30',
        HERMES_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
    },
    {
      command: `pnpm -C web build && pnpm -C web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      cwd: root,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { VITE_WORKBENCH_URL: CORE_URL, VITE_WORKBENCH_TOKEN: TOKEN },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
