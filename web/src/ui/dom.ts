/**
 * Small DOM helpers shared by the screens.
 *
 * `el()` sets `textContent`, never `innerHTML`. Several screens render strings
 * that came from a language model or from the TKPI table; going through the
 * text node means none of it can ever be parsed as markup, without anyone
 * having to remember to escape.
 */

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

/**
 * Fail loudly at startup rather than with a null deref deep in a handler.
 *
 * Defaults to `HTMLElement`, not `Element`: nearly every caller then sets
 * `hidden`, `dataset`, or `style`, and defaulting to the narrower type made
 * each one need an explicit parameter for no benefit.
 */
export function required<T extends Element = HTMLElement>(
  selector: string,
  scope: ParentNode = document,
): T {
  const found = scope.querySelector<T>(selector);
  if (!found) throw new Error(`Missing required element: ${selector}`);
  return found;
}

const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const MONTH_NAMES = [
  'Januari',
  'Februari',
  'Maret',
  'April',
  'Mei',
  'Juni',
  'Juli',
  'Agustus',
  'September',
  'Oktober',
  'November',
  'Desember',
];

/** "Senin, 4 Agustus" — written out rather than left to a locale that may be absent. */
export function formatDate(at: number): string {
  const d = new Date(at);
  return `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
}

/** "Sen, 4 Agu" — for chart axes and dense list rows. */
export function formatDateShort(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}

export function greetingFor(at: number): string {
  const hour = new Date(at).getHours();
  if (hour < 11) return 'Selamat pagi';
  if (hour < 15) return 'Selamat siang';
  if (hour < 19) return 'Selamat sore';
  return 'Selamat malam';
}

export const EXERCISE_NAMES: Record<string, string> = {
  pushup: 'Push-up',
  squat: 'Squat',
  plank: 'Plank',
};
