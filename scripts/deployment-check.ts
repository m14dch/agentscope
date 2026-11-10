/**
 * Checks a deployed page: the page, every script and link it references, the asset
 * manifest, the service worker and every file the manifest lists must load (HTTP 200),
 * every reference and listed file must stay under the page's base path (other origins
 * included), and, when an expected version is given, the page's
 * <meta name="agentscope-version"> and the manifest's version must match it.
 * Returns a list of problems; an empty list means the deployment is healthy.
 * Network errors become problems.
 */
import { MANIFEST_FILE, SERVICE_WORKER_FILE } from './vite-offline.ts';

export type Fetch = (url: string) => Promise<{ status: number; text(): Promise<string> }>;

const REFERENCE =
  /<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const META = /<meta\b[^>]*>/gi;

export function referencedUrls(html: string, pageUrl: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(REFERENCE)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) urls.add(new URL(value, pageUrl).href);
  }
  return [...urls];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(
    tag,
  );
  return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

/** The content of <meta name="agentscope-version">, in any attribute order. */
export function pageVersion(html: string): string | undefined {
  for (const [tag] of html.matchAll(META)) {
    if (attribute(tag, 'name') === 'agentscope-version') return attribute(tag, 'content');
  }
  return undefined;
}

/** "fetch failed (ECONNREFUSED)": the message plus its underlying cause, if any. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  const detail =
    cause instanceof Error
      ? ((cause as Error & { code?: string }).code ?? cause.message)
      : undefined;
  return detail ? `${error.message} (${detail})` : error.message;
}

async function problemWith(fetchFn: Fetch, url: string): Promise<string | undefined> {
  try {
    const { status } = await fetchFn(url);
    return status === 200 ? undefined : `${url} returned ${status}`;
  } catch (error) {
    return `${url} failed: ${describeError(error)}`;
  }
}

type Manifest = { version: string; files: string[] };

function parseManifest(text: string): Manifest | undefined {
  try {
    const value = JSON.parse(text) as Partial<Manifest>;
    const valid =
      typeof value.version === 'string' &&
      Array.isArray(value.files) &&
      value.files.every((file) => typeof file === 'string');
    return valid ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** Fetches the asset manifest; returns its problems and the URLs it lists. */
async function manifestUrls(
  base: URL,
  fetchFn: Fetch,
  expectedVersion: string | undefined,
): Promise<{ problems: string[]; urls: string[] }> {
  const url = new URL(MANIFEST_FILE, base).href;
  let text: string;
  try {
    const response = await fetchFn(url);
    if (response.status !== 200)
      return { problems: [`${url} returned ${response.status}`], urls: [] };
    text = await response.text();
  } catch (error) {
    return { problems: [`${url} failed: ${describeError(error)}`], urls: [] };
  }
  const manifest = parseManifest(text);
  if (!manifest) return { problems: [`${url} is not a valid asset manifest`], urls: [] };
  const problems =
    expectedVersion !== undefined && manifest.version !== expectedVersion
      ? [`asset manifest version is ${manifest.version}, expected ${expectedVersion}`]
      : [];
  return { problems, urls: manifest.files.map((file) => new URL(file, base).href) };
}

export async function checkDeployment(
  pageUrl: string,
  fetchFn: Fetch,
  expectedVersion?: string,
): Promise<string[]> {
  const page = new URL(pageUrl);
  const basePath = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;
  const base = new URL(basePath, page);

  let html: string;
  try {
    const response = await fetchFn(page.href);
    if (response.status !== 200) return [`${page.href} returned ${response.status}`];
    html = await response.text();
  } catch (error) {
    return [`${page.href} failed: ${describeError(error)}`];
  }

  const problems: string[] = [];
  if (expectedVersion !== undefined) {
    const version = pageVersion(html);
    if (version !== expectedVersion) {
      problems.push(`page version is ${version ?? 'missing'}, expected ${expectedVersion}`);
    }
  }
  const listed = await manifestUrls(base, fetchFn, expectedVersion);
  problems.push(...listed.problems);
  const toFetch = new Set<string>([new URL(SERVICE_WORKER_FILE, base).href]);
  for (const url of [...referencedUrls(html, page.href), ...listed.urls]) {
    const target = new URL(url);
    if (target.protocol === 'data:') continue; // inline, no request
    if (target.origin !== page.origin) {
      problems.push(`${url} is outside the site's origin`);
    } else if (!target.pathname.startsWith(basePath)) {
      problems.push(`${url} is outside the base path ${basePath}`);
    } else {
      toFetch.add(url);
    }
  }
  // In parallel, so one attempt takes at most about two request timeouts.
  const results = await Promise.all([...toFetch].map((url) => problemWith(fetchFn, url)));
  return [...problems, ...results.filter((problem): problem is string => problem !== undefined)];
}
