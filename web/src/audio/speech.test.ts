/**
 * The confidence path, without a browser.
 *
 * `listen()` is exercised through a stand-in for the vendor API installed on
 * `globalThis.window`. The point is not to test the Web Speech API — it is to
 * pin the two decisions this module makes about a score: that an absent one is
 * reported as `null` rather than `0`, and that several final segments average
 * rather than take the worst.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOW_CONFIDENCE, isLowConfidence, listen } from './speech.ts';

describe('isLowConfidence', () => {
  it('flags a score under the bar', () => {
    expect(isLowConfidence(LOW_CONFIDENCE - 0.01)).toBe(true);
  });

  it('passes a score at or above it', () => {
    expect(isLowConfidence(LOW_CONFIDENCE)).toBe(false);
    expect(isLowConfidence(0.94)).toBe(false);
  });

  it('treats a missing score as fine, not as low', () => {
    // iOS Safari reports none. Reading that as low would leave those users
    // with a microphone that never sends anything on the first press.
    expect(isLowConfidence(null)).toBe(false);
  });
});

/* ------------------------------------------------------- listen() plumbing */

interface Alternative {
  transcript: string;
  confidence?: number;
}

/** One `results` entry: an array-like of alternatives plus `isFinal`. */
function segment(alternative: Alternative, isFinal = true): Alternative[] & { isFinal: boolean } {
  return Object.assign([alternative], { isFinal });
}

class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  start(): void {}
  stop(): void {}
  abort(): void {}

  /** Deliver segments and then close, the way one utterance actually arrives. */
  utter(...segments: (Alternative[] & { isFinal: boolean })[]): void {
    this.onresult?.({ results: segments, resultIndex: 0 });
    this.onend?.();
  }
}

let active: FakeRecognition | null = null;

function installFakeSpeech(): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      SpeechRecognition: function SpeechRecognitionStub(this: FakeRecognition) {
        active = new FakeRecognition();
        return active;
      },
    },
  });
}

afterEach(() => {
  active = null;
  Reflect.deleteProperty(globalThis, 'window');
});

/** Start listening and return the recorded `onFinal` call. */
function heard(...segments: (Alternative[] & { isFinal: boolean })[]) {
  installFakeSpeech();
  const onFinal = vi.fn();
  const handle = listen({ onInterim: vi.fn(), onFinal, onError: vi.fn() });
  expect(handle).not.toBeNull();
  active!.utter(...segments);
  return onFinal;
}

describe('listen reports confidence with the transcript', () => {
  it('passes through a reported score', () => {
    const onFinal = heard(segment({ transcript: 'lutut kiri sakit', confidence: 0.91 }));
    expect(onFinal).toHaveBeenCalledWith('lutut kiri sakit', 0.91);
  });

  it('reports null when the browser gave no score', () => {
    // Not zero. Zero is a score a browser could genuinely mean.
    const onFinal = heard(segment({ transcript: 'habis ini apa' }));
    expect(onFinal).toHaveBeenCalledWith('habis ini apa', null);
  });

  it('averages several final segments rather than taking the worst', () => {
    const onFinal = heard(
      segment({ transcript: 'lutut ', confidence: 0.9 }),
      segment({ transcript: 'sakit', confidence: 0.5 }),
    );
    const [text, confidence] = onFinal.mock.calls[0] as [string, number];
    expect(text).toBe('lutut sakit');
    expect(confidence).toBeCloseTo(0.7, 5);
  });

  it('ignores interim segments when scoring', () => {
    const onFinal = heard(
      segment({ transcript: 'lut', confidence: 0.1 }, false),
      segment({ transcript: 'lutut sakit', confidence: 0.88 }),
    );
    expect(onFinal).toHaveBeenCalledWith('lutut sakit', 0.88);
  });

  it('does not let a non-finite score contaminate the mean', () => {
    const onFinal = heard(
      segment({ transcript: 'a ', confidence: Number.NaN }),
      segment({ transcript: 'b', confidence: 0.8 }),
    );
    expect(onFinal).toHaveBeenCalledWith('a b', 0.8);
  });
});
