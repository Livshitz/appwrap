import { Utils, isAndroid, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { requestPermissions } from './android-helpers';

const err = (code: string, message: string) => Object.assign(new Error(message), { code });

/**
 * Voice I/O. TTS: iOS AVSpeechSynthesizer / Android TextToSpeech — speak resolves on finish.
 * STT: iOS SFSpeechRecognizer + AVAudioEngine mic tap / Android SpeechRecognizer — listen resolves
 * the FINAL transcript; partials emit `speech.partial` while listening; stopListening resolves with
 * the best-so-far transcript.
 *
 * DEVICE-UNVERIFIED (any-typed FFI, no device run this session): the iOS AVAudioEngine tap +
 * SFSpeechRecognizer authorization/lifecycle, and the Android SpeechRecognizer onResults/
 * onPartialResults threading + TextToSpeech init race. Compile-clean only.
 */
export function registerSpeechHandlers(): void {
  if (isIOS) registerIos();
  else if (isAndroid) registerAndroid();
}

function registerIos(): void {
  // iOS speech-synthesizer delegate — both finish & cancel settle the pending speak (the JS
  // `speakPending` is captured via the `onSettle` instance field, assigned after `new()`). Declared
  // INSIDE this iOS-only registrar (mirrors app.ts): NSObject/AV* are iOS globals and this shared
  // module is imported on Android too, so a top-level `@NativeClass extends NSObject` would crash at
  // module load.
  @NativeClass()
  class SpeakDelegate extends NSObject implements AVSpeechSynthesizerDelegate {
    static ObjCProtocols = [AVSpeechSynthesizerDelegate];
    onSettle?: () => void;
    static new(): SpeakDelegate {
      return <SpeakDelegate>super.new();
    }
    speechSynthesizerDidFinishSpeechUtterance(_s: AVSpeechSynthesizer, _u: AVSpeechUtterance): void {
      this.onSettle?.();
    }
    speechSynthesizerDidCancelSpeechUtterance(_s: AVSpeechSynthesizer, _u: AVSpeechUtterance): void {
      this.onSettle?.();
    }
  }

  // Strong refs while a session is live — ARC would otherwise free the synthesizer/engine/delegate
  // the moment the JS locals fall out of scope (same hazard as handlers-scanner/oauth).
  let synth: AVSpeechSynthesizer | null = null;
  let speakDelegate: SpeakDelegate | null = null;
  let speakPending: { resolve: () => void } | null = null;

  let engine: AVAudioEngine | null = null;
  let recognizer: SFSpeechRecognizer | null = null;
  let request: SFSpeechAudioBufferRecognitionRequest | null = null;
  let task: SFSpeechRecognitionTask | null = null;
  let listenPending: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  let best = '';

  const teardownListen = () => {
    try { task?.cancel?.(); } catch { /* noop */ }
    try { request?.endAudio?.(); } catch { /* noop */ }
    try {
      engine?.inputNode?.removeTapOnBus?.(0);
      engine?.stop?.();
    } catch { /* noop */ }
    task = null; request = null; engine = null;
  };

  const settleListen = () => {
    const p = listenPending;
    listenPending = null;
    teardownListen();
    p?.resolve(best);
  };

  bridge.register('speech.speak', (params: any) =>
    new Promise<void>((resolve, reject) => {
      Utils.dispatchToMainThread(() => {
        try {
          if (!synth) {
            synth = AVSpeechSynthesizer.new();
            speakDelegate = SpeakDelegate.new();
            speakDelegate.onSettle = () => { const p = speakPending; speakPending = null; p?.resolve(); };
            synth.delegate = speakDelegate;
          }
          // A new speak resolves any prior pending (its utterance is being superseded).
          speakPending?.resolve();
          const u = AVSpeechUtterance.speechUtteranceWithString(String(params?.text ?? ''));
          if (params?.voice) {
            const v = AVSpeechSynthesisVoice.voiceWithIdentifier(String(params.voice));
            if (v) u.voice = v;
          } else if (params?.lang) {
            const v = AVSpeechSynthesisVoice.voiceWithLanguage(String(params.lang));
            if (v) u.voice = v;
          }
          if (params?.rate != null) u.rate = Number(params.rate) * AVSpeechUtterance.alloc().rate; // relative scale
          if (params?.pitch != null) u.pitchMultiplier = Number(params.pitch);
          speakPending = { resolve };
          synth.speakUtterance(u);
        } catch (e: any) {
          reject(err('NATIVE_ERROR', e?.message ?? 'speak failed'));
        }
      });
    })
  );

  bridge.register('speech.stop', () => {
    Utils.dispatchToMainThread(() => {
      try { synth?.stopSpeakingAtBoundary?.(0 /* immediate */); } catch { /* noop */ }
      const p = speakPending; speakPending = null; p?.resolve();
    });
  });

  bridge.register('speech.voices', () => {
    const voices = AVSpeechSynthesisVoice.speechVoices();
    const out: Array<{ id: string; name: string; lang: string }> = [];
    const n = voices?.count ?? 0;
    for (let i = 0; i < n; i++) {
      const v = voices.objectAtIndex(i);
      out.push({ id: String(v.identifier), name: String(v.name), lang: String(v.language) });
    }
    return out;
  });

  bridge.register('speech.stopListening', () => {
    // End audio → the recognizer flushes a final result, then we settle with best-so-far.
    try { engine?.inputNode?.removeTapOnBus?.(0); engine?.stop?.(); request?.endAudio?.(); } catch { /* noop */ }
    if (listenPending) settleListen();
  });

  bridge.register('speech.listen', (params: any) =>
    new Promise<string>((resolve, reject) => {
      if (listenPending) { reject(err('NATIVE_ERROR', 'speech.listen: already listening')); return; }
      best = '';
      listenPending = { resolve, reject };

      SFSpeechRecognizer.requestAuthorization((status: SFSpeechRecognizerAuthorizationStatus) => {
        if (status !== SFSpeechRecognizerAuthorizationStatus.Authorized) {
          const p = listenPending; listenPending = null;
          p?.reject(err('DENIED', 'Speech recognition not authorized'));
          return;
        }
        Utils.dispatchToMainThread(() => {
          try {
            // Pick a locale SFSpeechRecognizer has a model for: try the requested lang, the device
            // language code, then en-US (always supported) as a last resort. Do NOT gate on
            // `isAvailable` — it's unreliable SYNCHRONOUSLY right after init (becomes true async via
            // the availabilityDidChange delegate), so checking it here wrongly rejects a good recognizer
            // (proven on-device: en-US reported unavailable). Accept any non-nil recognizer; a genuine
            // failure surfaces in the recognitionTask error callback instead.
            const tryRec = (id: string) => {
              try { return SFSpeechRecognizer.alloc().initWithLocale(NSLocale.localeWithLocaleIdentifier(id)) || null; }
              catch { return null; }
            };
            let langCode = 'en';
            try { langCode = String(NSLocale.currentLocale.languageCode || 'en'); } catch { /* default */ }
            const tried = params?.lang ? [String(params.lang)] : [langCode, 'en-US'];
            recognizer = null;
            for (const id of tried) { recognizer = tryRec(id); if (recognizer) break; }
            if (!recognizer) {
              const p = listenPending; listenPending = null;
              p?.reject(err('UNSUPPORTED', `Speech recognizer unavailable (tried: ${tried.join(', ')})`));
              return;
            }

            const session = AVAudioSession.sharedInstance();
            session.setCategoryModeOptionsError(AVAudioSessionCategoryPlayAndRecord, AVAudioSessionModeMeasurement, 1 /* duckOthers */, null);
            // 0 = no activation flags; not a named member of the options enum, so cast (preserve value).
            session.setActiveWithOptionsError(true, 0 as AVAudioSessionSetActiveOptions, null);

            engine = AVAudioEngine.new();
            request = SFSpeechAudioBufferRecognitionRequest.new();
            request.shouldReportPartialResults = !!params?.partial;

            task = recognizer.recognitionTaskWithRequestResultHandler(request, (result: SFSpeechRecognitionResult, error: NSError) => {
              if (result) {
                best = String(result.bestTranscription?.formattedString ?? best);
                if (params?.partial && !result.final) bridge.emit('speech.partial', { transcript: best });
                if (result.final && listenPending) settleListen();
              }
              if (error && listenPending) {
                const p = listenPending; listenPending = null;
                teardownListen();
                p?.resolve(best); // resolve with whatever we have — stopListening contract
              }
            });

            const input = engine.inputNode;
            const format = input.outputFormatForBus(0);
            input.installTapOnBusBufferSizeFormatBlock(0, 1024, format, (buffer: AVAudioPCMBuffer, _when: AVAudioTime) => {
              request?.appendAudioPCMBuffer(buffer);
            });
            engine.prepare();
            engine.startAndReturnError(null);
          } catch (e: any) {
            const p = listenPending; listenPending = null;
            teardownListen();
            p?.reject(err('NATIVE_ERROR', e?.message ?? 'listen failed'));
          }
        });
      });
    })
  );
}

function registerAndroid(): void {
  // TextToSpeech + SpeechRecognizer are plain Java → direct interop, no kotlin flag, no gradle dep.
  let tts: android.speech.tts.TextToSpeech | null = null;
  let ttsReady = false;
  const ctx = () => Utils.android.getApplicationContext();

  const ensureTts = (): Promise<android.speech.tts.TextToSpeech | null> =>
    new Promise((resolve) => {
      if (tts && ttsReady) { resolve(tts); return; }
      tts = new android.speech.tts.TextToSpeech(
        ctx(),
        new android.speech.tts.TextToSpeech.OnInitListener({
          onInit(status: number) {
            ttsReady = status === android.speech.tts.TextToSpeech.SUCCESS;
            resolve(ttsReady ? tts : null);
          },
        })
      );
    });

  bridge.register('speech.speak', async (params: any) => {
    const engine = await ensureTts();
    if (!engine) throw err('NATIVE_ERROR', 'TextToSpeech init failed');
    const text = String(params?.text ?? '');
    if (params?.lang) {
      try { engine.setLanguage(new java.util.Locale.Builder().setLanguageTag(String(params.lang)).build()); } catch { /* keep default */ }
    }
    if (params?.rate != null) engine.setSpeechRate(Number(params.rate));
    if (params?.pitch != null) engine.setPitch(Number(params.pitch));
    const id = 'u' + Date.now();
    return new Promise<void>((resolve) => {
      engine.setOnUtteranceProgressListener(
        // NS interop: subclass the abstract Java class via object-literal ctor (untypeable — cast base).
        new (android.speech.tts.UtteranceProgressListener as any)({
          onStart() {},
          onDone() { resolve(); },
          onError() { resolve(); }, // resolve regardless — speak() promises completion, not success
        })
      );
      engine.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, id);
    });
  });

  bridge.register('speech.stop', () => { try { tts?.stop?.(); } catch { /* noop */ } });

  bridge.register('speech.voices', () => {
    const out: Array<{ id: string; name: string; lang: string }> = [];
    try {
      const voices = tts?.getVoices?.();
      if (voices) {
        const it = voices.iterator();
        while (it.hasNext()) {
          const v = it.next();
          out.push({ id: String(v.getName()), name: String(v.getName()), lang: String(v.getLocale().toLanguageTag()) });
        }
      }
    } catch { /* TTS not yet init — return empty */ }
    return out;
  });

  // STT — SpeechRecognizer must be created + driven on the main (UI) thread.
  let recognizer: android.speech.SpeechRecognizer | null = null;
  let listenPending: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  let best = '';

  const settle = () => {
    const p = listenPending; listenPending = null;
    try { recognizer?.stopListening?.(); recognizer?.destroy?.(); } catch { /* noop */ }
    recognizer = null;
    p?.resolve(best);
  };

  bridge.register('speech.stopListening', () => {
    Utils.dispatchToMainThread(() => { if (listenPending) settle(); });
  });

  bridge.register('speech.listen', async (params: any) => {
    const granted = await requestPermissions(['android.permission.RECORD_AUDIO']);
    if (!granted) throw err('DENIED', 'Microphone permission denied');
    if (listenPending) throw err('NATIVE_ERROR', 'speech.listen: already listening');

    return new Promise<string>((resolve, reject) => {
      best = '';
      listenPending = { resolve, reject };
      Utils.dispatchToMainThread(() => {
        try {
          if (!android.speech.SpeechRecognizer.isRecognitionAvailable(ctx())) {
            const p = listenPending; listenPending = null;
            p?.reject(err('UNSUPPORTED', 'No speech recognition service'));
            return;
          }
          recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(ctx());
          const pickText = (b: android.os.Bundle): string => {
            const arr = b?.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
            return arr && arr.size() ? String(arr.get(0)) : '';
          };
          recognizer.setRecognitionListener(
            new android.speech.RecognitionListener({
              onReadyForSpeech() {}, onBeginningOfSpeech() {}, onRmsChanged() {},
              onBufferReceived() {}, onEndOfSpeech() {}, onEvent() {},
              onPartialResults(b: android.os.Bundle) {
                if (!params?.partial) return;
                const t = pickText(b);
                if (t) { best = t; bridge.emit('speech.partial', { transcript: t }); }
              },
              onResults(b: android.os.Bundle) {
                const t = pickText(b);
                if (t) best = t;
                if (listenPending) settle();
              },
              onError(_code: number) {
                if (listenPending) settle(); // resolve with best-so-far (e.g. timeout/no-match)
              },
            })
          );
          const intent = new android.content.Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
          intent.putExtra(
            android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM
          );
          if (params?.lang) intent.putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, String(params.lang));
          if (params?.partial) intent.putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
          recognizer.startListening(intent);
        } catch (e: any) {
          const p = listenPending; listenPending = null;
          p?.reject(err('NATIVE_ERROR', e?.message ?? 'listen failed'));
        }
      });
    });
  });
}
