/**
 * Deterministic form checks.
 *
 * ## The division of labour with the classifier
 *
 * Every rule here tests a *geometric threshold at a known moment* — is the hip
 * line straight at the bottom, did the knee reach parallel, did the elbow lock
 * out. These are exactly specifiable, need no training data, and can be
 * explained to a user in one sentence. Learning them would be strictly worse.
 *
 * What is deliberately absent: tempo collapse across a set, left-right
 * asymmetry, and knee valgus that only appears past a certain depth. Those are
 * temporal or compound patterns that no single-frame threshold expresses, and
 * they are what the classifier is for. The ablation study rests on this line
 * being drawn honestly — if the rules quietly covered everything, "rule+model"
 * could not beat "rule-only" and the three-loop design would be unjustified.
 *
 * ## Depth is not judged here
 *
 * It used to be: the counter credited anything past `downEnter` and a rule
 * flagged it as shallow afterwards, so a set of twelve half squats produced
 * twelve repetitions and twelve corrections. Depth is now the counter's
 * `creditMax` and nothing else — an attempt either reaches the bottom and
 * counts, or it does not and is reported as an uncounted attempt. One
 * threshold, one place, no ordering to keep straight.
 *
 * `shallow_depth` survives as an error code because it is still what an
 * uncounted attempt *is*, and what `liveCue` fires at the reversal. It is
 * simply no longer produced by `evaluateRules`.
 *
 * ## On thresholds
 *
 * The values below are seeded from the biomechanics of each movement, not
 * fitted to data. They are placeholders until annotation is done and get
 * re-tuned against labelled reps — at which point the tuning itself is a result
 * worth reporting, not a hidden constant.
 *
 * ## The invariant that makes these rules reachable
 *
 * Every threshold here must be reachable from a repetition the counter would
 * actually emit, because the rules only ever see those. A threshold on the
 * wrong side of a counter gate is unreachable code that still reads correctly
 * in isolation and still passes a unit test built from a synthetic window — it
 * simply never fires in the product. `rules.test.ts` asserts the relationships
 * against `DEFAULT_CONFIGS` directly.
 */

import type { ExerciseKind, JointAngles, MovementKind } from './types.ts';
import { reliableMean } from './angles.ts';
import { bottomFrames, extremeOf, medianOf, type RepWindow } from './repWindow.ts';

/** Stable identifiers — these are the classes the paper reports P/R/F1 for. */
export type RuleErrorCode =
  | 'shallow_depth'
  | 'partial_lockout'
  | 'hip_sag'
  | 'hip_pike'
  | 'excessive_trunk_lean';

/**
 * Every corrective phrase the fast loop can speak, keyed `exercise:code`.
 *
 * This is a *closed set*, and that is what makes instant audio possible: the
 * build pre-renders each phrase to an MP3, so a correction plays with zero
 * network latency. A cue that arrives 800 ms late is not a late cue, it is a
 * useless one — the repetition it described is already over.
 *
 * Single source of truth on purpose. The audio generator imports this map, so
 * adding a rule adds its clip, and editing a phrase invalidates the stale
 * recording rather than silently keeping it.
 */
export const CUE_TEXT: Record<string, string> = {
  'pushup:shallow_depth': 'Turunkan dada lebih dalam',
  'pushup:partial_lockout': 'Luruskan lengan sepenuhnya',
  'pushup:hip_sag': 'Angkat pinggul, jaga badan lurus',
  'pushup:hip_pike': 'Turunkan pinggul, jaga badan lurus',
  'squat:shallow_depth': 'Turun lebih dalam',
  'squat:partial_lockout': 'Berdiri tegak sepenuhnya',
  'squat:excessive_trunk_lean': 'Jaga dada tetap tegak',
  // Same line, judged the same way, so the same words — and therefore no extra
  // audio clip: `allCueTexts` deduplicates by phrase.
  'plank:hip_sag': 'Angkat pinggul, jaga badan lurus',
  'plank:hip_pike': 'Turunkan pinggul, jaga badan lurus',
};

export function cueFor(exercise: MovementKind, code: RuleErrorCode): string {
  // Falling back to the code would speak "hip_sag" aloud; an empty string is
  // caught by the generator's completeness test instead.
  return CUE_TEXT[`${exercise}:${code}`] ?? '';
}

/** Unique phrases, for the audio generator. */
export function allCueTexts(): string[] {
  return [...new Set(Object.values(CUE_TEXT))].sort();
}

export interface RuleFinding {
  code: RuleErrorCode;
  /** Short corrective phrase, spoken by the fast loop. */
  cue: string;
  /** The measured quantity that triggered the rule, degrees. */
  value: number;
  /** The threshold it failed against, degrees. */
  threshold: number;
  /**
   * How far past the threshold, normalised by a per-rule tolerance band.
   * 0 is right at the threshold, 1 is a full band beyond it. Lets the UI rank
   * findings without hard-coding which error "matters more".
   */
  severity: number;
}

interface Thresholds {
  /**
   * Absolute backstop for lockout — a rep peaking below this is short however
   * the rest of the set looked. Deliberately close to the counter's `upEnter`,
   * because the real check is the relative one below.
   */
  lockoutMin: number;
  /**
   * How far a rep may peak below the lifter's own best extension this set
   * before it counts as cut short.
   *
   * ## Why lockout is judged relatively
   *
   * A pose estimator does not read a locked joint as 180°. It reads it as
   * whatever the landmark placement gives, which depends on the person's build
   * and on the camera angle — the same lifter at 30° and at 45° oblique
   * produces different peaks for identical form. An absolute threshold
   * therefore measures the tracker as much as the lifter, and field testing
   * showed exactly that: "berdiri tegak sepenuhnya" and "luruskan lengan
   * sepenuhnya" firing on *every* repetition, which is a rule carrying no
   * information at all.
   *
   * Comparing each rep to the best the same person produced under the same
   * camera in the same set cancels that offset. What is left is the thing
   * actually worth flagging: reps getting shorter as the set goes on.
   */
  lockoutDropMax: number;
  /** Push-up only: hip angle band around straight (180 deg). */
  hipSagMin?: number;
  hipPikeMax?: number;
  /** Signed shoulder-hip-knee deviation: positive sag, negative pike. */
  hipSagDeviationMax?: number;
  hipPikeDeviationMax?: number;
  /** Squat only: trunk lean beyond this is excessive. */
  trunkLeanMax?: number;
  /** Width of the band used to normalise severity. */
  band: number;
}

export const DEFAULT_THRESHOLDS: Record<ExerciseKind, Thresholds> = {
  pushup: {
    // Elbow at the top. Counter gate is 158, so this only catches the narrow
    // band just above it — the relative rule does the real work.
    lockoutMin: 161,
    lockoutDropMax: 14,
    // Shoulder-hip-knee. A straight plank is ~180; sagging drops it.
    hipSagMin: 160,
    hipPikeMax: 200,
    hipSagDeviationMax: 20,
    hipPikeDeviationMax: 20,
    band: 25,
  },
  squat: {
    // Counter gate is 162.
    lockoutMin: 165,
    lockoutDropMax: 14,
    // Torso pitch from vertical. Some forward lean is correct in a squat;
    // beyond ~55 deg the load has shifted off the legs.
    trunkLeanMax: 55,
    band: 25,
  },
};

function severityOf(value: number, threshold: number, band: number, direction: 'above' | 'below') {
  const excess = direction === 'above' ? value - threshold : threshold - value;
  return Math.min(1, Math.max(0, excess / band));
}

// Prefers the better-observed side. Averaging a measured limb with an occluded
// one is what let partial squats read as deep enough to pass — see
// `reliableMean`.
function hipAngle(angles: JointAngles): number | null {
  const c = angles.confidence;
  return reliableMean(angles.hipLeft, angles.hipRight, c.hipLeft, c.hipRight);
}

/** Signed line deviation when the caller was built from current landmarks. */
function hipLineDeviation(angles: JointAngles): number | null | undefined {
  if (angles.hipLineLeft === undefined && angles.hipLineRight === undefined) return undefined;
  const c = angles.confidence;
  return reliableMean(
    angles.hipLineLeft ?? null,
    angles.hipLineRight ?? null,
    c.hipLeft,
    c.hipRight,
  );
}



/**
 * Evaluate the rules for one completed repetition.
 *
 * Returns every rule that fired, most severe first. An empty array means the
 * rep passed every deterministic check — not that the rep was perfect, since
 * the classifier judges what these rules cannot see.
 */
/** What the rules need to know about the set so far. */
export interface RuleContext {
  /**
   * Best peak extension observed earlier in this set, degrees.
   *
   * Undefined on the first repetition, which therefore has only the absolute
   * backstop to fail against — there is nothing yet to compare it to, and
   * inventing a reference would flag or excuse it arbitrarily.
   */
  bestLockoutDeg?: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export function evaluateRules(
  exercise: ExerciseKind,
  window: RepWindow,
  overrides: Partial<Thresholds> = {},
  context: RuleContext = {},
): RuleFinding[] {
  const t = { ...DEFAULT_THRESHOLDS[exercise], ...overrides };
  const bottom = bottomFrames(window);
  const findings: RuleFinding[] = [];

  // Lockout. maxAngle is the peak extension the counter observed at the top.
  const lockout = window.event.maxAngle;
  if (Number.isFinite(lockout)) {
    // Relative to this lifter's own best under this camera, with the absolute
    // value only as a backstop. See `lockoutDropMax`.
    const best = context.bestLockoutDeg;
    const reference = best === undefined ? t.lockoutMin : Math.max(t.lockoutMin, best - t.lockoutDropMax);

    if (lockout < reference) {
      findings.push({
        code: 'partial_lockout',
        cue: cueFor(exercise, 'partial_lockout'),
        value: lockout,
        threshold: round(reference),
        severity: severityOf(lockout, reference, t.band, 'below'),
      });
    }
  }

  if (exercise === 'pushup') {
    // Hip line, judged at the bottom where the plank is hardest to hold.
    const deviation = medianOf(bottom, (angles) => hipLineDeviation(angles) ?? null);
    if (deviation !== null && t.hipSagDeviationMax !== undefined && deviation > t.hipSagDeviationMax) {
      findings.push({
        code: 'hip_sag',
        cue: cueFor(exercise, 'hip_sag'),
        value: deviation,
        threshold: t.hipSagDeviationMax,
        severity: severityOf(deviation, t.hipSagDeviationMax, t.band, 'above'),
      });
    }
    if (
      deviation !== null &&
      t.hipPikeDeviationMax !== undefined &&
      deviation < -t.hipPikeDeviationMax
    ) {
      const threshold = -t.hipPikeDeviationMax;
      findings.push({
        code: 'hip_pike',
        cue: cueFor(exercise, 'hip_pike'),
        value: deviation,
        threshold,
        severity: severityOf(deviation, threshold, t.band, 'below'),
      });
    }

    // Synthetic fixtures written before the signed signal existed still carry
    // the old unsigned hip angle. Keep those fixtures meaningful while all
    // live MediaPipe frames use the directional calculation above.
    if (deviation === null && t.hipSagMin !== undefined && t.hipPikeMax !== undefined) {
      const hip = medianOf(bottom, hipAngle);
      if (hip !== null && hip < t.hipSagMin) {
        findings.push({
          code: 'hip_sag',
          cue: cueFor(exercise, 'hip_sag'),
          value: hip,
          threshold: t.hipSagMin,
          severity: severityOf(hip, t.hipSagMin, t.band, 'below'),
        });
      }
      if (hip !== null && hip > t.hipPikeMax) {
        findings.push({
          code: 'hip_pike',
          cue: cueFor(exercise, 'hip_pike'),
          value: hip,
          threshold: t.hipPikeMax,
          severity: severityOf(hip, t.hipPikeMax, t.band, 'above'),
        });
      }
    }
  } else {
    const lean = extremeOf(bottom, (a) => a.trunkLean, 'max');
    if (lean !== null && t.trunkLeanMax !== undefined && lean > t.trunkLeanMax) {
      findings.push({
        code: 'excessive_trunk_lean',
        cue: cueFor(exercise, 'excessive_trunk_lean'),
        value: lean,
        threshold: t.trunkLeanMax,
        severity: severityOf(lean, t.trunkLeanMax, t.band, 'above'),
      });
    }
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

/**
 * Which correction matters most, when several fired.
 *
 * Severity alone is the wrong ordering, and field testing showed why. A partial
 * squat usually fails depth *and* lockout together — someone pumping half reps
 * rarely stands fully upright between them — and once both are normalised by
 * the same band, the lockout miss can score higher. Users were told "berdiri
 * tegak sepenuhnya" while doing quarter squats, which is technically true,
 * useless, and reads as the app not understanding the movement.
 *
 * Range of motion comes first because it is the point of the repetition;
 * everything else is a refinement of a rep that was worth doing.
 */
/**
 * Corrections worth saying once a set rather than once a repetition.
 *
 * Depth is actionable on the very next rep, so repeating it is coaching. Lockout
 * is a habit across the set — hearing "luruskan lengan sepenuhnya" after every
 * repetition is not twelve corrections, it is one correction shouted twelve
 * times, and it drowns out the cues that do change rep to rep.
 *
 * Still recorded on every rep it occurs; only the speaking is rationed.
 */
export const SPEAK_ONCE_PER_SET: ReadonlySet<RuleErrorCode> = new Set(['partial_lockout']);

const CUE_PRIORITY: RuleErrorCode[] = [
  'shallow_depth',
  'hip_sag',
  'hip_pike',
  'excessive_trunk_lean',
  'partial_lockout',
];

/**
 * The single cue to speak for a rep.
 *
 * One cue, not a list: the user is mid-set and can act on exactly one
 * correction before the next repetition. Speaking three would mean acting on
 * none, and the audio would still be playing when the next rep began.
 */
export function primaryCue(findings: RuleFinding[]): RuleFinding | null {
  if (findings.length === 0) return null;

  return [...findings].sort((a, b) => {
    const rank = CUE_PRIORITY.indexOf(a.code) - CUE_PRIORITY.indexOf(b.code);
    // Severity still breaks ties within a priority tier.
    return rank !== 0 ? rank : b.severity - a.severity;
  })[0];
}
