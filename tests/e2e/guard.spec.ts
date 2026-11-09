import { expect, test } from './fixtures';

// These tests prove the external-request guard sees each kind of request.
// They run in 'record' mode and assert on exactly what was blocked.
test.use({ externalRequestGuard: 'record' });

test('blocks fetch and image requests from the page', async ({ page, externalRequests }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    await fetch('https://example.com/fetch').catch(() => undefined);
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = 'https://example.com/image.png';
    });
  });
  expect(externalRequests).toEqual(['https://example.com/fetch', 'https://example.com/image.png']);
});

test('blocks WebSockets', async ({ page, externalRequests }) => {
  await page.goto('./');
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const ws = new WebSocket('wss://example.com/socket');
        ws.onclose = ws.onerror = resolve;
      }),
  );
  expect(externalRequests).toEqual(['wss://example.com/socket']);
});

test('blocks popups', async ({ page, context, externalRequests }) => {
  await page.goto('./');
  const popup = context.waitForEvent('page');
  await page.evaluate(() => window.open('https://example.com/popup'));
  await (await popup).waitForLoadState().catch(() => undefined);
  expect(externalRequests).toEqual(['https://example.com/popup']);
});

test('blocks requests from a service worker', async ({ page, context, externalRequests }) => {
  // Serve a same-origin test service worker that fetches an external URL on install.
  await context.route('**/__guard-test-sw.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "self.addEventListener('install', (e) => e.waitUntil(fetch('https://example.org/sw').catch(() => {})));",
    }),
  );
  await page.goto('./');
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.register('./__guard-test-sw.js', { scope: './' });
    const worker = reg.installing ?? reg.waiting ?? reg.active;
    if (worker && worker.state !== 'activated') {
      await new Promise((resolve) => worker.addEventListener('statechange', resolve));
    }
    await reg.unregister();
  });
  await expect.poll(() => externalRequests).toEqual(['https://example.org/sw']);
});

test('blocks requests fired while the page unloads', async ({ page, egressAttempts }) => {
  await page.goto('./');
  await page.evaluate(() =>
    window.addEventListener('pagehide', () => navigator.sendBeacon('https://example.com/beacon')),
  );
  await page.reload();
  // Playwright cannot see this request; the egress proxy refuses and records it.
  await expect.poll(() => egressAttempts).toEqual(['example.com:443']);
});
