/**
 * Normalizes a deployment base path to a leading and trailing slash
 * ('agentscope' → '/agentscope/', '/' stays '/'). Empty, relative ('./') and
 * full-URL values are errors, because they would silently produce wrong URLs.
 */
export function normalizeBase(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('Base path must not be empty; use "/" for a root site.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('.')) {
    throw new Error(`Base path must be an absolute path such as "/agentscope/", got "${raw}".`);
  }
  const inner = trimmed.replace(/^\/+|\/+$/g, '');
  return inner === '' ? '/' : `/${inner}/`;
}

/**
 * Resolves an app-relative path against the deployment base path
 * (for example /agentscope/ on GitHub Pages), so links, fetches and
 * the service worker never escape the site's scope.
 */
export function appUrl(path: string, base: string = import.meta.env.BASE_URL): string {
  return normalizeBase(base) + path.replace(/^\/+/, '');
}
