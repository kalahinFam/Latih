/**
 * Service worker registration.
 *
 * Registered in production builds only. In development a worker caching the
 * shell fights Vite's hot reload, and the resulting "my edit did nothing"
 * confusion costs more time than the offline testing it would enable — the
 * offline path is verified against a preview build instead.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      // A failed registration costs offline support, not the app. Report it and
      // carry on rather than taking the whole page down.
      console.warn('Service worker registration failed', error);
    });
  });
}
