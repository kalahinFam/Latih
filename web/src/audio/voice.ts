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

/** Which path produced the last sound. */
export type AudioSource = 'clip' | 'server' | 'browser' | null;

export class Voice {
  private readonly cache = new Map<string, HTMLAudioElement>();
  private current: HTMLAudioElement | null = null;
  private unlocked = false;
  private narrationUrl: string | null = null;
  private source: AudioSource = null;
  private browserVoice: SpeechSynthesisVoice | null = null;
  /**
   * The ping's own playback context.
   *
   * Kept separate from the media-element path because the ping must not
   * interrupt a corrective cue that is already speaking — a rep landing while
   * the coach talks is the norm, not the exception.
   */
  private ctx: AudioContext | null = null;
  private pingNodes: { osc: OscillatorNode; gain: GainNode } | null = null;

  /**
   * What actually played last.
   *
   * Exposed because the failure it reveals is silent and easy to misread: when
   * a clip is missing or `/api/tts` is unreachable, playback falls through to
   * the browser's own synthesiser, which on Android sounds markedly more
   * synthetic than the generated voice. "The audio sounds robotic" and "the
   * generated audio never played" produce the same complaint, and only this
   * tells them apart.
   */
  get lastSource(): AudioSource {
    return this.source;
  }

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
      this.pickBrowserVoice();
      // The list often arrives asynchronously, and the first call returns
      // nothing at all on Chrome.
      window.speechSynthesis.addEventListener('voiceschanged', () => this.pickBrowserVoice(), {
        once: true,
      });
    }

    // An AudioContext must also be born inside a gesture (or its start is
    // suspended), so prime it here alongside the media-element path.
    this.ensureContext();
  }

  /**
   * Create the ping's context inside a gesture, and wake it when the browser
   * has parked it.
   */
  private ensureContext(): void {
    if (this.ctx === null) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /**
   * Confirm a counted repetition with a short blip.
   *
   * Synthesised rather than pre-rendered: a ping is a tone, and generating it
   * at runtime costs no asset, no build step, and no network. Played on its
   * own context, so it never interrupts a cue that is mid-sentence; a rep
   * landing under the coach's voice should confirm, not cut the coach off.
   */
  playPing(): void {
    this.ensureContext();
    // Still suspended — the gesture never happened or expired. Degrade
    // quietly, exactly as a blocked cue clip does.
    if (!this.ctx || this.ctx.state !== 'running') return;

    this.stopPing();
    const ctx = this.ctx;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = 'sine';

    const start = ctx.currentTime;
    // Two rising tones, quick enough to read as one confirmation.
    osc.frequency.setValueAtTime(1046.5, start); // C6
    osc.frequency.setValueAtTime(1568, start + 0.07); // G6
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.18);
    // Released when it finishes so a rapid-fire set cannot accumulate nodes.
    osc.addEventListener('ended', () => {
      osc.disconnect();
      gain.disconnect();
      if (this.pingNodes?.osc === osc) this.pingNodes = null;
    });
    this.pingNodes = { osc, gain };
  }

  /** Silence a ping still in flight. */
  private stopPing(): void {
    if (!this.pingNodes) return;
    const { osc, gain } = this.pingNodes;
    this.pingNodes = null;
    osc.stop();
    osc.disconnect();
    gain.disconnect();
  }

  /**
   * Choose the least synthetic Indonesian voice available.
   *
   * Left to itself the browser picks the first match, which is usually the
   * built-in compact voice — the most robotic option on the device. A
   * non-local voice is served from the vendor's servers and is markedly
   * better, so it wins when one exists.
   */
  private pickBrowserVoice(): void {
    if (!('speechSynthesis' in window)) return;

    const indonesian = window.speechSynthesis
      .getVoices()
      .filter((voice) => voice.lang.toLowerCase().startsWith('id'));
    if (indonesian.length === 0) return;

    this.browserVoice = indonesian.find((voice) => !voice.localService) ?? indonesian[0];
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
    this.source = 'clip';
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
      this.source = 'server';
      await audio.play();
    } catch {
      this.speakFallback(text);
    }
  }

  /**
   * Browser-native synthesis. Markedly more synthetic, but always available
   * offline — a mute demo is worse than a plainer voice.
   */
  private speakFallback(text: string): void {
    if (!('speechSynthesis' in window)) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'id-ID';
    if (this.browserVoice) utterance.voice = this.browserVoice;
    // Just under natural speed and very slightly low: the default rate on
    // Android reads Indonesian faster than anyone speaks it, which is most of
    // what makes it sound mechanical.
    utterance.rate = 0.98;
    utterance.pitch = 0.95;

    this.source = 'browser';
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  stop(): void {
    this.stopPing();
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
    void this.ctx?.close();
    this.ctx = null;
  }
}
