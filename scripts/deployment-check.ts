/**
 * Checks a deployed page: the page and every script and link it references must
 * load (HTTP 200), every reference must stay under the page's base path (other
 * origins included), and, when an expected version is given, the page's
 * <meta name="agentscope-version"> must match it. Returns a list of problems;
 * an empty list means the deployment is healthy. Network errors become problems.
 */

export type Fetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

const REFERENCE =
  /<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const VERSION =
  /<meta\b[^>]*\bname\s*=\s*["']?agentscope-version["']?[^>]*\bcontent\s*=\s*["']?([^"'\s>]+)/i;

export function referencedUrls(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(REFERENCE)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) urls.add(new URL(value, pageUrl).href);
  }
  return [...urls];
}

export function pageVersion(html: string): string | undefined {
  return VERSION.exec(html)?.[1];
}

async function status(fetchFn: Fetch, url: string): Promise<number | string> {
  try {
    return (await fetchFn(url)).status;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function checkDeployment(
  pageUrl: string,
  fetchFn: Fetch,
  expectedVersion?: string,
): Promise<string[]> {
  const page = new URL(pageUrl);
  const basePath = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;

  let html: string;
  try {
    const response = await fetchFn(page.href);
    if (response.status !== 200) return [`${page.href} returned ${response.status}`];
    html = await response.text();
  } catch (error) {
    return [`${page.href} failed: ${error instanceof Error ? error.message : String(error)}`];
  }

  const problems: string[] = [];
  if (expectedVersion !== undefined) {
    const version = pageVersion(html);
    if (version !== expectedVersion) {
      problems.push(`page version is ${version ?? 'missing'}, expected ${expectedVersion}`);
    }
  }
  for (const url of referencedUrls(html, page.href)) {
    const target = new URL(url);
    if (target.protocol === 'data:') continue; // inline, no request
    if (target.origin !== page.origin) {
      problems.push(`${url} is outside the site's origin`);
    } else if (!target.pathname.startsWith(basePath)) {
      problems.push(`${url} is outside the base path ${basePath}`);
    } else {
      const result = await status(fetchFn, url);
      if (result !== 200) problems.push(`${url} returned ${result}`);
    }
  }
  return problems;
}
