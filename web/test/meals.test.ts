/**
 * Integration tests for the meal pipeline, run against the real TKPI file.
 *
 * Outside `src/` on purpose. These read the shipped data from disk, which is
 * exactly what the endpoint does and exactly what the browser build must never
 * do — keeping them here lets `src/` stay typechecked as pure browser code
 * without loosening it to admit Node's APIs.
 *
 * Reading the real file rather than a fixture is the point: the pantry is a
 * list of TKPI codes, and a fixture would happily agree with codes that do not
 * exist in the data the product actually ships.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  BUDGET_TOLERANCE,
  MealRejectedError,
  buildOption,
  buildOptions,
  proteinCoverage,
  type ChosenOption,
} from '../src/core/meals.ts';
import { PANTRY_CODES, pantryEntries, formatPantryForPrompt } from '../src/core/pantry.ts';
import {
  allowedValuesForPortions,
  scaleToPortion,
  sumPortions,
  type TkpiTable,
} from '../src/core/tkpi.ts';
import { verifyGrounding } from '../src/core/grounding.ts';

const table: TkpiTable = JSON.parse(
  readFileSync(new URL('../../data/tkpi/tkpi.json', import.meta.url), 'utf8'),
);

describe('pantry', () => {
  it('resolves every curated code to a real row', () => {
    const byCode = new Map(table.foods.map((food) => [food.code, food]));
    const missing = Object.values(PANTRY_CODES)
      .flat()
      .filter((code) => !byCode.has(code));

    // A typo here would silently shrink the menu instead of failing.
    expect(missing).toEqual([]);
  });

  it('curates no row the grounding contract excludes', () => {
    const byCode = new Map(table.foods.map((food) => [food.code, food]));
    const suspect = Object.values(PANTRY_CODES)
      .flat()
      .filter((code) => byCode.get(code)?.suspect);

    expect(suspect).toEqual([]);
  });

  it('offers something from every category', () => {
    const entries = pantryEntries(table);
    for (const category of Object.keys(PANTRY_CODES)) {
      expect(entries.some((entry) => entry.category === category)).toBe(true);
    }
  });

  it('shows the model codes and per-100 g figures, nothing else', () => {
    const prompt = formatPantryForPrompt(table);
    expect(prompt).toContain('AP001');
    expect(prompt).toContain('Nasi');
    expect(prompt).toContain('porsi lazim');
  });
});

describe('scaleToPortion', () => {
  it('scales linearly from the 100 g basis', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const scaled = scaleToPortion(nasi, 200);

    expect(scaled.energyKcal).toBeCloseTo(nasi.energyKcal * 2, 1);
    expect(scaled.proteinG).toBeCloseTo(nasi.proteinG * 2, 1);
  });

  it('sums portions without drifting', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const telur = table.foods.find((f) => f.code === 'HR002')!;
    const total = sumPortions([
      { food: nasi, grams: 150 },
      { food: telur, grams: 60 },
    ]);

    const expected = nasi.energyKcal * 1.5 + telur.energyKcal * 0.6;
    expect(total.energyKcal).toBeCloseTo(expected, 0);
  });
});

function option(items: [string, number][], nama = 'Uji'): ChosenOption {
  return { nama, items: items.map(([code, grams]) => ({ code, grams })) };
}

describe('buildOption', () => {
  it('computes the total from the table, not from the model', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const telur = table.foods.find((f) => f.code === 'HR002')!;
    const expected = nasi.energyKcal * 1.5 + telur.energyKcal * 0.6;

    const built = buildOption(option([['AP001', 150], ['HR002', 60]]), table, Math.round(expected));
    expect(built.total.energyKcal).toBeCloseTo(expected, 0);
  });

  it('rejects a food outside the pantry', () => {
    // Substituting a lookalike would put an unvetted food on the menu.
    expect(() => buildOption(option([['ZZ999', 100]]), table, 500)).toThrow(MealRejectedError);
  });

  it('rejects an implausible portion', () => {
    expect(() => buildOption(option([['KR011', 900]]), table, 500)).toThrow(MealRejectedError);
    expect(() => buildOption(option([['AP001', 1]]), table, 500)).toThrow(MealRejectedError);
    expect(() => buildOption(option([['AP001', Number.NaN]]), table, 500)).toThrow(MealRejectedError);
  });

  it('rejects an empty option', () => {
    expect(() => buildOption({ nama: 'Kosong', items: [] }, table, 500)).toThrow(MealRejectedError);
  });

  it('rejects a selection that misses the budget', () => {
    // This is the failure the grounding verifier cannot see: every ingredient
    // is a real row, so every component number is traceable, and the total is
    // still wrong for the meal it claims to be.
    expect(() => buildOption(option([['AP001', 400], ['KR011', 40]]), table, 300)).toThrow(
      MealRejectedError,
    );
  });

  it('accepts a selection inside the tolerance', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const budget = Math.round(nasi.energyKcal * 1.5);
    const built = buildOption(option([['AP001', 150]]), table, budget);

    expect(Math.abs(built.budgetDeltaKcal)).toBeLessThanOrEqual(budget * BUDGET_TOLERANCE);
  });

  it('reports the signed distance from the budget', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const budget = Math.round(nasi.energyKcal * 1.5) + 20;
    expect(buildOption(option([['AP001', 150]]), table, budget).budgetDeltaKcal).toBeLessThan(0);
  });
});

describe('buildOptions', () => {
  it('keeps the good options and reports the bad ones', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const budget = Math.round(nasi.energyKcal * 1.5);

    const { options, rejected } = buildOptions(
      [option([['AP001', 150]], 'Baik'), option([['ZZ999', 100]], 'Buruk')],
      table,
      budget,
    );

    // Two workable options are useful; discarding them over a third is not.
    expect(options.map((o) => o.name)).toEqual(['Baik']);
    expect(rejected).toHaveLength(1);
  });
});

describe('grounding of a built meal', () => {
  it('accepts the totals this module computed', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const telur = table.foods.find((f) => f.code === 'HR002')!;
    const portions = [
      { food: nasi, grams: 150 },
      { food: telur, grams: 60 },
    ];
    const total = sumPortions(portions);

    const answer = `Menu ini sekitar ${total.energyKcal} kkal dengan protein ${total.proteinG} gram.`;
    expect(verifyGrounding(answer, allowedValuesForPortions(portions)).passed).toBe(true);
  });

  it('still rejects a total the model invented', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const portions = [{ food: nasi, grams: 150 }];

    const answer = 'Menu ini sekitar 999 kkal.';
    expect(verifyGrounding(answer, allowedValuesForPortions(portions)).passed).toBe(false);
  });
});

describe('proteinCoverage', () => {
  it('reports the share of the daily target covered', () => {
    const nasi = table.foods.find((f) => f.code === 'AP001')!;
    const built = buildOption(option([['AP001', 150]]), table, Math.round(nasi.energyKcal * 1.5));

    expect(proteinCoverage([built], 100)).toBeCloseTo(built.total.proteinG / 100, 2);
  });

  it('does not divide by zero when no target is set', () => {
    expect(proteinCoverage([], 0)).toBe(1);
  });
});
