import { defineConfig, devices } from '@playwright/test';
import { BASE_PATH } from './vite.config';

const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `${ORIGIN}${BASE_PATH}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // CI builds in its own step; locally, build first so tests never see a stale dist/.
    command: process.env.CI ? 'npm run preview' : 'npm run build && npm run preview',
    url: `${ORIGIN}${BASE_PATH}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
