import { defineConfig } from 'vitest/config';
import { normalizeBase } from './src/base.ts';

/**
 * Public base path of the deployed site. GitHub Pages serves this project
 * at https://m14dch.github.io/agentscope/, so the default is /agentscope/.
 * Set AGENTSCOPE_BASE=/ for a root site or a custom domain.
 */
export const BASE_PATH = normalizeBase(process.env.AGENTSCOPE_BASE ?? '/agentscope/');

export default defineConfig({
  base: BASE_PATH,
  build: {
    target: 'es2023',
    // No source maps in the deployed site: they would be published and precached.
    sourcemap: false,
  },
  preview: {
    port: 4173,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
