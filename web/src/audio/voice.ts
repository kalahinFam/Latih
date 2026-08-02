/**
 * Audio playback: instant cues during a set, narration between sets.
 *
 * ## The autoplay problem
 *
 * Browsers refuse to play audio until the page has had a user gesture. The
 * first corrective cue would therefore be silently dropped — and silently is
 * the operative word: no error, no warning, just a coach that appears mute for
 * the first rep. `unlock()` is called from the Start button's own handler,
 * which is a gesture, and primes both playback paths while permission exists.
 */

import { cueUrl } from './cueId.ts';

export class Voice {
  private readonly cache = new Map<string, HTMLAudioElement>();
  private current: HTMLAudioElement | null = null;
  private unlocked = false;
  private narrationUrl: string | null = null;

  /**
   * Prime playback. Must be called synchronously inside a user-gesture
   * handler, not from a promise chain that resolves later — by then the
   * gesture has expired and the browser refuses again.
   */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;

    // A muted play/pause on a real element is enough to mark the media
    // element path as user-activated for the rest of the page's life.
    const primer = new Audio();
    primer.muted = true;
    primer.play().then(
      () => primer.pause(),
      () => {
        /* Some browsers reject an empty source; the gesture still counts. */
      },
    );

    if ('speechSynthesis' in window) {
      // Chrome needs the queue touched during a gesture before later
      // programmatic calls are allowed to speak.
      window.speechSynthesis.cancel();
    }
  }

  /** Preload every cue so the first correction of a set is not the slow one. */
  preloadCues(texts: string[]): void {
    for (const text of texts) {
      if (this.cache.has(text)) continue;
      const audio = new Audio(cueUrl(text));
      audio.preload = 'auto';
      this.cache.set(text, audio);
    }
  }

  /**
   * Play a corrective cue.
   *
   * Interrupts whatever is playing: mid-set, the newest correction is the only
   * one still worth hearing, and queueing would leave the coach talking about
   * a repetition two reps ago.
   */
  playCue(text: string): void {
    let audio = this.cache.get(text);
    if (!audio) {
      audio = new Audio(cueUrl(text));
      this.cache.set(text, audio);
    }

    this.stop();
    audio.currentTime = 0;
    this.current = audio;
    audio.play().catch(() => {
      // A missing clip (phrase edited without regenerating) or a blocked
      // autoplay. The on-screen cue already carries the message, so degrade
      // quietly rather than interrupting the set with an error.
      this.speakFallback(text);
    });
  }

  /**
   * Speak the between-set narration.
   *
   * Tries the server voice first for quality, since this is what the demo
   * video captures. Falls back to the browser's own synthesiser when the
   * network, the key, or the quota is unavailable — a mute demo is worse than
   * a plainer voice.
   */
  async speakNarration(text: string): Promise<void> {
    this.stop();

    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`tts ${response.status}`);

      const blob = await response.blob();
      this.revokeNarration();
      this.narrationUrl = URL.createObjectURL(blob);

      const audio = new Audio(this.narrationUrl);
      this.current = audio;
      await audio.play();
    } catch {
      this.speakFallback(text);
    }
  }

  /** Browser-native synthesis. Lower quality, but always available offline. */
  private speakFallback(text: string): void {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    utterance.rate = 1.05;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  private revokeNarration(): void {
    if (this.narrationUrl) {
      URL.revokeObjectURL(this.narrationUrl);
      this.narrationUrl = null;
    }
  }

  dispose(): void {
    this.stop();
    this.revokeNarration();
    this.cache.clear();
  }
}
