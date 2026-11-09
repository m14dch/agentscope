import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { normalizeBase } from './src/base.ts';
import { scenariosPlugin } from './scripts/vite-scenarios.ts';

/**
 * Public base path of the deployed site. GitHub Pages serves this project
 * at https://m14dch.github.io/agentscope/, so the default is /agentscope/.
 * Set AGENTSCOPE_BASE=/ for a root site or a custom domain.
 */
export const BASE_PATH = normalizeBase(process.env.AGENTSCOPE_BASE ?? '/agentscope/');

/** Commit the build comes from; checked after deployment to detect a stale site. */
const VERSION = process.env.AGENTSCOPE_VERSION ?? 'dev';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    // Bundles the YAML specifications as JSON and fails the build if they are invalid.
    scenariosPlugin(fileURLToPath(new URL('./specifications', import.meta.url))),
    {
      name: 'agentscope-version',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'agentscope-version', content: VERSION }, injectTo: 'head' },
      ],
    },
  ],
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
