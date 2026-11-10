/**
 * Checks a deployed page: the page, every script and link it references, the asset
 * manifest, the service worker and every file the manifest lists must load (HTTP 200),
 * every listed file's bytes must match its integrity digest, every reference and listed
 * file must stay under the page's base path (other origins included), and, when an expected version is given, the page's
 * <meta name="agentscope-version"> and the manifest's version must match it.
 * Returns a list of problems; an empty list means the deployment is healthy.
 * Network errors become problems.
 */
import { integrity, MANIFEST_FILE, SERVICE_WORKER_FILE } from './vite-offline.ts';

export type Fetch = (
  url: string,
) => Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

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

/** A problem with one URL; with a digest, its bytes must match it (else the file is stale). */
async function problemWith(
  fetchFn: Fetch,
  url: string,
  digest?: string,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(url);
    if (response.status !== 200) return `${url} returned ${response.status}`;
    if (digest === undefined) return undefined;
    const actual = integrity(new Uint8Array(await response.arrayBuffer()));
    return actual === digest ? undefined : `${url} does not match its integrity digest (stale)`;
  } catch (error) {
    return `${url} failed: ${describeError(error)}`;
  }
}

type Manifest = { version: string; files: { path: string; integrity: string }[] };

function parseManifest(text: string): Manifest | undefined {
  try {
    const value = JSON.parse(text) as Partial<Manifest>;
    const valid =
      typeof value.version === 'string' &&
      Array.isArray(value.files) &&
      value.files.every(
        (file) =>
          typeof file === 'object' &&
          file !== null &&
          typeof file.path === 'string' &&
          typeof file.integrity === 'string',
      );
    return valid ? (value as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

/** Fetches the asset manifest; returns its problems and its files' URLs with their digests. */
async function manifestFiles(
  base: URL,
  fetchFn: Fetch,
  expectedVersion: string | undefined,
): Promise<{ problems: string[]; files: Map<string, string> }> {
  const url = new URL(MANIFEST_FILE, base).href;
  const failed = (problem: string) => ({ problems: [problem], files: new Map<string, string>() });
  let text: string;
  try {
    const response = await fetchFn(url);
    if (response.status !== 200) return failed(`${url} returned ${response.status}`);
    text = await response.text();
  } catch (error) {
    return failed(`${url} failed: ${describeError(error)}`);
  }
  const manifest = parseManifest(text);
  if (!manifest) return failed(`${url} is not a valid asset manifest`);
  const problems =
    expectedVersion !== undefined && manifest.version !== expectedVersion
      ? [`asset manifest version is ${manifest.version}, expected ${expectedVersion}`]
      : [];
  const files = new Map(manifest.files.map((f) => [new URL(f.path, base).href, f.integrity]));
  return { problems, files };
}

/** The page's HTML, or the problem that kept it from loading. */
async function loadPage(page: URL, fetchFn: Fetch): Promise<{ html?: string; problem?: string }> {
  try {
    const response = await fetchFn(page.href);
    if (response.status !== 200) return { problem: `${page.href} returned ${response.status}` };
    return { html: await response.text() };
  } catch (error) {
    return { problem: `${page.href} failed: ${describeError(error)}` };
  }
}

export async function checkDeployment(
  pageUrl: string,
  fetchFn: Fetch,
  expectedVersion?: string,
): Promise<string[]> {
  const page = new URL(pageUrl);
  const basePath = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;
  const base = new URL(basePath, page);

  // The page and the manifest in parallel, then everything they reference in parallel,
  // so one attempt takes at most about two request timeouts.
  const [loaded, listed] = await Promise.all([
    loadPage(page, fetchFn),
    manifestFiles(base, fetchFn, expectedVersion),
  ]);
  if (loaded.html === undefined) return [loaded.problem ?? `${page.href} failed`];
  const html = loaded.html;

  const problems: string[] = [];
  if (expectedVersion !== undefined) {
    const version = pageVersion(html);
    if (version !== expectedVersion) {
      problems.push(`page version is ${version ?? 'missing'}, expected ${expectedVersion}`);
    }
  }
  problems.push(...listed.problems);
  const toFetch = new Set<string>([new URL(SERVICE_WORKER_FILE, base).href]);
  for (const url of [...referencedUrls(html, page.href), ...listed.files.keys()]) {
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
  const results = await Promise.all(
    [...toFetch].map((url) => problemWith(fetchFn, url, listed.files.get(url))),
  );
  return [...problems, ...results.filter((problem): problem is string => problem !== undefined)];
}
