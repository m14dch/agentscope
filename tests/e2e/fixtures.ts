import { test as base, expect } from '@playwright/test';

/**
 * Every end-to-end test uses this `page`: it blocks and records any request
 * that leaves the app's own origin, then fails the test if there was one.
 * AgentScope must make zero external and zero runtime API requests.
 */
export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const origin = new URL(baseURL ?? 'http://localhost').origin;
    const external: string[] = [];
    await page.route(
      (url) => url.origin !== origin,
      (route) => {
        external.push(route.request().url());
        return route.abort('blockedbyclient');
      },
    );
    await use(page);
    expect(external, 'requests outside the app origin').toEqual([]);
  },
});

export { expect };
