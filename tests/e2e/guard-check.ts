export type GuardMode = 'fail' | 'record';

/**
 * Decides whether the external-request guard fails a test. Pure, so it is
 * unit-tested directly (tests/unit/guard-check.test.ts).
 */
export function guardViolations(
  mode: GuardMode,
  externalRequests: readonly string[],
  egressAttempts: readonly string[],
): string[] {
  if (mode === 'record') return [];
  return [
    ...externalRequests.map((url) => `request outside the app origin: ${url}`),
    ...egressAttempts.map((target) => `connection refused by the egress proxy: ${target}`),
  ];
}
