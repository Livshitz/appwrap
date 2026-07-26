import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** An installed synthesizer voice, as offered by {@link SpeechModule.voices}. */
export interface SpeechVoice {
  /** Platform voice identifier — pass back as {@link SpeakOptions.voice} to select it. */
  id: string;
  /** Human-readable name (e.g. 'Samantha'). */
  name: string;
  /** BCP-47 language tag the voice speaks (e.g. 'en-US'). */
  lang: string;
}

export interface SpeakOptions {
  /** BCP-47 language for the utterance (e.g. 'en-US'). Defaults to the system/voice language. */
  lang?: string;
  /** Speaking rate. ~0.5 slow … 1 normal … 2 fast (platforms clamp to their own range). */
  rate?: number;
  /** Voice pitch. ~0.5 low … 1 normal … 2 high. */
  pitch?: number;
  /** A {@link SpeechVoice.id} from {@link SpeechModule.voices} to speak with. */
  voice?: string;
}

export interface ListenOptions {
  /** BCP-47 language to recognize (e.g. 'en-US'). Defaults to the device locale. */
  lang?: string;
  /** Stream interim results via {@link SpeechModule.onPartial} while listening. Default false. */
  partial?: boolean;
}

/** Payload of {@link SpeechModule.onPartial}: the best-so-far interim transcript. */
export interface SpeechPartial {
  /** Interim transcript text (not final — may change as recognition continues). */
  transcript: string;
}

/**
 * Voice I/O — text-to-speech (TTS) and speech-to-text (STT) — ONE API across platforms.
 *
 * TTS is permission-free: {@link speak} reads text aloud and resolves when the utterance finishes;
 * {@link stop} cancels current/queued speech; {@link voices} lists installed synthesizer voices.
 *
 * STT carries microphone + speech-recognition permissions (the opt-in `speech` module stamps them).
 * {@link listen} starts capture and resolves the FINAL transcript string; pass `{ partial: true }` to
 * also stream interim results via {@link onPartial}. {@link stopListening} ends capture early and
 * resolves the pending {@link listen} with the best transcript so far.
 *
 * Two HONEST capability flags — synthesis availability ≠ recognition availability:
 *  - {@link capability} (TTS): native iOS `AVSpeechSynthesizer` / Android `TextToSpeech`; web `'web'`
 *    when `speechSynthesis` exists, else `'none'`.
 *  - {@link recognitionCapability} (STT): native iOS `SFSpeechRecognizer` / Android `SpeechRecognizer`;
 *    web `'web'` when `SpeechRecognition`/`webkitSpeechRecognition` exists (Chrome) else `'none'` —
 *    then {@link listen} throws `KitError('UNSUPPORTED')`. Branch on the flag, not try/catch.
 */
export class SpeechModule {
  constructor(private kit: NativeKit) {}

  /** TTS availability: 'native' on a shell · 'web' where speechSynthesis exists · else 'none'. */
  get capability() {
    return this.kit.capability('speech');
  }

  /** STT availability: 'native' on a shell · 'web' where SpeechRecognition exists · else 'none'. */
  get recognitionCapability() {
    return this.kit.capability('speechRecognition');
  }

  /** Speak `text` aloud; resolves when the utterance finishes (or is stopped). */
  speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    // Resolves only when the utterance (or its queue) finishes — easily exceeds the 10s invoke
    // default for longer text or back-to-back speak() calls, dropping the result. Give it room.
    return this.kit.invoke('speech.speak', { text, ...opts }, { timeoutMs: 120_000 });
  }

  /** Cancel the current/queued utterance immediately. */
  stop(): Promise<void> {
    return this.kit.invoke('speech.stop');
  }

  /** List installed synthesizer voices. */
  voices(): Promise<SpeechVoice[]> {
    return this.kit.invoke('speech.voices');
  }

  /** Start capturing the mic; resolves the FINAL transcript. With `{ partial:true }`, interim
   *  results stream via {@link onPartial}. Throws `KitError('UNSUPPORTED')` where STT is absent. */
  listen(opts: ListenOptions = {}): Promise<string> {
    // Open-ended: resolves on the final result or when stopListening() is called — a person may take
    // a while to speak, so it must not be cut off by the 10s invoke default.
    return this.kit.invoke('speech.listen', opts, { timeoutMs: 600_000 });
  }

  /** Stop capture early; the pending {@link listen} resolves with the best transcript so far. */
  stopListening(): Promise<void> {
    return this.kit.invoke('speech.stopListening');
  }

  /** Interim transcripts while listening (only when {@link listen} was called with `partial:true`). */
  onPartial(cb: (p: SpeechPartial) => void): Unsubscribe {
    return this.kit.on('speech.partial', (p) => cb(p as SpeechPartial));
  }
}
