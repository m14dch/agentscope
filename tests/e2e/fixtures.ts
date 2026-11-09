import { test as base } from '@playwright/test';
import { EgressProxy } from './egress-proxy';
import { guardViolations, type GuardMode } from './guard-check';

/** Requests sent while a page unloads reach the proxy about 15 ms later; wait well beyond that. */
const UNLOAD_SETTLE_MS = 250;

type GuardOptions = {
  /** 'fail' (default) fails the test on any external request; 'record' only records them. */
  externalRequestGuard: GuardMode;
};

type GuardFixtures = {
  /** External requests blocked so far, deduplicated, in the order they were first seen. */
  externalRequests: string[];
  /** Connection targets (host:port or URL) refused by the egress proxy during this test. */
  egressAttempts: string[];
};

type WorkerFixtures = {
  egressProxy: EgressProxy;
};

/**
 * Every end-to-end test runs in a browser context that blocks and records any
 * request leaving the app's own origin, in two layers:
 * 1. Playwright routing: page and popup HTTP requests, service-worker requests
 *    and WebSockets, recorded with their full URL.
 * 2. An egress proxy that every non-localhost connection must pass through:
 *    catches what Playwright cannot observe, such as beacons sent on unload.
 * With the default 'fail' mode the test fails if either layer saw anything.
 * AgentScope must make zero external and zero runtime API requests.
 */
export const test = base.extend<GuardFixtures & GuardOptions, WorkerFixtures>({
  externalRequestGuard: ['fail', { option: true }],

  egressProxy: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const proxy = await EgressProxy.start();
      await use(proxy);
      await proxy.stop();
    },
    { scope: 'worker' },
  ],

  proxy: async ({ egressProxy }, use) => {
    await use({ server: egressProxy.url, bypass: 'localhost' });
  },

  egressAttempts: async ({ egressProxy }, use) => {
    egressProxy.attempts.length = 0;
    await use(egressProxy.attempts);
  },

  // Playwright requires an object pattern as the first fixture argument.
  // eslint-disable-next-line no-empty-pattern
  externalRequests: async ({}, use) => {
    await use([]);
  },

  context: async (
    { context, baseURL, externalRequests, egressAttempts, externalRequestGuard },
    use,
  ) => {
    const origin = new URL(baseURL ?? 'http://localhost').origin;
    const isExternal = (url: URL) =>
      !['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== origin;
    const record = (url: string) => {
      if (!externalRequests.includes(url)) externalRequests.push(url);
    };

    // Covers page, popup and (in Chromium) service-worker requests.
    await context.route(isExternal, (route) => {
      record(route.request().url());
      return route.abort('blockedbyclient');
    });
    // WebSockets bypass HTTP routing; close them before they connect.
    await context.routeWebSocket(
      (url) => isExternal(new URL(url.href.replace(/^ws/, 'http'))),
      (ws) => {
        record(ws.url());
        return ws.close();
      },
    );
    // Backstop: anything that reaches the network layer without a route.
    context.on('request', (request) => {
      if (isExternal(new URL(request.url()))) record(request.url());
    });

    await use(context);

    // Close pages and give requests fired during unload time to arrive, so they are counted too.
    await Promise.all(context.pages().map((page) => page.close()));
    if (externalRequestGuard === 'fail') await new Promise((r) => setTimeout(r, UNLOAD_SETTLE_MS));
    const violations = guardViolations(externalRequestGuard, externalRequests, egressAttempts);
    if (violations.length > 0) throw new Error(violations.join('\n'));
  },
});

export { expect } from '@playwright/test';
