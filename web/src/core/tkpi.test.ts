import { describe, expect, it } from 'vitest';
import {
  allowedValuesFor,
  auditTable,
  findFoods,
  formatForPrompt,
  hasUnverified,
  normalizeName,
  tokenize,
  type TkpiFood,
  type TkpiTable,
} from './tkpi.ts';

function food(overrides: Partial<TkpiFood> = {}): TkpiFood {
  return {
    code: 'X-01',
    name: 'Tempe kedelai murni',
    aliases: ['tempe'],
    basisG: 100,
    energyKcal: 201,
    proteinG: 20.8,
    fatG: 8.8,
    carbG: 13.5,
    fiberG: 1.4,
    source: 'test',
    verified: true,
    ...overrides,
  };
}

const table: TkpiTable = {
  meta: { source: 'test', note: '', retrievedAt: '2026-01-01' },
  foods: [
    food(),
    food({ code: 'X-02', name: 'Tahu', aliases: ['tahu putih'], energyKcal: 80, proteinG: 10.9, fatG: 4.7, carbG: 0.8, fiberG: 0.1 }),
    food({ code: 'X-03', name: 'Telur ayam', aliases: ['telur'], energyKcal: 154, proteinG: 12.4, fatG: 10.8, carbG: 0.7, fiberG: undefined }),
    food({ code: 'X-04', name: 'Dada ayam tanpa kulit', aliases: ['dada ayam'], energyKcal: 165, proteinG: 31, fatG: 3.6, carbG: 0, fiberG: undefined }),
  ],
};

describe('normalizeName and tokenize', () => {
  it('folds case and punctuation', () => {
    expect(normalizeName('Tempe Kedelai, Murni!')).toBe('tempe kedelai murni');
  });

  it('drops question words that carry no signal', () => {
    expect(tokenize('berapa protein dalam tempe')).toEqual(['tempe']);
  });

  it('drops bare numbers, which name nothing', () => {
    expect(tokenize('kalori 150 gram nasi')).toEqual(['nasi']);
  });
});

describe('findFoods', () => {
  it('finds a food by its common alias', () => {
    expect(findFoods(table, 'berapa protein tempe')[0].food.code).toBe('X-01');
  });

  it('finds a food by its full name', () => {
    expect(findFoods(table, 'kandungan gizi dada ayam tanpa kulit')[0].food.code).toBe('X-04');
  });

  it('returns nothing when the question names no food in the table', () => {
    // Must return empty rather than a weak match: with no rows the endpoint
    // skips the model entirely, which is how a fabricated figure is avoided.
    expect(findFoods(table, 'berapa protein daging unta')).toHaveLength(0);
  });

  it('returns nothing for a question with only stopwords', () => {
    expect(findFoods(table, 'berapa kalori dalam porsi itu')).toHaveLength(0);
  });

  it('finds several foods in a comparison question', () => {
    const found = findFoods(table, 'lebih tinggi protein tempe atau tahu');
    expect(found.map((m) => m.food.code)).toEqual(expect.arrayContaining(['X-01', 'X-02']));
  });

  it('caps how many rows it returns', () => {
    // Every extra row widens the set of numbers the verifier accepts, which
    // weakens the guarantee the pipeline exists to provide.
    expect(findFoods(table, 'tempe tahu telur ayam', 2)).toHaveLength(2);
  });

  it('ranks the better match first', () => {
    const found = findFoods(table, 'telur');
    expect(found[0].food.code).toBe('X-03');
  });
});

describe('allowedValuesFor', () => {
  it('includes the per-100 g basis', () => {
    // Answers legitimately say "per 100 gram"; omitting the basis would make
    // the verifier reject correct answers for quoting the table's own units.
    expect(allowedValuesFor([food()])).toContain(100);
  });

  it('includes every macronutrient figure', () => {
    const values = allowedValuesFor([food()]);
    for (const expected of [201, 20.8, 8.8, 13.5, 1.4]) {
      expect(values).toContain(expected);
    }
  });

  it('omits fibre when the row has none', () => {
    const values = allowedValuesFor([food({ fiberG: undefined })]);
    expect(values).not.toContain(undefined as never);
    expect(values.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('formatForPrompt', () => {
  it('states the basis, so the model is not left to assume it', () => {
    expect(formatForPrompt([food()])).toContain('per 100 gram');
  });

  it('includes the food code, making the citation traceable', () => {
    expect(formatForPrompt([food()])).toContain('X-01');
  });
});

describe('hasUnverified', () => {
  it('flags rows that no human has checked', () => {
    expect(hasUnverified([food({ verified: false })])).toBe(true);
    expect(hasUnverified([food({ verified: true })])).toBe(false);
  });
});

describe('auditTable', () => {
  it('accepts rows whose macros reconstruct their energy', () => {
    expect(auditTable(table).implausible).toHaveLength(0);
  });

  it('flags a row whose energy contradicts its macros', () => {
    // The signature of a transcription slip, and far cheaper to catch here
    // than inside an answer being judged.
    const broken: TkpiTable = {
      ...table,
      foods: [food({ code: 'BAD', energyKcal: 500, proteinG: 1, fatG: 1, carbG: 1 })],
    };
    expect(auditTable(broken).implausible[0].code).toBe('BAD');
  });

  it('flags a basis that is not 100 g', () => {
    const broken: TkpiTable = { ...table, foods: [food({ code: 'B', basisG: 50 })] };
    expect(auditTable(broken).implausible.some((r) => r.code === 'B')).toBe(true);
  });

  it('flags duplicate food codes', () => {
    const dupes: TkpiTable = { ...table, foods: [food(), food()] };
    expect(auditTable(dupes).duplicateCodes).toEqual(['X-01']);
  });

  it('counts how many rows are verified', () => {
    const mixed: TkpiTable = {
      ...table,
      foods: [food({ verified: true }), food({ code: 'Y', verified: false })],
    };
    const report = auditTable(mixed);
    expect(report.total).toBe(2);
    expect(report.verified).toBe(1);
  });
});
