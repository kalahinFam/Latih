import { describe, expect, it } from 'vitest';
import {
  CAMERA_GUIDANCE,
  READY_CUE,
  allSetupSpeech,
  checkFraming,
  framingMessage,
  framingSpeech,
} from './framing.ts';
import { LANDMARK_COUNT, LM, type Landmark } from './types.ts';

function lm(x: number, y: number, visibility = 1): Landmark {
  return { x, y, z: 0, visibility };
}

/** A well-framed body: everything visible, spanning most of the frame height. */
function framedBody(): Landmark[] {
  const body = Array.from({ length: LANDMARK_COUNT }, () => lm(0.5, 0.5, 0.9));
  body[LM.LEFT_SHOULDER] = lm(0.45, 0.2);
  body[LM.RIGHT_SHOULDER] = lm(0.55, 0.2);
  body[LM.LEFT_ELBOW] = lm(0.4, 0.35);
  body[LM.RIGHT_ELBOW] = lm(0.6, 0.35);
  body[LM.LEFT_WRIST] = lm(0.38, 0.5);
  body[LM.RIGHT_WRIST] = lm(0.62, 0.5);
  body[LM.LEFT_HIP] = lm(0.47, 0.55);
  body[LM.RIGHT_HIP] = lm(0.53, 0.55);
  body[LM.LEFT_KNEE] = lm(0.47, 0.72);
  body[LM.RIGHT_KNEE] = lm(0.53, 0.72);
  body[LM.LEFT_ANKLE] = lm(0.47, 0.9);
  body[LM.RIGHT_ANKLE] = lm(0.53, 0.9);
  return body;
}

describe('checkFraming', () => {
  it('accepts a well-framed body', () => {
    expect(checkFraming(framedBody(), 'pushup').ok).toBe(true);
    expect(checkFraming(framedBody(), 'squat').ok).toBe(true);
  });

  it('reports no pose when there are no landmarks', () => {
    expect(checkFraming(null, 'pushup').issue).toEqual({ kind: 'no-pose' });
    expect(checkFraming([], 'pushup').issue).toEqual({ kind: 'no-pose' });
  });

  it('detects feet cropped out of frame', () => {
    // The reported field failure: the model still emits ankle landmarks, but
    // extrapolated beyond the frame — a guess, not a measurement.
    const body = framedBody();
    body[LM.LEFT_ANKLE] = lm(0.47, 1.2);
    body[LM.RIGHT_ANKLE] = lm(0.53, 1.25);

    const status = checkFraming(body, 'squat');
    expect(status.ok).toBe(false);
    expect(status.issue).toEqual({ kind: 'out-of-frame', missing: 'feet' });
  });

  it('detects feet that are in frame but not visible', () => {
    const body = framedBody();
    body[LM.LEFT_ANKLE] = lm(0.47, 0.9, 0.1);
    body[LM.RIGHT_ANKLE] = lm(0.53, 0.9, 0.1);
    expect(checkFraming(body, 'squat').issue).toMatchObject({ missing: 'feet' });
  });

  it('reports feet before hands when both are missing', () => {
    // Cropped feet degrade the whole-body solve most, so it is the more useful
    // instruction to give first.
    const body = framedBody();
    for (const i of [LM.LEFT_ANKLE, LM.RIGHT_ANKLE]) body[i] = lm(0.5, 1.3);
    for (const i of [LM.LEFT_WRIST, LM.RIGHT_WRIST]) body[i] = lm(-0.3, 0.5);
    expect(checkFraming(body, 'squat').issue).toMatchObject({ missing: 'feet' });
  });

  it('tolerates one occluded side of a bilateral pair', () => {
    // Under the oblique camera the guidance asks for, the far limb is always
    // partly hidden. Requiring both sides would mean requiring a viewpoint
    // that makes the joint itself unreadable.
    const body = framedBody();
    body[LM.RIGHT_ELBOW] = lm(0.6, 0.35, 0.1);
    body[LM.RIGHT_WRIST] = lm(0.62, 0.5, 0.1);
    expect(checkFraming(body, 'pushup').ok).toBe(true);
  });

  it('still reports hands when neither is visible', () => {
    const body = framedBody();
    for (const i of [LM.LEFT_WRIST, LM.RIGHT_WRIST]) body[i] = lm(0.5, 0.5, 0.1);
    expect(checkFraming(body, 'pushup').issue).toMatchObject({ missing: 'hands' });
  });

  it('detects a person too far from the camera', () => {
    const body = Array.from({ length: LANDMARK_COUNT }, () => lm(0.5, 0.5, 0.9));
    for (const i of Object.values(LM)) body[i] = lm(0.5, 0.48 + Math.random() * 0.04, 0.9);
    const status = checkFraming(body, 'squat');
    expect(status.ok).toBe(false);
    expect(status.issue).toEqual({ kind: 'too-small' });
  });

  it('does not require wrists for a squat', () => {
    // A squat is judged from hips, knees and ankles; demanding wrists would
    // reject perfectly usable footage.
    const body = framedBody();
    body[LM.LEFT_WRIST] = lm(-0.5, 0.5, 0.1);
    body[LM.RIGHT_WRIST] = lm(1.5, 0.5, 0.1);
    expect(checkFraming(body, 'squat').ok).toBe(true);
  });

  it('does not require ankles for a push-up', () => {
    // They were required on the theory that losing them destabilises the whole
    // solve. In practice the far leg is occluded by the near one throughout a
    // real push-up, so the requirement never held — it just left "telapak kaki
    // terpotong" on screen through every set until the banner meant nothing.
    const body = framedBody();
    body[LM.LEFT_ANKLE] = lm(0.47, 1.4);
    body[LM.RIGHT_ANKLE] = lm(0.53, 1.4);
    expect(checkFraming(body, 'pushup').ok).toBe(true);
  });

  it('still requires ankles for a squat, which is judged from the knee', () => {
    const body = framedBody();
    body[LM.LEFT_ANKLE] = lm(0.47, 1.4);
    body[LM.RIGHT_ANKLE] = lm(0.53, 1.4);
    expect(checkFraming(body, 'squat').ok).toBe(false);
  });
});

describe('framingSpeech', () => {
  it('is shorter than the written message it mirrors', () => {
    // Heard once, cannot be re-read, and competing with the room.
    for (const issue of [
      { kind: 'no-pose' } as const,
      { kind: 'too-small' } as const,
      { kind: 'out-of-frame', missing: 'feet' } as const,
    ]) {
      expect(framingSpeech(issue, 'pushup').length).toBeLessThan(
        framingMessage(issue, 'pushup').length,
      );
    }
  });

  it('enumerates every phrase the generator must render', () => {
    const phrases = allSetupSpeech();
    expect(phrases).toContain(READY_CUE);
    // A phrase without a pre-rendered clip degrades to the browser's
    // synthesiser, which is exactly the quality drop the demo video captures.
    for (const exercise of ['pushup', 'squat'] as const) {
      for (const issue of [
        { kind: 'no-pose' } as const,
        { kind: 'too-small' } as const,
        { kind: 'out-of-frame', missing: 'feet' } as const,
        { kind: 'out-of-frame', missing: 'hands' } as const,
        { kind: 'out-of-frame', missing: 'body' } as const,
      ]) {
        expect(phrases).toContain(framingSpeech(issue, exercise));
      }
    }
  });
});

describe('framingMessage', () => {
  it('tells the user what to do, per exercise', () => {
    const pushup = framingMessage({ kind: 'out-of-frame', missing: 'feet' }, 'pushup');
    const squat = framingMessage({ kind: 'out-of-frame', missing: 'feet' }, 'squat');
    expect(pushup).not.toBe(squat);
    expect(pushup.length).toBeGreaterThan(0);
    expect(squat.length).toBeGreaterThan(0);
  });

  it('covers every issue kind', () => {
    const issues = [
      { kind: 'no-pose' } as const,
      { kind: 'too-small' } as const,
      { kind: 'out-of-frame', missing: 'feet' } as const,
      { kind: 'out-of-frame', missing: 'hands' } as const,
      { kind: 'out-of-frame', missing: 'body' } as const,
    ];
    for (const issue of issues) {
      expect(framingMessage(issue, 'pushup').length).toBeGreaterThan(0);
    }
  });
});

describe('CAMERA_GUIDANCE', () => {
  it('specifies an oblique angle for both exercises', () => {
    // Neither pure front nor pure side: front hides flexion along the optical
    // axis, full side hides the far limb entirely.
    for (const exercise of ['pushup', 'squat'] as const) {
      expect(CAMERA_GUIDANCE[exercise].angle).toMatch(/serong/i);
    }
  });

  it('orients the phone to match the body axis', () => {
    expect(CAMERA_GUIDANCE.pushup.orientation).toMatch(/landscape/i);
    expect(CAMERA_GUIDANCE.squat.orientation).toMatch(/portrait/i);
  });
});
