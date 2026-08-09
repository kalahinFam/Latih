/**
 * Speech input for the rest screen.
 *
 * ## The thing to know before using this
 *
 * The Web Speech API does not transcribe on the device. In Chrome the audio is
 * sent to Google's speech service and the text comes back — so this is the one
 * path in the product where something recorded by a sensor leaves the phone.
 * Camera frames still never do, and that claim is unaffected, but the two must
 * not be described as though they work the same way.
 *
 * A product whose whole argument is "the processing happens here" owes the user
 * a plain sentence where that stops being true, and it is in the settings
 * screen's privacy section — stated as the one exception, next to the claims it
 * is an exception to. It used to sit under the microphone as well; a paragraph
 * on a sheet with a rest timer running is a paragraph nobody reads, and the
 * button it explained is now the only thing on that row.
 *
 * ## Why there is a typed fallback beside it
 *
 * Support is uneven and the failure is silent: Firefox has none, iOS Safari
 * varies by version, and every browser fails the same way with no microphone
 * permission. A rest screen whose only input is a button that does nothing on
 * some phones is worse than one with a text field. `speechSupport()` reports
 * which case applies so the screen can say why rather than look broken.
 *
 * ## Why the confidence comes back with the transcript
 *
 * This microphone is held out during rest, between sets, by somebody still
 * breathing hard, often with a fan or a television running. Recognition does not
 * report failure in that setting — it reports a confident-looking sentence that
 * is not what was said. That matters more here than in most text boxes, because
 * one of the things this text box can do is change the rest of the day's
 * training on the strength of the word "sakit".
 *
 * So the score travels with the words and the screen decides what to do with it.
 * See `isLowConfidence` for why an *absent* score is not treated as a low one.
 */

/** Bahasa Indonesia. The coach speaks it, so the listener should expect it. */
const LANG = 'id-ID';

/**
 * Minimal shape of the vendor-prefixed API.
 *
 * Typed here rather than pulled from a DOM lib because the standard `lib.dom`
 * shipped with this TypeScript does not declare `SpeechRecognition`, and adding
 * a dependency for four fields would be a poor trade.
 */
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<
    ArrayLike<{ transcript: string; confidence?: number }> & { isFinal: boolean }
  >;
  resultIndex: number;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function constructorFor(): SpeechRecognitionConstructor | null {
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export interface SpeechSupport {
  supported: boolean;
  /** Shown to the user when unsupported. Says why, not just "no". */
  reason: string;
}

export function speechSupport(): SpeechSupport {
  if (!window.isSecureContext) {
    return { supported: false, reason: 'Butuh koneksi aman (HTTPS) untuk memakai mikrofon.' };
  }
  if (!constructorFor()) {
    return {
      supported: false,
      reason: 'Browser ini belum mendukung input suara. Ketik saja pertanyaannya.',
    };
  }
  return { supported: true, reason: '' };
}

/**
 * Below this, the transcript is shown for checking rather than acted on.
 *
 * Chosen from what the API actually reports rather than from taste: a clearly
 * spoken Indonesian sentence comes back around 0.85–0.95 in Chrome, and the
 * scores that turn out to be wrong words cluster well under 0.6. Set it higher
 * and every reply needs confirming, which trains people to confirm without
 * reading — the failure this is meant to prevent, arriving by a slower route.
 */
export const LOW_CONFIDENCE = 0.6;

/**
 * Whether a transcript should be checked before it is acted on.
 *
 * `null` means the browser reported no score, and that must read as "fine".
 * iOS Safari and several Android builds populate no confidence at all, and
 * treating silence as a low score would leave those users with a microphone
 * that never does anything on the first press — the same silent failure the
 * typed fallback exists to avoid.
 */
export function isLowConfidence(confidence: number | null): boolean {
  return confidence !== null && confidence < LOW_CONFIDENCE;
}

export interface ListenHandlers {
  /** Fires as words arrive, so the user can see it is hearing them. */
  onInterim: (text: string) => void;
  /**
   * The final transcript. Fires once.
   *
   * `confidence` is null when the browser reported none — not zero, which would
   * be indistinguishable from a score of zero it did report.
   */
  onFinal: (text: string, confidence: number | null) => void;
  onError: (message: string) => void;
}

export interface Listening {
  /** Finish and let the final result arrive. */
  stop(): void;
  /** Drop it — no result, no error. Used when the screen goes away. */
  cancel(): void;
}

/** Errors the API reports, in words the user can act on. */
const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Akses mikrofon ditolak. Izinkan di pengaturan browser, atau ketik saja.',
  'service-not-allowed': 'Akses mikrofon ditolak. Izinkan di pengaturan browser, atau ketik saja.',
  'no-speech': 'Tidak ada suara terdengar. Coba lagi, atau ketik saja.',
  network: 'Pengenalan suara butuh koneksi. Ketik saja kalau sedang offline.',
  aborted: '',
};

export function listen(handlers: ListenHandlers): Listening | null {
  const Recognition = constructorFor();
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.lang = LANG;
  // One utterance, not a running dictation: the user says a sentence and
  // expects the coach to answer it, not to keep listening while they breathe.
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let cancelled = false;
  /** Scores of the final segments, averaged at the end. */
  const finalScores: number[] = [];

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const alternative = result[0];
      const text = alternative?.transcript ?? '';
      if (result.isFinal) {
        finalText += text;
        // Only real numbers. A browser that reports nothing must leave the
        // list empty rather than push a zero it did not mean.
        const score = alternative?.confidence;
        if (typeof score === 'number' && Number.isFinite(score)) finalScores.push(score);
      } else interim += text;
    }
    if (interim) handlers.onInterim(interim);
  };

  recognition.onerror = (event) => {
    if (cancelled) return;
    const message = ERROR_MESSAGES[event.error] ?? 'Input suara gagal. Ketik saja pertanyaannya.';
    if (message) handlers.onError(message);
  };

  recognition.onend = () => {
    if (cancelled) return;
    const text = finalText.trim();
    // The mean rather than the minimum: with `continuous = false` there is
    // normally one segment anyway, and on the rare multi-segment utterance one
    // weak word should not condemn a sentence that was otherwise heard well.
    const confidence =
      finalScores.length === 0
        ? null
        : finalScores.reduce((sum, value) => sum + value, 0) / finalScores.length;
    // Ending with nothing heard is not an error the API always reports, and
    // silently doing nothing would read as the button being broken.
    if (text) handlers.onFinal(text, confidence);
    else handlers.onError('Tidak ada suara terdengar. Coba lagi, atau ketik saja.');
  };

  try {
    recognition.start();
  } catch {
    // Chrome throws if start() is called while already listening.
    return null;
  }

  return {
    stop: () => recognition.stop(),
    cancel: () => {
      cancelled = true;
      recognition.abort();
    },
  };
}
