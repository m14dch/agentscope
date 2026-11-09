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

const fetchWithTimeout = (url: string) =>
  fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });

let problems: string[] = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  problems = await checkDeployment(pageUrl, fetchWithTimeout, expectVersion);
  if (problems.length === 0) {
    console.log(`OK: ${pageUrl} and all referenced assets load.`);
    process.exit(0);
  }
  if (attempt < attempts) {
    console.log(`Attempt ${attempt}/${attempts}: ${problems.join('; ')}. Retrying in 10 s.`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
console.error(problems.join('\n'));
process.exit(1);
