/**
 * Resolves an app-relative path against the deployment base path
 * (for example /agentscope/ on GitHub Pages), so links, fetches and
 * the service worker never escape the site's scope.
 */
export function appUrl(path: string, base: string = import.meta.env.BASE_URL): string {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return prefix + path.replace(/^\/+/, '');
}
