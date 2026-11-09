/**
 * Checks a deployed page: the page and every same-origin script, stylesheet,
 * icon, preload and manifest it references must load (HTTP 200), and every
 * reference must stay under the page's base path. Returns a list of problems;
 * an empty list means the deployment is healthy.
 */

type Fetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

const REFERENCE = /<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi;

export function referencedUrls(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(REFERENCE)) {
    const value = match[1];
    if (value) urls.add(new URL(value, pageUrl).href);
  }
  return [...urls];
}

export async function checkDeployment(pageUrl: string, fetchFn: Fetch): Promise<string[]> {
  const page = new URL(pageUrl);
  const basePath = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;
  const response = await fetchFn(page.href);
  if (response.status !== 200) return [`${page.href} returned ${response.status}`];

  const problems: string[] = [];
  for (const url of referencedUrls(await response.text(), page.href)) {
    const target = new URL(url);
    if (target.origin !== page.origin) {
      problems.push(`${url} is outside the site's origin`);
    } else if (!target.pathname.startsWith(basePath)) {
      problems.push(`${url} is outside the base path ${basePath}`);
    } else {
      const status = (await fetchFn(url)).status;
      if (status !== 200) problems.push(`${url} returned ${status}`);
    }
  }
  return problems;
}
