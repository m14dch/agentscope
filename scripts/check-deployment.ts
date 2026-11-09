/**
 * Usage: node scripts/check-deployment.ts <page-url> [attempts]
 * Checks a deployed site (see deployment-check.ts). Retries while the CDN
 * may still be serving the previous version, then exits non-zero on problems.
 */
import { checkDeployment } from './deployment-check.ts';

const [pageUrl, attemptsArg = '6'] = process.argv.slice(2);
if (!pageUrl) {
  console.error('Usage: node scripts/check-deployment.ts <page-url> [attempts]');
  process.exit(2);
}

const attempts = Number(attemptsArg);
let problems: string[] = [];
for (let attempt = 1; attempt <= attempts; attempt++) {
  problems = await checkDeployment(pageUrl, (url) => fetch(url, { cache: 'no-store' }));
  if (problems.length === 0) {
    console.log(`OK: ${pageUrl} and all referenced assets load.`);
    process.exit(0);
  }
  if (attempt < attempts) {
    console.log(
      `Attempt ${attempt}/${attempts} found ${problems.length} problem(s); retrying in 10 s.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
console.error(problems.join('\n'));
process.exit(1);
