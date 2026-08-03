import { describe, expect, it } from 'vitest';
import {
  extractClaims,
  numbersInQuestion,
  parseIndonesianNumber,
  verifyGrounding,
} from './grounding.ts';

describe('parseIndonesianNumber', () => {
  it('reads a comma as the decimal separator', () => {
    // Reading this the English way yields 208 and every check fails.
    expect(parseIndonesianNumber('20,8')).toBe(20.8);
  });

  it('reads grouped periods as thousands separators', () => {
    expect(parseIndonesianNumber('1.200')).toBe(1200);
    expect(parseIndonesianNumber('12.345')).toBe(12345);
  });

  it('handles both separators together', () => {
    expect(parseIndonesianNumber('1.234,5')).toBe(1234.5);
  });

  it('treats a lone period as a decimal point', () => {
    // Sources are not consistent, and 20.8 is unambiguous in intent.
    expect(parseIndonesianNumber('20.8')).toBe(20.8);
  });

  it('reads plain integers', () => {
    expect(parseIndonesianNumber('201')).toBe(201);
  });

  it('rejects non-numeric text', () => {
    expect(parseIndonesianNumber('tempe')).toBeNull();
    expect(parseIndonesianNumber('')).toBeNull();
  });
});

describe('extractClaims', () => {
  it('finds a value with its unit', () => {
    const claims = extractClaims('Tempe mengandung 20,8 gram protein.');
    expect(claims).toHaveLength(1);
    expect(claims[0].normalized).toBe(20.8);
  });

  it('finds several claims in one answer', () => {
    const claims = extractClaims('Energinya 201 kkal dengan protein 20,8 g dan lemak 8,8 gram.');
    expect(claims.map((c) => c.normalized)).toEqual([201, 20.8, 8.8]);
  });

  it('converts milligrams to grams so comparisons share a scale', () => {
    expect(extractClaims('Kalsium 155 mg.')[0].normalized).toBeCloseTo(0.155, 6);
  });

  it('ignores bare numbers with no unit', () => {
    // Counts and ordinals are not composition claims. Checking them would
    // reject correct answers for saying "dua", and the team would switch the
    // verifier off.
    expect(extractClaims('Ada 2 bahan yang cocok untuk kamu.')).toHaveLength(0);
  });

  it('does not treat the g inside a word as a unit', () => {
    expect(extractClaims('Kamu makan 3 gula merah kecil.')).toHaveLength(0);
  });

  it('accepts a value written without a space before the unit', () => {
    expect(extractClaims('protein 20,8g')[0].normalized).toBe(20.8);
  });
});

describe('verifyGrounding', () => {
  // Energi, protein, lemak, karbo — plus 100, the per-100 g basis every TKPI
  // row is stated on. The basis is part of the data, so an answer saying
  // "per 100 gram" is quoting the table, not inventing a figure.
  const rows = [201, 20.8, 8.8, 13.5, 100];

  it('passes an answer built only from the retrieved rows', () => {
    const result = verifyGrounding('Tempe: 201 kkal, protein 20,8 gram.', rows);
    expect(result.passed).toBe(true);
    expect(result.groundedRatio).toBe(1);
  });

  it('fails an answer containing a number that is not in the table', () => {
    // The failure the whole module exists to catch: a plausible figure the
    // model produced from memory rather than from the data it was given.
    const result = verifyGrounding('Tempe: 201 kkal, protein 34 gram.', rows);
    expect(result.passed).toBe(false);
    expect(result.unmatched.map((c) => c.normalized)).toEqual([34]);
  });

  it('accepts a sensibly rounded figure', () => {
    // Saying "21 gram" for 20.8 is fair; demanding exactness would reject
    // answers that are entirely correct.
    expect(verifyGrounding('protein 21 gram', rows).passed).toBe(true);
  });

  it('rejects a figure rounded far enough to be a different claim', () => {
    expect(verifyGrounding('protein 25 gram', rows).passed).toBe(false);
  });

  it('allows a quantity the user themselves specified', () => {
    const result = verifyGrounding(
      'Untuk 150 gram tempe, proteinnya sekitar 20,8 gram per 100 gram.',
      rows,
      numbersInQuestion('berapa protein 150 gram tempe'),
    );
    expect(result.passed).toBe(true);
  });

  it('still rejects an invented figure in a question that had numbers', () => {
    const result = verifyGrounding(
      'Untuk 150 gram tempe, proteinnya 31,2 gram.',
      rows,
      numbersInQuestion('berapa protein 150 gram tempe'),
    );
    // 31.2 is 150g worth of protein — arithmetic the model must not do
    // silently, because nothing verifies it.
    expect(result.passed).toBe(false);
  });

  it('treats an answer with no figures as grounded', () => {
    const result = verifyGrounding('Data untuk bahan itu belum tersedia.', rows);
    expect(result.passed).toBe(true);
    expect(result.claims).toHaveLength(0);
    expect(result.groundedRatio).toBe(1);
  });

  it('reports a partial ratio when some claims fail', () => {
    const result = verifyGrounding('201 kkal, protein 20,8 g, lemak 45 g.', rows);
    expect(result.passed).toBe(false);
    expect(result.groundedRatio).toBeCloseTo(2 / 3, 5);
  });

  it('accepts a claim within the tolerance band of an allowed value', () => {
    // Recorded deliberately: any figure inside the band is accepted, so a
    // wrong claim that lands next to a real one passes. The band has to be
    // wide enough for fair rounding, which means it cannot also be narrow
    // enough to catch a near-miss. This is the trade, stated rather than
    // discovered later.
    expect(verifyGrounding('lemak 99 g', rows).passed).toBe(true); // 100 +/- 1
    expect(verifyGrounding('lemak 97 g', rows).passed).toBe(false);
  });

  it('matches a milligram claim against a gram value', () => {
    expect(verifyGrounding('serat 1400 mg', [1.4]).passed).toBe(true);
  });

  it('scales tolerance with magnitude', () => {
    // 1% of 1200 is 12, so 1.208 kkal is a fair rendering of 1.200.
    expect(verifyGrounding('total 1.208 kkal', [1200]).passed).toBe(true);
    expect(verifyGrounding('total 1.400 kkal', [1200]).passed).toBe(false);
  });
});

describe('numbersInQuestion', () => {
  it('collects the figures a user wrote', () => {
    expect(numbersInQuestion('protein 150 gram tempe dan 2 butir telur')).toEqual([150, 2]);
  });

  it('returns nothing for a question with no figures', () => {
    expect(numbersInQuestion('berapa protein tempe')).toEqual([]);
  });
});
