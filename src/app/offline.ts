/**
 * Offline support, page side (01-architecture.yaml deployment offline_mechanics and
 * 02-ui-ux.yaml layout offline_indicator): registers the build's service worker for
 * the base path and, once the active worker confirms a complete cache, shows the quiet
 * "Available offline." note at the end of the header's simulated statement.
 */
import { appUrl } from '../base.ts';

export const OFFLINE_TEXT = 'Available offline.';
/** Must equal STATUS_MESSAGE in src/offline/sw.js. */
export const STATUS_MESSAGE = 'agentscope:offline-status';
const STATUS_TIMEOUT_MS = 10_000;

let indicator: HTMLElement | undefined;
let ready = false;

/**
 * The indicator, one element for the whole session so each re-rendered header can
 * take it over; empty and hidden until the build is cached.
 */
export function offlineIndicator(): HTMLElement {
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'offline-status';
    render(indicator);
  }
  return indicator;
}

function render(node: HTMLElement): void {
  node.hidden = !ready;
  // A separate sentence after the simulated statement.
  node.textContent = ready ? ` ${OFFLINE_TEXT}` : '';
}

function markReady(): void {
  ready = true;
  if (indicator) render(indicator);
}

/** Asks the active worker whether every precached file is in its cache. */
function confirmComplete(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), STATUS_TIMEOUT_MS);
    channel.port1.onmessage = (event: MessageEvent<{ type?: string; ready?: boolean }>) => {
      clearTimeout(timer);
      resolve(event.data.type === STATUS_MESSAGE && event.data.ready === true);
    };
    worker.postMessage({ type: STATUS_MESSAGE }, [channel.port2]);
  });
}

/** Resolves true once the worker is activated, false if it becomes redundant first. */
export function activated(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        worker.removeEventListener('statechange', check);
        resolve(worker.state === 'activated');
      }
    };
    worker.addEventListener('statechange', check);
    check();
  });
}

/**
 * Registers the service worker and reports readiness. Does nothing where service
 * workers cannot run (insecure origins, browsers without support); failures stay quiet,
 * as the app works online all the same.
 */
export async function enableOffline(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    await navigator.serviceWorker.register(appUrl('sw.js'), { scope: appUrl('') });
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active;
    if (worker && (await activated(worker)) && (await confirmComplete(worker))) markReady();
  } catch {
    // Registration or caching failed: no indicator.
  }
}
