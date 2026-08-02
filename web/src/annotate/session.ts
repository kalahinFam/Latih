/**
 * The annotated-session file format — the interface between the browser tool
 * and the Python training pipeline.
 *
 * ## Labels are the annotator's, never the rules'
 *
 * `evaluateRules` output is carried as `suggested`, separately from `labels`,
 * and is *never* copied into `labels` automatically. If the training set were
 * seeded from rule output, the classifier would learn to imitate the rules —
 * and the rule-only vs rule+classifier ablation would compare a thing against
 * a copy of itself. The paper's central claim about the three-loop design
 * rests on these two fields staying separate.
 */

import type { RepEvent } from '../core/repCounter.ts';
import type { RuleErrorCode } from '../core/rules.ts';
import type { ExerciseKind, Landmark } from '../core/types.ts';

export const SESSION_FORMAT_VERSION = 1;

export interface LabelledRep {
  index: number;
  startMs: number;
  bottomMs: number;
  endMs: number;
  minAngle: number;
  maxAngle: number;
  eccentricMs: number;
  concentricMs: number;
  /** Assigned by a human. Empty array means a clean rep. */
  labels: RuleErrorCode[];
  /** What the deterministic rules proposed. Kept for analysis, never merged. */
  suggested: RuleErrorCode[];
  /** Annotator marked this rep unusable (occluded, mis-segmented, cut off). */
  rejected: boolean;
}

export interface AnnotatedSession {
  formatVersion: number;
  /** Source video filename — the provenance record for the dataset card. */
  source: string;
  /**
   * Who performed the movement. The train/test split must be by subject, not
   * by rep: reps from one person leaking across the split inflates F1 and a
   * careful reviewer will find it.
   */
  subjectId: string;
  exercise: ExerciseKind;
  model: string;
  annotatedAt: string;
  durationMs: number;
  frameCount: number;
  detectionRate: number;
  /** Ground-truth rep count, confirmed by the annotator against the video. */
  expectedReps: number;
  frames: { timestampMs: number; landmarks: Landmark[] }[];
  reps: LabelledRep[];
}

export function toLabelledRep(event: RepEvent, suggested: RuleErrorCode[]): LabelledRep {
  return {
    index: event.index,
    startMs: Math.round(event.startMs),
    bottomMs: Math.round(event.bottomMs),
    endMs: Math.round(event.endMs),
    minAngle: Number.isFinite(event.minAngle) ? Number(event.minAngle.toFixed(1)) : 0,
    maxAngle: Number.isFinite(event.maxAngle) ? Number(event.maxAngle.toFixed(1)) : 0,
    eccentricMs: Math.round(event.eccentricMs),
    concentricMs: Math.round(event.concentricMs),
    labels: [],
    suggested,
    rejected: false,
  };
}

/**
 * Refuse to export a session that would corrupt the dataset.
 *
 * Catching these at export is worth the friction: a mislabelled file is
 * discovered days later during training, by which time nobody remembers which
 * video it came from.
 */
export function validateSession(session: AnnotatedSession): string[] {
  const problems: string[] = [];

  if (!session.subjectId.trim()) {
    problems.push('Subject ID wajib diisi — split train/test harus per orang.');
  }
  if (session.frames.length === 0) {
    problems.push('Tidak ada frame terdeteksi.');
  }
  if (session.reps.length === 0) {
    problems.push('Tidak ada repetisi tersegmentasi.');
  }
  if (session.detectionRate < 0.6) {
    problems.push(
      `Pose hanya terdeteksi di ${(session.detectionRate * 100).toFixed(0)}% frame — ` +
        'kualitas video kemungkinan terlalu rendah untuk dipakai.',
    );
  }

  const counted = session.reps.filter((r) => !r.rejected).length;
  if (counted !== session.expectedReps) {
    problems.push(
      `Hitungan tersegmentasi (${counted}) tidak cocok dengan hitungan manual ` +
        `(${session.expectedReps}). Perbaiki dulu atau tandai rep yang salah segmentasi.`,
    );
  }

  return problems;
}

export function downloadSession(session: AnnotatedSession): void {
  const safeSource = session.source.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_');
  const name = `${session.subjectId}_${session.exercise}_${safeSource}.json`;
  const blob = new Blob([JSON.stringify(session)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
