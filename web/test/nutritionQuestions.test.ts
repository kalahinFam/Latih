/**
 * Every offered question must be answerable.
 *
 * The assistant does not take typing, so this catalogue *is* the interface. A
 * question whose foods are not in the shipped TKPI table would retrieve
 * nothing, and the endpoint would answer "bahan itu belum ada di data" — a
 * dead end the user cannot route around by rephrasing, because rephrasing is
 * not offered.
 *
 * Run against the real table and the real retriever, in `test/` rather than
 * `src/` for the reason the meal tests are: this reads a file from disk, which
 * is what the endpoint does and what the browser build must never do.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  MAX_SUGGESTIONS,
  allCatalogueQuestions,
  followUpQuestions,
  openingQuestions,
  shortName,
} from '../src/core/nutritionQuestions.ts';
import { findFoodsForQuestion, type TkpiTable } from '../src/core/tkpi.ts';

const table: TkpiTable = JSON.parse(
  readFileSync(new URL('../../data/tkpi/tkpi.json', import.meta.url), 'utf8'),
);

function retrieves(question: string): boolean {
  return findFoodsForQuestion(table, question).length > 0;
}

/**
 * Is any retrieved row actually about this subject?
 *
 * Word by word rather than as a phrase: the table writes chicken meat as
 * "Ayam, daging, segar" while a person says "daging ayam", and a substring
 * check would call that a miss.
 */
function covers(question: string, subject: string): boolean {
  const words = subject.toLowerCase().split(/\s+/).filter(Boolean);
  return findFoodsForQuestion(table, question).some((food) => {
    const name = food.name.toLowerCase();
    return words.every((word) => name.includes(word));
  });
}

describe('the offered questions', () => {
  it('every catalogue question retrieves at least one real row', () => {
    const dead = allCatalogueQuestions().filter((question) => !retrieves(question));
    expect(dead, `no TKPI row behind: ${dead.join(' | ')}`).toEqual([]);
  });

  it('every opening set is answerable, whichever rotation is showing', () => {
    for (let seed = 0; seed < 12; seed += 1) {
      const questions = openingQuestions({ proteinG: 120 }, seed);
      expect(questions.length).toBeGreaterThan(0);
      expect(questions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);

      const dead = questions.filter((question) => !retrieves(question));
      expect(dead, `seed ${seed}: ${dead.join(' | ')}`).toEqual([]);
    }
  });

  it('retrieves both sides of a comparison, not just the stronger match', () => {
    // Ranked over the whole question, tahu took every slot and the answer came
    // back saying the table did not include tempe — for a question the app
    // itself had offered. Each side gets its own rows now.
    const question = 'tempe atau tahu, lebih tinggi proteinnya?';
    expect(covers(question, 'tempe'), 'tempe missing').toBe(true);
    expect(covers(question, 'tahu'), 'tahu missing').toBe(true);
  });

  it('covers both sides of every comparison it offers', () => {
    for (const question of allCatalogueQuestions()) {
      if (!question.includes(' atau ')) continue;
      const [left, right] = question.split(' atau ');
      const subject = right.split(',')[0].trim().toLowerCase();
      expect(covers(question, left.toLowerCase()), `${question}: ${left}`).toBe(true);
      expect(covers(question, subject), `${question}: ${subject}`).toBe(true);
    }
  });

  it('builds follow-ups from the rows the answer cited', () => {
    const follow = followUpQuestions({
      question: 'Berapa protein tempe?',
      citedNames: ['Tempe pasar', 'Tahu, mentah'],
      asked: ['Berapa protein tempe?'],
      context: { proteinG: 120 },
    });

    // Asked about protein, so the obvious next question is the energy.
    expect(follow[0]).toBe('Berapa kalori tempe pasar?');
    const dead = follow.filter((question) => !retrieves(question));
    expect(dead, dead.join(' | ')).toEqual([]);
  });

  it('never offers a question that has already been asked', () => {
    const asked = ['Berapa protein tempe?', 'Berapa kalori tempe pasar?'];
    const follow = followUpQuestions({
      question: 'Berapa protein tempe?',
      citedNames: ['Tempe pasar'],
      asked,
    });

    for (const question of follow) {
      expect(asked.map((a) => a.toLowerCase())).not.toContain(question.toLowerCase());
    }
  });

  it('falls back to the opening menu when the answer cited nothing', () => {
    // The assistant said it had no data. A follow-up about that non-topic
    // would be a second dead end on top of the first.
    const follow = followUpQuestions({ question: 'Berapa protein X?', citedNames: [], asked: [] });
    expect(follow.length).toBeGreaterThan(0);
    expect(follow.filter((question) => !retrieves(question))).toEqual([]);
  });

  it('drops the table qualifier a person would not say', () => {
    expect(shortName('Tahu, mentah')).toBe('tahu');
    expect(shortName('Tempe pasar')).toBe('tempe pasar');
  });

  it('only offers the target question once a target exists', () => {
    const withTarget = openingQuestions({ proteinG: 120 }, 0).join(' ');
    const without = openingQuestions({}, 0).join(' ');

    expect(withTarget).toContain('target proteinku');
    // Without a profile there is no target to compare against, and the answer
    // would have nothing to say about it.
    expect(without).not.toContain('target proteinku');
  });
});
