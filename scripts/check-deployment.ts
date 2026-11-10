/**
 * Usage: node scripts/check-deployment.ts <page-url> [--expect-version <sha>] [--attempts <n>]
 * Checks a deployed site (see deployment-check.ts). Retries every 10 s while the
 * CDN may still serve the previous version or the network fails, then exits 1
 * with the remaining problems. Exits 2 on bad arguments.
 */
import { parseArgs } from 'node:util';
import { checkDeployment } from './deployment-check.ts';

const USAGE =
  'Usage: node scripts/check-deployment.ts <page-url> [--expect-version <sha>] [--attempts <n>]';

let pageUrl: string | undefined;
let expectVersion: string | undefined;
let attempts = Number.NaN;
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'expect-version': { type: 'string' }, attempts: { type: 'string', default: '6' } },
  });
  pageUrl = positionals.length === 1 ? positionals[0] : undefined;
  expectVersion = values['expect-version'];
  attempts = Number(values.attempts);
  if (pageUrl) new URL(pageUrl);
} catch {
  pageUrl = undefined;
}
if (!pageUrl || !Number.isInteger(attempts) || attempts < 1) {
  console.error(USAGE);
  process.exit(2);
}

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 10_000;
// Stays inside the CI job's 5-minute limit, so the final report always prints.
const DEADLINE_MS = 4 * 60_000;
// The page and the manifest in parallel, then all references and listed files in parallel.
const ATTEMPT_MAX_MS = 2 * REQUEST_TIMEOUT_MS;

const fetchWithTimeout = (url: string) =>
  fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
const started = Date.now();

let problems: string[] = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  problems = await checkDeployment(pageUrl, fetchWithTimeout, expectVersion);
  if (problems.length === 0) {
    console.log(`OK: ${pageUrl} and all referenced assets load.`);
    process.exit(0);
  }
  const nextAttemptEnds = Date.now() - started + RETRY_DELAY_MS + ATTEMPT_MAX_MS;
  if (attempt === attempts || nextAttemptEnds > DEADLINE_MS) break;
  console.log(`Attempt ${attempt}/${attempts}: ${problems.join('; ')}. Retrying in 10 s.`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}
console.error(problems.join('\n'));
process.exit(1);
