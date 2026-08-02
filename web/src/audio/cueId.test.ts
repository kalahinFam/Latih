import { describe, expect, it } from 'vitest';
import { cueFileName, cueHash, cueUrl } from './cueId.ts';
import { allCueTexts, CUE_TEXT, cueFor } from '../core/rules.ts';
import type { ExerciseKind, JointAngles } from '../core/types.ts';

describe('cueHash', () => {
  it('is stable for the same text', () => {
    expect(cueHash('Turun lebih dalam')).toBe(cueHash('Turun lebih dalam'));
  });

  it('changes when the text changes', () => {
    // The property the whole scheme rests on: a reworded cue must not resolve
    // to the old recording.
    expect(cueHash('Turun lebih dalam')).not.toBe(cueHash('Turun lebih dalam!'));
  });

  it('produces a fixed-width hex string', () => {
    for (const text of allCueTexts()) {
      expect(cueHash(text)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe('cueFileName', () => {
  it('keeps a readable prefix', () => {
    expect(cueFileName('Turun lebih dalam')).toMatch(/^turun-lebih-dalam-[0-9a-f]{8}\.mp3$/);
  });

  it('gives every cue a distinct file', () => {
    const names = allCueTexts().map(cueFileName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('strips punctuation and accents from the prefix', () => {
    expect(cueFileName('Angkat pinggul, jaga badan lurus')).toMatch(
      /^angkat-pinggul-jaga-badan-lurus-/,
    );
  });

  it('builds a URL under the cue directory', () => {
    expect(cueUrl('Turun lebih dalam')).toBe(`/cues/${cueFileName('Turun lebih dalam')}`);
  });
});

describe('cue coverage', () => {
  /** Every rule the evaluator can emit, per exercise. */
  const EXPECTED: Record<ExerciseKind, string[]> = {
    pushup: ['shallow_depth', 'partial_lockout', 'hip_sag', 'hip_pike'],
    squat: ['shallow_depth', 'partial_lockout', 'excessive_trunk_lean'],
  };

  it('has a phrase for every rule the evaluator can produce', () => {
    // A missing entry would make the app speak nothing while showing text —
    // the exact silent failure this test exists to prevent.
    for (const [exercise, codes] of Object.entries(EXPECTED)) {
      for (const code of codes) {
        const cue = cueFor(exercise as ExerciseKind, code as never);
        expect(cue, `${exercise}:${code}`).not.toBe('');
      }
    }
  });

  it('has no orphaned phrases', () => {
    const expected = new Set(
      Object.entries(EXPECTED).flatMap(([ex, codes]) => codes.map((c) => `${ex}:${c}`)),
    );
    for (const key of Object.keys(CUE_TEXT)) {
      expect(expected.has(key), `${key} tidak dipakai rule mana pun`).toBe(true);
    }
  });

  it('keeps every cue short enough to land inside a repetition', () => {
    for (const text of allCueTexts()) {
      expect(text.split(/\s+/).length, text).toBeLessThanOrEqual(6);
    }
  });
});

/*
 * Deliberately no filesystem check here.
 *
 * "Is the MP3 on disk" is a build concern, and asserting it would require Node
 * types in the web tsconfig — which exists without them precisely so browser
 * code cannot import a Node module by accident. `gen-cues.mjs` runs in
 * `prebuild`/`predev` instead, so an edited phrase regenerates automatically.
 */

/** Guards the assumption `cueFor` relies on: findings carry non-empty cues. */
describe('rule findings carry speakable text', () => {
  it('never emits a finding with an empty cue', async () => {
    const { evaluateRules } = await import('../core/rules.ts');
    const { RepWindowBuilder } = await import('../core/repWindow.ts');

    const blank: JointAngles = {
      elbowLeft: null,
      elbowRight: null,
      shoulderLeft: null,
      shoulderRight: null,
      hipLeft: null,
      hipRight: null,
      kneeLeft: null,
      kneeRight: null,
      trunkLean: null,
    };

    const builder = new RepWindowBuilder();
    for (let i = 0; i < 8; i++) {
      builder.push(i * 33, { ...blank, elbowLeft: 125, elbowRight: 125, hipLeft: 140, hipRight: 140 });
    }
    const window = builder.take({
      index: 1,
      startMs: 0,
      bottomMs: 100,
      endMs: 7 * 33,
      minAngle: 125,
      maxAngle: 140,
      eccentricMs: 100,
      concentricMs: 100,
    });

    const findings = evaluateRules('pushup', window);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.cue, finding.code).not.toBe('');
    }
  });
});
