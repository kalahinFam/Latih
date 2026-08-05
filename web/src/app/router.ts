/**
 * Hash router.
 *
 * ## Why a router at all, in an app that had none
 *
 * The product is a workout flow — home, pick a movement, set the camera, train,
 * read the feedback, start the next set — and the camera must survive every one
 * of those transitions. A multi-page site tears down the page on each
 * navigation, which means tearing down `getUserMedia` and re-initialising
 * MediaPipe: several seconds of black screen, in the middle of a set, on the
 * step where the user is already lying on the floor waiting.
 *
 * So the screens share one document and this swaps between them. Hash routing
 * rather than the History API because the app is served as static files and
 * deep links must resolve without server rewrites.
 *
 * `parseHash` and `formatRoute` are pure and tested directly; the DOM lives
 * behind them.
 */

export interface Route {
  name: string;
  params: Record<string, string>;
}

export const DEFAULT_ROUTE = 'beranda';

/**
 * `#/nama?a=1` -> `{ name: 'nama', params: { a: '1' } }`.
 *
 * Anything unrecognised resolves to the default rather than throwing: a stale
 * bookmark or a hand-edited hash should land on the home screen, not a blank
 * one.
 */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  if (raw.length === 0) return { name: DEFAULT_ROUTE, params: {} };

  const [path, query = ''] = raw.split('?');
  const name = path.split('/')[0];
  const params: Record<string, string> = {};

  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key, value = ''] = pair.split('=');
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(value);
  }

  return { name: name || DEFAULT_ROUTE, params };
}

export function formatRoute(name: string, params: Record<string, string> = {}): string {
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return query ? `#/${name}?${query}` : `#/${name}`;
}

export interface Screen {
  /** Called every time the screen becomes visible. */
  enter?(params: Record<string, string>): void;
  /** Called when leaving. Use to stop timers and release the camera. */
  leave?(): void;
}

export class Router {
  private readonly screens: Map<string, Screen>;
  private readonly onChange: (route: Route) => void;
  private current: string | null = null;

  constructor(screens: Record<string, Screen>, onChange: (route: Route) => void) {
    this.screens = new Map(Object.entries(screens));
    this.onChange = onChange;
  }

  start(): void {
    window.addEventListener('hashchange', this.handle);
    this.handle();
  }

  go(name: string, params: Record<string, string> = {}): void {
    const next = formatRoute(name, params);
    if (window.location.hash === next) {
      // Same hash fires no event, but a screen may still need re-entering —
      // "start another set" navigates to the workout screen from itself.
      this.handle();
      return;
    }
    window.location.hash = next;
  }

  private handle = (): void => {
    const route = parseHash(window.location.hash);
    const known = this.screens.has(route.name) ? route.name : DEFAULT_ROUTE;

    if (this.current !== null && this.current !== known) {
      this.screens.get(this.current)?.leave?.();
    }

    this.current = known;
    this.screens.get(known)?.enter?.(route.params);
    this.onChange({ ...route, name: known });
  };
}
