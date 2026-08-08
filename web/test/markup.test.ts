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

import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Every module that resolves an element, not only the entry.
 *
 * `main.ts` was the original list, but the screens moved out of it and took
 * their `required('#id')` calls with them — which meant a control could be
 * deleted from the markup while its screen still demanded it, and nothing here
 * would notice until the screen was opened in a browser.
 */
const PAGES: [entry: string, html: string][] = [
  ['src/main.ts', 'index.html'],
  ...readdirSync(new URL('src/ui/screens/', root))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file): [string, string] => [`src/ui/screens/${file}`, 'index.html']),
];

/** Every screen the router can land on must exist as a section. */
const SCREENS = [
  'mulai',
  'onboarding',
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

describe('icons', () => {
  const html = read('index.html');
  const icons = read('src/ui/icons.ts');

  it('every data-icon slot names an icon that exists', () => {
    // An unknown name is skipped silently at runtime, leaving an empty button
    // — a control with nothing in it, which reads as broken rather than
    // missing.
    const declared = [...icons.matchAll(/^  (\w+): \[/gm)].map((m) => m[1]);
    const used = [...html.matchAll(/data-icon="([^"]+)"/g)].map((m) => m[1]);

    expect(used.length).toBeGreaterThan(0);
    const unknown = used.filter((name) => !declared.includes(name));
    expect(unknown, `no path defined for: ${unknown.join(', ')}`).toEqual([]);
  });

  it('leaves the workout HUD alone', () => {
    // The design gives one number and one colour the job of carrying the
    // signal there. An icon would be a third thing competing for it.
    const workout = html.slice(
      html.indexOf('data-screen="latihan"'),
      html.indexOf('data-screen="umpanbalik"'),
    );
    expect(workout).not.toContain('data-icon');
  });

  it('gives every icon-only button an accessible name', () => {
    for (const [tag] of html.matchAll(/<button[^>]*data-icon="[^"]*"[^>]*>\s*<\/button>/g)) {
      expect(tag, `icon-only button without aria-label: ${tag}`).toMatch(/aria-label=/);
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

describe('motion', () => {
  const css = read('src/style.css');

  /** Properties whose animation forces the browser to re-run layout. */
  const LAYOUT_PROPS = ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding'];

  /**
   * The one place a layout-animating transition is allowed.
   *
   * The summary screen has the camera off, so a reflow there competes with
   * nothing.
   */
  const LAYOUT_EXEMPT = ['.meter__fill'];

  it('animates nothing on the layout path except the documented exception', () => {
    // This app runs pose estimation at ~30 fps on a mid-range phone. A
    // transition that reflows during a set competes with MediaPipe for the same
    // frame budget, and what suffers is the rep count.
    const offenders: string[] = [];

    for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = match[1].trim().split('\n').pop()!.trim();
      const block = match[2];
      if (!/transition(-property)?\s*:/.test(block)) continue;
      if (LAYOUT_EXEMPT.some((exempt) => selector.includes(exempt))) continue;

      const declaration = /transition(?:-property)?\s*:([^;]*)/.exec(block)?.[1] ?? '';
      for (const prop of LAYOUT_PROPS) {
        if (new RegExp(`\b${prop}\b`).test(declaration)) {
          offenders.push(`${selector} transitions ${prop}`);
        }
      }
    }

    expect(offenders, offenders.join('; ')).toEqual([]);
  });

  it('lets the reader turn all of it off', () => {
    // Not a nicety: small movement is genuinely unpleasant with a vestibular
    // disorder, and the setting exists so people say so once rather than per
    // app.
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('declares no keyframes nothing uses', () => {
    const declared = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);

    for (const name of declared) {
      // Once for the @keyframes, at least once more for a rule that plays it.
      const uses = css.split(name).length - 1;
      expect(uses, `@keyframes ${name} is never played`).toBeGreaterThan(1);
    }
  });

  it('replays the onboarding slide only when the step changes', () => {
    // Onboarding re-renders on every tap — picking a sex, a goal, a chip — not
    // only when the step advances. Stamping the animation class at the end of
    // `render` therefore slid the whole page sideways each time somebody chose
    // an option, which is how this shipped and how it was reported.
    //
    // The animation says "this is a different question". A selection within the
    // same question is not that, so the stamp has to sit behind a step guard.
    const source = read('src/ui/screens/onboardingScreen.ts');
    const stamp = source.indexOf("classList.add('onboard__step')");
    expect(stamp, 'the step slide is gone').toBeGreaterThan(-1);

    const guard = source.lastIndexOf('step !== animatedStep', stamp);
    expect(guard, 'the slide is stamped without a step-change guard').toBeGreaterThan(
      source.indexOf('function render('),
    );
  });

  it('adds no motion to the workout HUD beyond the count and the voice dot', () => {
    // The design gives one number and one colour the job of carrying the signal
    // there. A third moving thing would compete for the attention those need.
    const animated = [...css.matchAll(/(\.hud[^{}]*)\{([^}]*animation:[^}]*)\}/g)].map((m) =>
      m[1].trim(),
    );

    for (const selector of animated) {
      expect(
        selector.includes('hud__dot') || selector.includes('hud__count'),
        `unexpected animation on ${selector}`,
      ).toBe(true);
    }
  });
});
