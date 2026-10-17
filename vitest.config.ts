import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc', environment: 'local' }, miniflare: { bindings: { ENVIRONMENT: 'test' } } })],
  test: { include: ['tests/**/*.test.ts'] },
});
