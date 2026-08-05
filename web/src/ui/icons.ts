/**
 * Icons.
 *
 * ## Why so few
 *
 * An icon earns its place when it is faster to recognise than its label, or
 * when it replaces a label that would otherwise crowd the screen. Everywhere
 * else it is decoration that costs legibility — and this app is read from two
 * metres away, on a phone, mid-movement.
 *
 * So: the tab bar, where icons are the convention and the labels alone read as
 * a row of links; the two chrome buttons where the icon *is* the whole control;
 * and the setup checklist, where a tick has to be unmistakable at a glance.
 *
 * Nothing on the workout HUD. The design is explicit that one number and one
 * colour carry the signal there, and an icon would be a third thing competing
 * for the same attention.
 *
 * ## Why hand-drawn rather than a library
 *
 * Seven icons is not worth a dependency, and a webfont or sprite sheet would be
 * one more asset on the path to a working rep counter offline. Drawn as simple
 * stroked paths so they hold up at 20 px and inherit `currentColor` — the tab
 * bar needs them to change colour with their label, which a bitmap could not do.
 */

const NS = 'http://www.w3.org/2000/svg';

/** Stroked paths, drawn on a 24×24 grid. */
const PATHS: Record<string, string[]> = {
  // Dumbbell: two end weights and a bar.
  latihan: ['M6.5 6.5v11', 'M3.5 9.5v5', 'M17.5 6.5v11', 'M20.5 9.5v5', 'M6.5 12h11'],
  // Bars of increasing height — the history screen is charts.
  riwayat: ['M5 21v-7', 'M12 21V8', 'M19 21v-11'],
  // Leaf.
  gizi: ['M20 4c0 8.5-5.2 13-12 13H5.5C5.5 8.5 10.7 4 17.5 4H20z', 'M4 21c2.5-5.5 6.5-9.2 12-11.5'],
  // Sliders, not a gear: far more legible at 20 px than eight tiny teeth.
  pengaturan: ['M4 8h3', 'M13 8h7', 'M4 16h9', 'M19 16h1'],
  kembali: ['M15 5l-7 7 7 7'],
  chevron: ['M6 15l6-6 6 6'],
  centang: ['M5 12.5l4.5 4.5L19 7.5'],
  info: ['M12 11.5v5', 'M12 7.8v.01'],
};

/** Icons that also need a circle drawn around them. */
const RINGED = new Set(['pengaturan', 'info']);

/** Circle centres for the ringed sliders, drawn as knobs on the tracks. */
const KNOBS: Record<string, [cx: number, cy: number, r: number][]> = {
  pengaturan: [
    [10, 8, 2.6],
    [16, 16, 2.6],
  ],
  info: [[12, 12, 9]],
};

export type IconName = keyof typeof PATHS;

/**
 * Build an icon element.
 *
 * Constructed node by node rather than assigned as markup: `dom.ts` sets text
 * through text nodes precisely so nothing in this app ever parses a string as
 * HTML, and one exception is how that stops being true.
 */
export function icon(name: IconName, size = 22, strokeWidth = 1.9): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative in every current use: each icon sits beside its own label, or on
  // a button that already carries an aria-label.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');

  if (RINGED.has(name)) {
    for (const [cx, cy, r] of KNOBS[name] ?? []) {
      const circle = document.createElementNS(NS, 'circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', String(r));
      svg.append(circle);
    }
  }

  for (const d of PATHS[name] ?? []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }

  return svg;
}

export function hasIcon(name: string): name is IconName {
  return name in PATHS;
}
