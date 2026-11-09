import { defineConfig } from 'vitest/config';

/**
 * Public base path of the deployed site. GitHub Pages serves this project
 * at https://m14dch.github.io/agentscope/, so the default is /agentscope/.
 * Set AGENTSCOPE_BASE=/ for a root site or a custom domain.
 */
export const BASE_PATH = process.env.AGENTSCOPE_BASE ?? '/agentscope/';

export default defineConfig({
  base: BASE_PATH,
  build: {
    target: 'es2023',
    sourcemap: true,
  },
  preview: {
    port: 4173,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
