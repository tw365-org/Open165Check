import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:8787', trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'] } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: { command: 'npm run db:local && npx wrangler dev --env local --port 8787 --var LOCAL_ADMIN_EMAIL:tester@localhost --var LOCAL_MOCK_JEV:true --var RATE_LIMIT_SECRET:local-e2e-only --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA', url: 'http://127.0.0.1:8787/api/health', reuseExistingServer: false, timeout: 120000 },
});
