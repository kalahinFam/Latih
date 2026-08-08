/**
 * The pantry: everyday Indonesian foods the meal suggester may choose from.
 *
 * ## Why a fixed list, and why by code
 *
 * The table has 1,133 usable rows and none of them fit in a prompt. Retrieval
 * by keyword, which works for a question about one food, is the wrong tool
 * here: there is no query to retrieve against, and a substring search for
 * "ayam" returns fried chicken from three restaurant chains before it reaches
 * plain chicken, while "tempe" returns nothing but crisps. A meal planner built
 * on that would quietly suggest a diet of snack food.
 *
 * So the shortlist is curated, and identified by TKPI code rather than by name.
 * Codes are stable; names are not, and a name-matched pantry would silently
 * pick up a different row the next time the table is refreshed. The test suite
 * asserts every code below resolves to a real, non-suspect row — a typo here
 * fails the build rather than shrinking the menu without anyone noticing.
 *
 * This list is an editorial choice and should be read as one. It leans towards
 * plain preparations because a suggestion is meant to be cooked, and towards
 * foods available in an ordinary Indonesian kitchen.
 */

import type { TkpiFood, TkpiTable } from './tkpi.ts';

export type PantryCategory =
  | 'pokok'
  | 'protein-hewani'
  | 'protein-nabati'
  | 'sayur'
  | 'buah'
  | 'lemak';

export const CATEGORY_LABELS: Record<PantryCategory, string> = {
  pokok: 'Makanan pokok',
  'protein-hewani': 'Protein hewani',
  'protein-nabati': 'Protein nabati',
  sayur: 'Sayur',
  buah: 'Buah',
  lemak: 'Minyak dan lemak',
};

/**
 * Typical serving ranges, in grams, offered to the model as guidance.
 *
 * Not enforcement — `MIN_PORTION_G` and `MAX_PORTION_G` do that. These exist
 * because a model given no anchor produces 300 g of cooking oil as readily as
 * 300 g of rice, and both are arithmetically valid.
 */
export const TYPICAL_PORTION_G: Record<PantryCategory, [number, number]> = {
  pokok: [75, 250],
  'protein-hewani': [50, 150],
  'protein-nabati': [50, 150],
  sayur: [50, 150],
  buah: [80, 200],
  lemak: [5, 15],
};

/** Portions outside this range are rejected regardless of what the model says. */
export const MIN_PORTION_G = 5;
export const MAX_PORTION_G = 500;

/**
 * Display names for the curated pantry, keyed by TKPI code.
 *
 * The web app is browser-only and never reads `tkpi.json` (the server does),
 * but the onboarding screen offers the pantry as a searchable picker, and the
 * picker has to show a name. These are the TKPI names with the English gloss
 * stripped off; the test suite asserts each one matches the shipped row, so a
 * rename in the table fails the build rather than quietly showing stale names.
 */
export const PANTRY_LABELS: Record<string, string> = {
  AP001: 'Nasi',
  AP005: 'Nasi beras merah',
  AP024: 'Roti putih',
  BR013: 'Kentang, segar',
  AP010: 'Jagung muda, rebus',
  BP075: 'Ubi Cilembu',
  HR002: 'Telur ayam ras, segar',
  FR005: 'Ayam, daging, segar',
  FR025: 'Sapi, daging, kurus, segar',
  GR070: 'Ikan tongkol, segar',
  GR050: 'Ikan oci, kembung, segar',
  GR084: 'Udang, segar',
  JR006: 'Susu sapi, segar',
  CP077: 'Tempe kedelai murni, mentah',
  CP061: 'Tahu, mentah',
  CP060: 'Susu kedelai',
  DR100: 'Kangkung, segar',
  DP001: 'Bayam, kukus',
  DR166: 'Wortel, segar',
  DR013: 'Buncis, segar',
  DR097: 'Kacang panjang, segar',
  DR141: 'Sawi, segar',
  ER074: 'Pisang ambon, segar',
  ER073: 'Pepaya, segar',
  ER004: 'Apel, segar',
  ER054: 'Mangga, segar',
  ER105: 'Semangka, segar',
  ER001: 'Alpukat, segar',
  KR011: 'Minyak kelapa',
  KR014: 'Minyak Zaitun',
};

export const PANTRY_CODES: Record<PantryCategory, string[]> = {
  pokok: [
    'AP001', // Nasi
    'AP005', // Nasi beras merah
    'AP024', // Roti putih
    'BR013', // Kentang, segar
    'AP010', // Jagung muda, rebus
    'BP075', // Ubi Cilembu
  ],
  'protein-hewani': [
    'HR002', // Telur ayam ras, segar
    'FR005', // Ayam, daging, segar
    'FR025', // Sapi, daging, kurus, segar
    'GR070', // Ikan tongkol, segar
    'GR050', // Ikan oci (kembung), segar
    'GR084', // Udang, segar
    'JR006', // Susu sapi, segar
  ],
  'protein-nabati': [
    'CP077', // Tempe kedelai murni, mentah
    'CP061', // Tahu, mentah
    'CP060', // Susu kedelai
  ],
  sayur: [
    'DR100', // Kangkung, segar
    'DP001', // Bayam, kukus
    'DR166', // Wortel, segar
    'DR013', // Buncis, segar
    'DR097', // Kacang panjang, segar
    'DR141', // Sawi, segar
  ],
  buah: [
    'ER074', // Pisang ambon, segar
    'ER073', // Pepaya, segar
    'ER004', // Apel, segar
    'ER054', // Mangga, segar
    'ER105', // Semangka, segar
    'ER001', // Alpukat, segar
  ],
  lemak: [
    'KR011', // Minyak kelapa
    'KR014', // Minyak zaitun
  ],
};

export interface PantryEntry {
  category: PantryCategory;
  food: TkpiFood;
}

/**
 * Resolve the pantry against a loaded table.
 *
 * Missing and suspect codes are dropped rather than throwing: a refreshed table
 * that retires one row should cost one ingredient, not the whole feature. The
 * test suite is what makes sure that stays an edge case instead of the norm.
 */
/**
 * @param excluded TKPI codes the user has ruled out.
 *
 * Removed here rather than mentioned in the prompt, because the onboarding
 * screen promises *"bahan yang dipilih tidak akan muncul di menu mana pun"* and
 * an instruction is not a guarantee. A model asked politely to avoid an
 * ingredient will avoid it most of the time, and most of the time is the wrong
 * standard for something someone cannot eat.
 */
export function pantryEntries(table: TkpiTable, excluded: readonly string[] = []): PantryEntry[] {
  const byCode = new Map(table.foods.map((food) => [food.code, food]));
  const blocked = new Set(excluded);
  const entries: PantryEntry[] = [];

  for (const [category, codes] of Object.entries(PANTRY_CODES) as [PantryCategory, string[]][]) {
    for (const code of codes) {
      if (blocked.has(code)) continue;
      const food = byCode.get(code);
      if (food && !food.suspect) entries.push({ category, food });
    }
  }

  return entries;
}

export function pantryFoods(table: TkpiTable, excluded: readonly string[] = []): TkpiFood[] {
  return pantryEntries(table, excluded).map((entry) => entry.food);
}

/** The pantry as the model sees it: names, codes, and per-100 g figures only. */
export function formatPantryForPrompt(table: TkpiTable, excluded: readonly string[] = []): string {
  const entries = pantryEntries(table, excluded);
  const sections: string[] = [];

  for (const category of Object.keys(PANTRY_CODES) as PantryCategory[]) {
    const foods = entries.filter((entry) => entry.category === category);
    if (foods.length === 0) continue;

    const [min, max] = TYPICAL_PORTION_G[category];
    sections.push(
      `${CATEGORY_LABELS[category]} (porsi lazim ${min}–${max} gram):\n` +
        foods
          .map(
            ({ food }) =>
              `  ${food.code} | ${food.name} | per ${food.basisG} g: ` +
              `${food.energyKcal} kkal, protein ${food.proteinG} g, ` +
              `lemak ${food.fatG} g, karbohidrat ${food.carbG} g`,
          )
          .join('\n'),
    );
  }

  return sections.join('\n\n');
}
