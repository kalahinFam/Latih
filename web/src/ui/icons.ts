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
  // Home outline.
  beranda: ['M3.5 10.5L12 3.5l8.5 7', 'M5.5 9.5V21h13V9.5', 'M9.5 21v-6h5v6'],
  // Dumbbell: two end weights and a bar.
  latihan: ['M6.5 6.5v11', 'M3.5 9.5v5', 'M17.5 6.5v11', 'M20.5 9.5v5', 'M6.5 12h11'],
  // Bars of increasing height — the history screen is charts.
  riwayat: ['M5 21v-7', 'M12 21V8', 'M19 21v-11'],
  // Leaf.
  gizi: ['M20 4c0 8.5-5.2 13-12 13H5.5C5.5 8.5 10.7 4 17.5 4H20z', 'M4 21c2.5-5.5 6.5-9.2 12-11.5'],
  // Sliders, not a gear: far more legible at 20 px than eight tiny teeth.
  pengaturan: ['M4 8h3', 'M13 8h7', 'M4 16h9', 'M19 16h1'],
  kembali: ['M15 5l-7 7 7 7'],
  kamera: ['M3 8.5h3.2l1.6-2.2h8.4l1.6 2.2H21v10H3z'],
  gembok: ['M4.5 10.5h15v9.5h-15z', 'M8 10.5V7.6a4 4 0 0 1 8 0v2.9'],
  jam: ['M12 7.2V12l3.2 2'],
  chevron: ['M6 15l6-6 6 6'],
  centang: ['M5 12.5l4.5 4.5L19 7.5'],
  info: ['M12 11.5v5', 'M12 7.8v.01'],
};

/** Icons that also need a circle drawn around them. */
const RINGED = new Set(['pengaturan', 'info', 'kamera', 'jam']);

/** Circle centres for the ringed sliders, drawn as knobs on the tracks. */
const KNOBS: Record<string, [cx: number, cy: number, r: number][]> = {
  kamera: [[12, 13, 3.4]],
  jam: [[12, 12, 8.5]],
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

/** Product logo shipped as a public raster asset. */
export function logoImage(size = 96): HTMLImageElement {
  const image = document.createElement('img');
  image.src = '/logo.jpg';
  image.width = size;
  image.height = size;
  image.alt = '';
  image.decoding = 'async';
  image.className = 'logo-image';
  return image;
}

/* ---------------------------------------------------------------------- logo */

/**
 * The LATIH mark: a runner, and the constellation the pose estimator sees.
 *
 * Two forms, as the design uses it — full at the opening screen, and a 26 px
 * sign in the corner of every screen after. The small one drops the joint dots
 * and thickens the strokes, because at that size the dots merge into the lines
 * and the whole thing reads as a smudge.
 *
 * Drawn from paths rather than shipped as an SVG file for the same reason the
 * other icons are: it inherits nothing, needs no fetch, and cannot be the asset
 * that fails to load offline.
 */
const LOGO_FILLS: [d: string, fill: string][] = [
  [
    'M65.4048 100.47C72.3524 100.422 86.51 100.356 87.5594 100.47C87.9092 100.487 89.0655 96.7951 ' +
      '89.6 94.9466C81.5349 94.9466 61.4986 94.805 47.6229 94.805C39.0234 93.5305 35.4281 88.1019 ' +
      '34.9423 85.6C32.0272 102.594 48.2059 100.587 65.4048 100.47Z',
    '#4E8E7F',
  ],
  [
    'M46.9602 91.4543L89.6 91.6C88.7905 88.1042 85.601 86.6476 84.1074 86.3563C77.4103 86.2592 ' +
      '62.6863 86.065 57.3672 86.065C52.048 86.4146 51.5855 82.0351 52.0191 79.8017C55.8254 63.1483 ' +
      '63.3512 29.8122 63.0043 29.6957C62.5707 29.55 60.258 29.55 53.6091 29.8413C47.9431 31.1231 ' +
      '46.0447 35.3277 45.8038 37.2698C43.2021 47.7571 37.7974 70.7208 36.6977 78.6365C35.6859 ' +
      '85.9193 42.7684 91.163 46.9602 91.4543Z',
    '#151D28',
  ],
];

const LOGO_STROKES: [d: string, stroke: string][] = [
  ['M58.7 81.6L57.9125 77.925L68.4125 71.625L76.6812 61.9125L87.1812 67.1625L77.3375 73.8562L78.3875 77.1375', '#5CA892'],
  ['M76.6812 61.9125L85.8687 49.1812L91.3812 56.6625L98.3375 50.7562', '#549C89'],
  ['M85.8687 49.1812L76.1562 48.2625L68.4125 53.9062', '#4F9385'],
];

/** Joint dots, only drawn at full size. */
const LOGO_DOTS: [cx: number, cy: number, r: number][] = [
  [57.9125, 77.925, 1.3125],
  [77.3375, 73.725, 1.3125],
  [68.4125, 71.625, 1.3125],
  [87.05, 67.1625, 1.3125],
  [76.6812, 61.7812, 2.49375],
  [81.5375, 55.35, 1.3125],
  [91.5125, 56.4, 1.3125],
  [98.3375, 50.8875, 1.3125],
  [76.2875, 48.2625, 1.3125],
  [68.4125, 54.0375, 1.3125],
  [85.8687, 49.1812, 1.70625],
];

export function logoMark(size = 96, detailed = true): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '15.6 15.6 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'logo');

  for (const [d, fill] of LOGO_FILLS) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.append(path);
  }

  for (const [d, stroke] of LOGO_STROKES) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', stroke);
    // Thicker when small: a 2 px stroke on a 26 px mark disappears.
    path.setAttribute('stroke-width', detailed ? '2' : '3');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }

  // The largest dot is the head and stays at both sizes; the rest are the
  // constellation and only survive at full size.
  const dots = detailed ? LOGO_DOTS : [];
  for (const [cx, cy, r] of [...dots, [90.0687, 43.1437, detailed ? 3.54375 : 3.5] as const]) {
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    circle.setAttribute('fill', '#27474C');
    svg.append(circle);
  }

  return svg;
}
