/**
 * Does the markup still have every element the code demands?
 *
 * `main.ts` resolves elements by selector and throws when one is missing, which
 * is the right behaviour — but it happens at startup, in the browser, on a
 * blank page. TypeScript cannot catch it: an interface field and a
 * `required('#id')` call can agree perfectly while the element itself has been
 * deleted from the HTML.
 *
 * That is not hypothetical. Reworking the HUD to the design removed `#target`
 * and `#phase` from `index.html`; the interface and `main.ts` still matched
 * each other, `tsc` was clean, every unit test passed, and the app would have
 * crashed before the first frame.
 *
 * Parsing the HTML with a regex rather than a DOM: the only question is whether
 * an id literal is present, and that is a text question.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

function idsIn(html: string): Set<string> {
  return new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
}

/** Selectors passed to `required(...)`, which throws when unmatched. */
function requiredSelectors(source: string): string[] {
  return [...source.matchAll(/required(?:<[^>]+>)?\('([^']+)'\)/g)].map((m) => m[1]);
}

const PAGES: [entry: string, html: string][] = [['src/main.ts', 'index.html']];

/** Every screen the router can land on must exist as a section. */
const SCREENS = [
  'beranda',
  'pilih',
  'kamera',
  'latihan',
  'umpanbalik',
  'ringkasan',
  'gizi',
  'riwayat',
  'pengaturan',
];

describe.each(PAGES)('%s against %s', (entry, htmlPath) => {
  const source = read(entry);
  const html = read(htmlPath);
  const ids = idsIn(html);

  it('requires at least one element', () => {
    expect(requiredSelectors(source).length).toBeGreaterThan(0);
  });

  it('every required id exists in the markup', () => {
    const missing = requiredSelectors(source)
      .filter((selector) => /^#[\w-]+$/.test(selector))
      .map((selector) => selector.slice(1))
      .filter((id) => !ids.has(id));

    expect(missing, `${htmlPath} is missing: ${missing.join(', ')}`).toEqual([]);
  });

  it('every required compound selector names an element that exists', () => {
    // e.g. '#nutritionForm button[type="submit"]' — check the id part at least.
    const missing = requiredSelectors(source)
      .filter((selector) => selector.includes(' '))
      .map((selector) => selector.split(' ')[0])
      .filter((head) => head.startsWith('#') && !ids.has(head.slice(1)));

    expect(missing).toEqual([]);
  });
});

describe('screens', () => {
  const html = read('index.html');
  const main = read('src/main.ts');

  it('has a section for every screen the router registers', () => {
    const declared = new Set(
      [...html.matchAll(/data-screen="([^"]+)"/g)].map((m) => m[1]),
    );
    const missing = SCREENS.filter((name) => !declared.has(name));
    expect(missing, `no <section data-screen> for: ${missing.join(', ')}`).toEqual([]);
  });

  it('registers a handler for every section', () => {
    // A section with no handler renders but never populates — it would show
    // the empty markup and look broken rather than fail.
    const declared = [...html.matchAll(/data-screen="([^"]+)"/g)].map((m) => m[1]);
    for (const name of declared) {
      expect(main.includes(`${name}:`), `no screen handler for "${name}"`).toBe(true);
    }
  });

  it('has a tab target for every tab button', () => {
    const declared = new Set(
      [...html.matchAll(/data-screen="([^"]+)"/g)].map((m) => m[1]),
    );
    for (const [, tab] of html.matchAll(/data-tab="([^"]+)"/g)) {
      expect(declared.has(tab), `tab "${tab}" has no screen`).toBe(true);
    }
  });
});

describe('workout HUD', () => {
  const html = read('index.html');
  const css = read('src/style.css');

  it('carries every element the 1b layout needs', () => {
    for (const id of ['hud', 'hudWash', 'movementLabel', 'repStrips', 'repCount', 'repCaption']) {
      expect(idsIn(html).has(id), `#${id}`).toBe(true);
    }
  });

  it('starts in the good state', () => {
    // The count is sage until a rule fires. Shipping it amber would mean the
    // screen claims a fault before the first repetition.
    expect(html).toMatch(/data-state="good"/);
  });

  it('styles every class the renderer toggles', () => {
    // A toggled class with no rule behind it fails silently: the state changes
    // and nothing on screen does.
    for (const cls of ['hud__strip--done', 'hud__wash--correction']) {
      expect(css.includes(`.${cls}`), `.${cls} has no rule`).toBe(true);
    }
    expect(css).toMatch(/\.hud\[data-state='correction'\]/);
  });

  it('keeps the count and the caption in the lower third', () => {
    // The design's central claim: mid push-up the gaze falls to the bottom of
    // the screen, so the number goes where the eyes already are.
    expect(css).toMatch(/\.hud__readout\s*\{[^}]*bottom:/);
  });
});
