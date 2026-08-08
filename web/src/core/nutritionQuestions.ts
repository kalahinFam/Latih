/**
 * The questions the assistant offers alongside the text field.
 *
 * ## Why a catalogue at all, when typing works
 *
 * The endpoint answers from retrieved TKPI rows and refuses when it finds none,
 * so a typed question has a failure the user cannot see coming: "apa yang
 * sebaiknya kumakan malam ini" retrieves nothing and comes back as a refusal.
 * That refusal is the honest answer, but it is a poor first impression, and an
 * empty box is a poor first screen.
 *
 * Every question here names a food that is in the table, so a suggestion can
 * never dead-end. `test/nutritionQuestions.test.ts` puts every question the
 * catalogue can produce through the real retriever against the real table — a
 * suggestion that cannot be answered fails the build rather than the user.
 * Typing stays for everything the catalogue does not cover, which is most of
 * the 1.144 rows.
 *
 * ## Why the follow-ups come from the answer
 *
 * The rows a question actually cited are the ones known to exist, so building
 * the next question from them keeps the guarantee without a second catalogue.
 * It is also the shape a conversation has: you ask about tempe, then about its
 * calories, then how it compares to tahu.
 *
 * Pure functions. No storage, no DOM, no network.
 */

import type { ChatContext } from './nutritionChat.ts';

/**
 * Foods the questions are built from.
 *
 * Short nouns rather than full TKPI names ("Tempe kedelai murni, mentah"): the
 * retriever matches on distinctive tokens, and a question a person would
 * actually say out loud is worth more here than an exact row title. Each one is
 * checked against the real table in the test.
 */
const TOPICS = [
  'tempe',
  'tahu',
  'telur ayam',
  'nasi',
  'daging ayam',
  'ikan tongkol',
  'susu kedelai',
  'kangkung',
  'pisang',
  'kentang',
] as const;

/** Pairs worth comparing — same role in a meal, different composition. */
const COMPARISONS: [string, string][] = [
  ['tempe', 'tahu'],
  ['telur ayam', 'daging ayam'],
  ['nasi', 'kentang'],
  ['susu kedelai', 'telur ayam'],
];

/**
 * How many to show at once.
 *
 * Four rather than five now that the text field is back: these are a way in,
 * not the way in, and a long list pushes the field off a short screen.
 */
export const MAX_SUGGESTIONS = 4;

function proteinQuestion(topic: string): string {
  return `Berapa protein ${topic}?`;
}

function energyQuestion(topic: string): string {
  return `Berapa kalori ${topic}?`;
}

function comparisonQuestion(a: string, b: string): string {
  return `${a} atau ${b}, lebih tinggi proteinnya?`;
}

/**
 * A question that only makes sense once the daily target exists.
 *
 * It still names a food, because the target alone retrieves nothing — the
 * number is context for the answer, not a substitute for the rows.
 */
function targetQuestion(topic: string): string {
  return `100 gram ${topic} menyumbang berapa banyak ke target proteinku?`;
}

/** Deduplicate, drop what has already been asked, and cap the list. */
function take(candidates: string[], asked: readonly string[]): string[] {
  const seen = new Set(asked.map((question) => question.toLowerCase()));
  const chosen: string[] = [];

  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(candidate);
    if (chosen.length === MAX_SUGGESTIONS) break;
  }

  return chosen;
}

/**
 * The opening menu.
 *
 * `seed` rotates which foods appear so the panel is not identical on every
 * visit; it is passed in rather than read from a clock so the tests are not
 * hostage to the minute they run in.
 */
export function openingQuestions(context: ChatContext = {}, seed = 0): string[] {
  const offset = Math.abs(Math.trunc(seed)) % TOPICS.length;
  const rotated = [...TOPICS.slice(offset), ...TOPICS.slice(0, offset)];
  const [a, b] = COMPARISONS[Math.abs(Math.trunc(seed)) % COMPARISONS.length];

  const candidates = [
    proteinQuestion(rotated[0]),
    energyQuestion(rotated[1]),
    comparisonQuestion(a, b),
    ...(context.proteinG === undefined ? [] : [targetQuestion(rotated[0])]),
    proteinQuestion(rotated[2]),
    energyQuestion(rotated[3]),
  ];

  return take(candidates, []);
}

export interface FollowUpInput {
  /** The question just answered. */
  question: string;
  /** Names of the rows that answer cited, in the order they were cited. */
  citedNames: readonly string[];
  /** Everything asked so far, so nothing is offered twice. */
  asked: readonly string[];
  context?: ChatContext;
  seed?: number;
}

/**
 * What to offer next.
 *
 * Built from the rows the last answer actually cited, which are by definition
 * rows that exist. When there were none — the assistant said it had no data —
 * this falls back to the opening menu rather than offering a follow-up about
 * nothing.
 */
export function followUpQuestions(input: FollowUpInput): string[] {
  const { question, citedNames, asked, context = {}, seed = 0 } = input;

  if (citedNames.length === 0) return take(openingQuestions(context, seed + 1), asked);

  // The primary row, as the user would say it: TKPI names carry qualifiers
  // ("Tahu, mentah") that read badly in a question.
  const subject = shortName(citedNames[0]);
  const other = citedNames.length > 1 ? shortName(citedNames[1]) : null;
  const askedAboutProtein = /protein/i.test(question);

  const candidates = [
    // The other half of the same row: asked about protein, offer energy.
    askedAboutProtein ? energyQuestion(subject) : proteinQuestion(subject),
    other ? comparisonQuestion(subject, other) : comparisonQuestion(subject, altTopic(subject)),
    ...(context.proteinG === undefined ? [] : [targetQuestion(subject)]),
    // One way out of the current topic, so the conversation is not a loop.
    ...openingQuestions(context, seed + 1),
  ];

  return take(candidates, asked);
}

/** "Tahu, mentah" → "tahu". The qualifier is the table's, not the question's. */
export function shortName(name: string): string {
  return name.split(',')[0].trim().toLowerCase();
}

/** Something to compare against when the answer cited only one row. */
function altTopic(subject: string): string {
  return TOPICS.find((topic) => !subject.includes(topic) && !topic.includes(subject)) ?? 'tahu';
}

/** Every question the catalogue can produce, for the test that checks them all. */
export function allCatalogueQuestions(): string[] {
  const questions: string[] = [];
  for (const topic of TOPICS) {
    questions.push(proteinQuestion(topic), energyQuestion(topic), targetQuestion(topic));
  }
  for (const [a, b] of COMPARISONS) questions.push(comparisonQuestion(a, b));
  return questions;
}
