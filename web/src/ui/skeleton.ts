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

import { POSE_CONNECTIONS } from '../pose/poseSource';
import type { Landmark } from '../core/types';

const JOINT_COLOR = '#22d3ee';
const BONE_COLOR = 'rgba(34, 211, 238, 0.85)';
const LOW_CONFIDENCE_COLOR = 'rgba(248, 113, 113, 0.9)';

/** Below this, a joint is drawn in the warning colour instead of hidden. */
const DRAW_VISIBILITY_FLOOR = 0.5;

export interface SkeletonStyle {
  boneWidth: number;
  jointRadius: number;
  /** Mirror horizontally, to match a front-facing camera preview. */
  mirrored: boolean;
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

  for (const lm of landmarks) {
    const p = px(lm);
    ctx.fillStyle = lm.visibility >= DRAW_VISIBILITY_FLOOR ? JOINT_COLOR : LOW_CONFIDENCE_COLOR;
    ctx.beginPath();
    ctx.arc(p.x, p.y, style.jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function clearSkeleton(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
