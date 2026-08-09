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
 * That is why `speechDisclosure()` exists and why the screen shows it next to
 * the microphone rather than in a settings page nobody opens. A product whose
 * whole argument is "the processing happens here" owes the user a plain
 * sentence at the moment it stops being true.
 *
 * ## Why there is a typed fallback beside it
 *
 * Support is uneven and the failure is silent: Firefox has none, iOS Safari
 * varies by version, and every browser fails the same way with no microphone
 * permission. A rest screen whose only input is a button that does nothing on
 * some phones is worse than one with a text field. `speechSupport()` reports
 * which case applies so the screen can say why rather than look broken.
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
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
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
 * The sentence shown beside the microphone.
 *
 * Exported rather than inlined in the screen so the same wording can be
 * repeated in the privacy section, and so changing it changes both.
 */
export function speechDisclosure(): string {
  return (
    'Suaramu dikirim ke layanan pengenal suara milik browser untuk diubah jadi ' +
    'teks — ini satu-satunya bagian yang keluar dari perangkat. Gambar dari ' +
    'kamera tetap tidak pernah dikirim ke mana pun.'
  );
}

export interface ListenHandlers {
  /** Fires as words arrive, so the user can see it is hearing them. */
  onInterim: (text: string) => void;
  /** The final transcript. Fires once. */
  onFinal: (text: string) => void;
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

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) finalText += text;
      else interim += text;
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
    // Ending with nothing heard is not an error the API always reports, and
    // silently doing nothing would read as the button being broken.
    if (text) handlers.onFinal(text);
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
