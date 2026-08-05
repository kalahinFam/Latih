/**
 * Skeleton overlay renderer.
 *
 * Drawn on a canvas sized to the video's intrinsic resolution and scaled by
 * CSS, so the overlay stays registered with the video on any screen without
 * per-frame layout maths.
 *
 * Legibility is worth more than it looks here: the demo is judged on camera,
 * and a skeleton that reads clearly against a cluttered room is the difference
 * between a viewer seeing the AI work and taking our word for it.
 */

import { POSE_CONNECTIONS } from '../pose/poseSource.ts';
import { LM, type Landmark, type MovementKind } from '../core/types.ts';

/**
 * The skeleton is drawn white, not in the signal colour.
 *
 * Per the design: form status is carried by the rep count, which changes colour
 * itself. If the skeleton were coloured too, the screen would say the same
 * thing twice and the amber highlight below would lose its meaning — it is the
 * only thing on the overlay that ever turns amber, so it reads as *where* the
 * problem is rather than *that* there is one.
 */
const JOINT_COLOR = '#ffffff';
const BONE_COLOR = 'rgba(255, 255, 255, 0.9)';
const LOW_CONFIDENCE_COLOR = 'rgba(255, 255, 255, 0.28)';

/** Marks the joint the current correction is about. */
const HIGHLIGHT_COLOR = '#e0952b';

/** Below this, a joint is drawn faint rather than hidden. */
const DRAW_VISIBILITY_FLOOR = 0.5;

export interface SkeletonStyle {
  boneWidth: number;
  jointRadius: number;
  /** Mirror horizontally, to match a front-facing camera preview. */
  mirrored: boolean;
  /**
   * Landmark indices to draw amber and enlarged — the joints the active
   * correction refers to. Empty when the form is clean.
   */
  highlight?: readonly number[];
}

export const DEFAULT_SKELETON_STYLE: SkeletonStyle = {
  boneWidth: 6,
  jointRadius: 5,
  mirrored: true,
};

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[],
  style: SkeletonStyle = DEFAULT_SKELETON_STYLE,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  const px = (lm: Landmark) => ({
    x: (style.mirrored ? 1 - lm.x : lm.x) * width,
    y: lm.y * height,
  });

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const { start, end } of POSE_CONNECTIONS) {
    const a = landmarks[start];
    const b = landmarks[end];
    if (!a || !b) continue;

    const confident = a.visibility >= DRAW_VISIBILITY_FLOOR && b.visibility >= DRAW_VISIBILITY_FLOOR;
    const pa = px(a);
    const pb = px(b);

    ctx.strokeStyle = confident ? BONE_COLOR : LOW_CONFIDENCE_COLOR;
    ctx.lineWidth = style.boneWidth;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  const highlight = new Set(style.highlight ?? []);

  landmarks.forEach((lm, index) => {
    const p = px(lm);
    const marked = highlight.has(index);

    ctx.fillStyle = marked
      ? HIGHLIGHT_COLOR
      : lm.visibility >= DRAW_VISIBILITY_FLOOR
        ? JOINT_COLOR
        : LOW_CONFIDENCE_COLOR;
    ctx.beginPath();
    // Larger as well as amber: at two metres a colour change on a 5 px dot is
    // not reliably visible, and size survives a busy background that colour
    // alone does not.
    ctx.arc(p.x, p.y, marked ? style.jointRadius * 1.8 : style.jointRadius, 0, Math.PI * 2);
    ctx.fill();
  });
}

/**
 * Which joints a correction is about.
 *
 * The overlay's job is to answer "where", and every rule already knows the
 * answer — it is implicit in the angle each one measures. Making it explicit
 * here keeps the mapping in one place instead of scattered through the render
 * path.
 */
export const HIGHLIGHT_JOINTS: Record<string, readonly number[]> = {
  'pushup:shallow_depth': [LM.LEFT_ELBOW, LM.RIGHT_ELBOW],
  'pushup:partial_lockout': [LM.LEFT_ELBOW, LM.RIGHT_ELBOW],
  'pushup:hip_sag': [LM.LEFT_HIP, LM.RIGHT_HIP],
  'pushup:hip_pike': [LM.LEFT_HIP, LM.RIGHT_HIP],
  'squat:shallow_depth': [LM.LEFT_KNEE, LM.RIGHT_KNEE],
  'squat:partial_lockout': [LM.LEFT_KNEE, LM.RIGHT_KNEE],
  // Trunk lean is measured shoulder-to-hip, so both ends are the fault.
  'squat:excessive_trunk_lean': [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER, LM.LEFT_HIP, LM.RIGHT_HIP],
  // The plank's whole judgement is the hip line, so the hips are always where
  // the problem is.
  'plank:hip_sag': [LM.LEFT_HIP, LM.RIGHT_HIP],
  'plank:hip_pike': [LM.LEFT_HIP, LM.RIGHT_HIP],
};

export function highlightFor(exercise: MovementKind, code: string | null): readonly number[] {
  if (!code) return [];
  return HIGHLIGHT_JOINTS[`${exercise}:${code}`] ?? [];
}

export function clearSkeleton(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
