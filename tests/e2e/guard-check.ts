export type GuardMode = 'fail' | 'record';

/**
 * Decides whether the external-request guard fails a test. Pure, so it is
 * unit-tested directly (tests/unit/guard-check.test.ts).
 */
export function guardViolations(
  mode: GuardMode,
  externalRequests: readonly string[],
  egressAttempts: readonly string[],
  runtimeRequests: readonly string[] = [],
): string[] {
  if (mode === 'record') return [];
  return [
    ...externalRequests.map((url) => `request outside the app origin: ${url}`),
    ...egressAttempts.map((target) => `connection refused by the egress proxy: ${target}`),
    ...runtimeRequests.map((url) => `runtime API request (not a file of the build): ${url}`),
  ];
}

/**
 * Whether a same-origin URL is a file of the build: the base URL, sw.js, the
 * asset manifest or a file it lists (08-acceptance-tests.yaml runtime_api_requests_rule).
 * Anything else the app requests from its own origin counts as a runtime API request.
 */
export function isBuildFile(url: URL, base: string, files: readonly string[]): boolean {
  if (url.search !== '' || !url.pathname.startsWith(base)) return false;
  const path = url.pathname.slice(base.length);
  return path === '' || path === 'sw.js' || path === 'asset-manifest.json' || files.includes(path);
}
