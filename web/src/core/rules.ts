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
 * ## On thresholds
 *
 * The values below are seeded from the biomechanics of each movement, not
 * fitted to data. They are placeholders until annotation is done and get
 * re-tuned against labelled reps — at which point the tuning itself is a result
 * worth reporting, not a hidden constant.
 *
 * ## The invariant that makes these rules reachable
 *
 * Every threshold here must be *stricter* than the rep counter's gate for the
 * same joint, because the rules only ever see repetitions the counter emitted.
 * Set `depthMax` equal to the counter's `downEnter` and the shallow-depth rule
 * becomes unreachable: any rep deep enough to be counted is deep enough to
 * pass. The rule still reads correctly on its own and still passes a unit test
 * built from a synthetic window — it simply never fires in the product.
 * `rules.test.ts` asserts the ordering against `DEFAULT_CONFIGS` directly.
 */

import type { ExerciseKind, JointAngles } from './types.ts';
import { bilateralMean } from './angles.ts';
import { bottomFrames, extremeOf, medianOf, type RepWindow } from './repWindow.ts';

/** Stable identifiers — these are the classes the paper reports P/R/F1 for. */
export type RuleErrorCode =
  | 'shallow_depth'
  | 'partial_lockout'
  | 'hip_sag'
  | 'hip_pike'
  | 'excessive_trunk_lean';

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
  /** A rep shallower than this at the bottom is not deep enough. */
  depthMax: number;
  /** A rep that never extends past this did not lock out. */
  lockoutMin: number;
  /** Push-up only: hip angle band around straight (180 deg). */
  hipSagMin?: number;
  hipPikeMax?: number;
  /** Squat only: trunk lean beyond this is excessive. */
  trunkLeanMax?: number;
  /** Width of the band used to normalise severity. */
  band: number;
}

export const DEFAULT_THRESHOLDS: Record<ExerciseKind, Thresholds> = {
  pushup: {
    // Elbow at the bottom. Above ~105 deg the chest has not travelled far.
    // Counter gate is 135, so reps bottoming between 105 and 135 are counted
    // and flagged — which is exactly the population that needs coaching.
    depthMax: 105,
    // Elbow at the top. Counter gate is 158; reps peaking between 158 and 168
    // are counted and flagged as an incomplete lockout.
    lockoutMin: 168,
    // Shoulder-hip-knee. A straight plank is ~180; sagging drops it.
    hipSagMin: 160,
    hipPikeMax: 200,
    band: 25,
  },
  squat: {
    // Knee at the bottom. Parallel is ~90; above ~110 is a partial squat.
    // Counter gate is 140, so 110-140 is the coachable band.
    depthMax: 110,
    // Counter gate is 162; 162-172 is flagged as not standing fully upright.
    lockoutMin: 172,
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

function hipAngle(angles: JointAngles): number | null {
  return bilateralMean(angles.hipLeft, angles.hipRight);
}

function kneeAngle(angles: JointAngles): number | null {
  return bilateralMean(angles.kneeLeft, angles.kneeRight);
}

function elbowAngle(angles: JointAngles): number | null {
  return bilateralMean(angles.elbowLeft, angles.elbowRight);
}

/**
 * Evaluate the rules for one completed repetition.
 *
 * Returns every rule that fired, most severe first. An empty array means the
 * rep passed every deterministic check — not that the rep was perfect, since
 * the classifier judges what these rules cannot see.
 */
export function evaluateRules(
  exercise: ExerciseKind,
  window: RepWindow,
  overrides: Partial<Thresholds> = {},
): RuleFinding[] {
  const t = { ...DEFAULT_THRESHOLDS[exercise], ...overrides };
  const bottom = bottomFrames(window);
  const findings: RuleFinding[] = [];

  // Median, not min. `min` over the bottom window is the most optimistic
  // possible reading of depth — one badly-fitted frame is enough to make a
  // shallow rep look deep and silence the cue. Field testing showed cues
  // firing inconsistently, and an outlier-sensitive statistic is one cause.
  const primaryAtBottom =
    exercise === 'pushup' ? medianOf(bottom, elbowAngle) : medianOf(bottom, kneeAngle);

  // Depth. Uses the frames around the bottom rather than the counter's
  // minAngle so the two agree even if the counter held frames for low
  // visibility partway through.
  if (primaryAtBottom !== null && primaryAtBottom > t.depthMax) {
    findings.push({
      code: 'shallow_depth',
      cue: exercise === 'pushup' ? 'Turunkan dada lebih dalam' : 'Turun lebih dalam',
      value: primaryAtBottom,
      threshold: t.depthMax,
      severity: severityOf(primaryAtBottom, t.depthMax, t.band, 'above'),
    });
  }

  // Lockout. maxAngle is the peak extension the counter observed at the top.
  const lockout = window.event.maxAngle;
  if (Number.isFinite(lockout) && lockout < t.lockoutMin) {
    findings.push({
      code: 'partial_lockout',
      cue: exercise === 'pushup' ? 'Luruskan lengan sepenuhnya' : 'Berdiri tegak sepenuhnya',
      value: lockout,
      threshold: t.lockoutMin,
      severity: severityOf(lockout, t.lockoutMin, t.band, 'below'),
    });
  }

  if (exercise === 'pushup') {
    // Hip line, judged at the bottom where the plank is hardest to hold.
    const hip = medianOf(bottom, hipAngle);
    if (hip !== null && t.hipSagMin !== undefined && hip < t.hipSagMin) {
      findings.push({
        code: 'hip_sag',
        cue: 'Angkat pinggul, jaga badan lurus',
        value: hip,
        threshold: t.hipSagMin,
        severity: severityOf(hip, t.hipSagMin, t.band, 'below'),
      });
    }
    if (hip !== null && t.hipPikeMax !== undefined && hip > t.hipPikeMax) {
      findings.push({
        code: 'hip_pike',
        cue: 'Turunkan pinggul, jaga badan lurus',
        value: hip,
        threshold: t.hipPikeMax,
        severity: severityOf(hip, t.hipPikeMax, t.band, 'above'),
      });
    }
  } else {
    const lean = extremeOf(bottom, (a) => a.trunkLean, 'max');
    if (lean !== null && t.trunkLeanMax !== undefined && lean > t.trunkLeanMax) {
      findings.push({
        code: 'excessive_trunk_lean',
        cue: 'Jaga dada tetap tegak',
        value: lean,
        threshold: t.trunkLeanMax,
        severity: severityOf(lean, t.trunkLeanMax, t.band, 'above'),
      });
    }
  }

  return findings.sort((a, b) => b.severity - a.severity);
}

/**
 * The single cue to speak for a rep.
 *
 * One cue, not a list: the user is mid-set and can act on exactly one
 * correction before the next repetition. Speaking three would mean acting on
 * none, and the audio would still be playing when the next rep began.
 */
export function primaryCue(findings: RuleFinding[]): RuleFinding | null {
  return findings.length > 0 ? findings[0] : null;
}
