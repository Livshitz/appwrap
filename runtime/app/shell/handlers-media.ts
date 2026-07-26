import { Utils, isIOS, isAndroid } from '@nativescript/core';
import { bridge } from './bridge';
import { MUTE_PROBE_WAV_B64 } from './mute-probe-sound';

// AudioToolbox isn't in the bundled iOS typings (AVFoundation is), so declare the few SystemSound
// symbols we use. They exist at runtime — NativeScript exposes every linked framework global.
declare const AudioServicesCreateSystemSoundID: (url: NSURL, outId: interop.Reference<number>) => number;
declare const AudioServicesPlaySystemSoundWithCompletion: (id: number, completion: () => void) => void;

let routeObserverArmed = false;

/** List the current output port types (e.g. "Receiver", "Speaker", "BluetoothA2DP"). */
function outputPortTypes(session: AVAudioSession): string[] {
  const outputs = session.currentRoute?.outputs;
  const types: string[] = [];
  for (let i = 0; i < (outputs?.count ?? 0); i++) types.push(String(outputs.objectAtIndex(i).portType));
  return types;
}

function isOnBuiltInReceiver(session: AVAudioSession): boolean {
  return outputPortTypes(session).indexOf(AVAudioSessionPortBuiltInReceiver) !== -1;
}

/** Whether the session can record (PlayAndRecord) — i.e. we're (or about to be) in a call. */
function isRecordCategory(session: AVAudioSession): boolean {
  return String(session.category) === String(AVAudioSessionCategoryPlayAndRecord);
}

/** Push output to the loudspeaker while a call route (PlayAndRecord) is on the built-in receiver. */
function forceSpeakerIfReceiverDuringCall(): void {
  const session = AVAudioSession.sharedInstance();
  if (!isRecordCategory(session) || !isOnBuiltInReceiver(session)) return; // not a call, or already speaker/headset/BT
  try {
    session.overrideOutputAudioPortError(AVAudioSessionPortOverride.Speaker);
  } catch {
    /* benign — route may have changed again under us */
  }
}

/** Observe route changes once; re-assert loudspeaker whenever a call route drops to the receiver. */
function observeAudioRouteForSpeaker(): void {
  if (routeObserverArmed) return;
  routeObserverArmed = true;
  NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
    AVAudioSessionRouteChangeNotification,
    null,
    null,
    () => Utils.dispatchToMainThread(() => forceSpeakerIfReceiverDuringCall())
  );
}

// ── Silent / output-volume detection ────────────────────────────────────────
// Drives a "will sound actually be heard?" UI signal (e.g. a disabled speaker button). Apple does NOT
// expose the hardware mute switch, so on iOS we combine TWO signals: the media volume (AVAudioSession
// .outputVolume) AND the de-facto mute-switch probe — play a ~0.3s SILENT system sound and time its
// completion; a muted device finishes near-instantly. VOLUME is event-driven (KVO on outputVolume) so
// it's instant; only the switch is polled (~1s) since it has no event. On Android there's no switch:
// the media-stream (STREAM_MUSIC) volume is the signal, observed REACTIVELY via a ContentObserver (no
// polling either platform except the unavoidable iOS switch probe). Emit `media.audioState` on change.
const AUDIO_POLL_MS = 1000;   // ~1–2s worst-case latency to reflect a switch/volume toggle; the probe sound is silent so a 1s cadence is inaudible (matches the akram/Mute default)
const MUTE_PROBE_THRESHOLD = 0.1;   // s — a silent clip that completes faster than this means muted output

let audioTimer: ReturnType<typeof setInterval> | null = null;
let lastSilent: boolean | null = null;
let lastVolume = -1;
let muteSoundID = 0;          // iOS SystemSoundID for the silent probe (0 = not yet created)
// Retain the in-flight completion closure: NativeScript may GC a JS block passed to a C API once the
// local goes out of scope, so without a strong ref the completion can silently never fire — which is
// exactly what froze the watcher after the first probe. A module ref keeps it alive until it runs.
let probeCompletion: (() => void) | null = null;
let probeStartedAt = 0;
let switchMuted = false;        // last hardware-mute-switch reading from the probe (iOS only)
let volObserver: NSObject | null = null;          // iOS KVO observer on AVAudioSession.outputVolume
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- NSObject.extend is a runtime augmentation, not in the strict iOS typings
let VolumeObserverClass: any = null;              // registered once (re-extending a name crashes)
let volContentObserver: android.database.ContentObserver | null = null;   // Android volume observer

function emitAudioState(silent: boolean, volume: number): void {
  // Round volume so float jitter doesn't spam the bridge; emit only on a real change.
  const v = Math.round(volume * 100) / 100;
  if (silent === lastSilent && v === lastVolume) return;
  lastSilent = silent;
  lastVolume = v;
  bridge.emit('media.audioState', { silent, volume: v });
}

/** Create (once) the iOS SystemSoundID from the embedded silent WAV, written to a temp file. */
function ensureMuteProbeSound(): boolean {
  if (muteSoundID) return true;
  try {
    const data = NSData.alloc().initWithBase64EncodedStringOptions(MUTE_PROBE_WAV_B64, 0 as NSDataBase64DecodingOptions);
    if (!data) return false;
    const path = NSTemporaryDirectory() + 'appwrap-mute-probe.wav';
    data.writeToFileAtomically(path, true);
    const ref = new interop.Reference<number>();
    AudioServicesCreateSystemSoundID(NSURL.fileURLWithPath(path), ref);
    muteSoundID = ref.value || 0;
    return !!muteSoundID;
  } catch (e) {
    console.warn('[appwrap] mute-probe sound init failed', e);
    return false;
  }
}

/** Combine the (event-driven) volume with the (polled) switch state and emit. iOS. */
function emitIOS(): void {
  const volume = AVAudioSession.sharedInstance().outputVolume;
  emitAudioState(switchMuted || volume <= 0.0001, volume);
}

/** Probe the hardware mute switch — the ONLY way to read it (Apple exposes no event/API) — then emit. */
function probeSwitchIOS(): void {
  if (!ensureMuteProbeSound()) { emitIOS(); return; }
  if (probeCompletion && Date.now() - probeStartedAt < 1000) return;   // one still pending → skip
  probeStartedAt = Date.now();
  const started = probeStartedAt;
  // Retained in a module var so NativeScript can't GC the block before AudioServices calls it back.
  probeCompletion = () => {
    probeCompletion = null;
    switchMuted = (Date.now() - started) / 1000 < MUTE_PROBE_THRESHOLD;
    emitIOS();
  };
  AudioServicesPlaySystemSoundWithCompletion(muteSoundID, probeCompletion);
}

/**
 * iOS: volume is REACTIVE via KVO on AVAudioSession.outputVolume (instant — no polling). The hardware
 * mute switch has NO OS event (Apple won't expose it), so that one axis is polled via the silent probe.
 */
function startAudioIOS(): void {
  const session = AVAudioSession.sharedInstance();
  try { session.setActiveError(true); } catch { /* benign — KVO still delivers */ }
  if (!volObserver) {
    if (!VolumeObserverClass) {
      VolumeObserverClass = (NSObject as any).extend(
        {
          observeValueForKeyPathOfObjectChangeContext(keyPath: string) {
            if (keyPath === 'outputVolume') emitIOS();   // hardware volume changed → emit immediately
          },
        },
        { name: 'AppwrapAudioVolumeObserver' }
      );
    }
    volObserver = VolumeObserverClass.alloc().init();
    session.addObserverForKeyPathOptionsContext(volObserver, 'outputVolume', NSKeyValueObservingOptions.New, null);
  }
  probeSwitchIOS();                                     // initial switch read + emit
  audioTimer = setInterval(probeSwitchIOS, AUDIO_POLL_MS);
}

function stopAudioIOS(): void {
  if (audioTimer) { clearInterval(audioTimer); audioTimer = null; }
  if (volObserver) {
    try { AVAudioSession.sharedInstance().removeObserverForKeyPath(volObserver, 'outputVolume'); } catch { /* already gone */ }
    volObserver = null;
  }
}

/** Android: read the media-stream (STREAM_MUSIC) volume — 0 = silent — and emit. */
function readAudioAndroid(): void {
  try {
    const ctx = Utils.android.getApplicationContext();
    const am = ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager;
    const max = am.getStreamMaxVolume(android.media.AudioManager.STREAM_MUSIC) || 1;
    const cur = am.getStreamVolume(android.media.AudioManager.STREAM_MUSIC);
    emitAudioState(cur === 0, cur / max);
  } catch (e) {
    console.warn('[appwrap] android audio read failed', e);
  }
}

/** Android: REACTIVE — a ContentObserver on system settings fires on every volume change (no polling). */
function startAudioAndroid(): void {
  try {
    const ctx = Utils.android.getApplicationContext();
    const handler = new android.os.Handler(android.os.Looper.getMainLooper());
    // extend lazily — the android.* globals only exist on the Android load path
    const ObserverClass = (android.database.ContentObserver as any).extend({
      onChange(_selfChange: boolean) { readAudioAndroid(); },
    });
    volContentObserver = new ObserverClass(handler);
    ctx.getContentResolver().registerContentObserver(
      android.provider.Settings.System.CONTENT_URI, true, volContentObserver
    );
  } catch (e) {
    console.warn('[appwrap] android volume observer failed', e);
  }
  readAudioAndroid();   // initial state
}

function stopAudioAndroid(): void {
  if (volContentObserver) {
    try { Utils.android.getApplicationContext().getContentResolver().unregisterContentObserver(volContentObserver); }
    catch { /* already gone */ }
    volContentObserver = null;
  }
}

/**
 * Live-media session config. getUserMedia / playback themselves are pure WebView
 * APIs (unlocked by the UIDelegate / onPermissionRequest grants in the custom
 * webviews); this only tunes the native *audio session*, which iOS needs to play
 * over the silent switch and to route mic+speaker for calls. Android routes
 * fine on its own — honest no-op there.
 */
export function registerMediaHandlers(): void {
  // DIAGNOSTIC: surface the WKWebView UIDelegate status to the page (on-screen log).
  // no NS types: __appwrapWebviewDiag is an ad-hoc diagnostic stashed on global by the WKWebView UIDelegate.
  bridge.register('debug.webviewInfo', () => ({ diag: (global as any).__appwrapWebviewDiag ?? 'n/a (android/web)' }));

  // Auto loudspeaker for in-WebView WebRTC calls. When getUserMedia is live, WebKit drives the
  // shared AVAudioSession into PlayAndRecord and routes playback to the *earpiece/receiver* at
  // call-gain — so remote audio sounds quiet even at max volume. We observe route changes and, while
  // a capture (PlayAndRecord) session is active and the output fell back to the receiver, override
  // the output port to the loudspeaker. Scoped to PlayAndRecord so non-call playback is untouched;
  // honors a connected headset/Bluetooth route (only the built-in receiver is redirected).
  if (isIOS) observeAudioRouteForSpeaker();

  // Establish the OS-level (TCC) mic/camera grant from the *app* process. WKWebView's
  // getUserMedia checks the same per-app TCC entry but doesn't persist a grant of its
  // own, so without this it re-prompts on every call. AVCaptureDevice.requestAccess
  // prompts once and the grant sticks — after which the WebView capture is silent.
  bridge.register('media.ensurePermission', async ({ audio, video }: { audio?: boolean; video?: boolean } = {}) => {
    if (!isIOS) return { audio: 'granted', video: 'granted' }; // Android: onPermissionRequest handles it

    const ask = (mediaType: string): Promise<string> =>
      new Promise((resolve) => {
        const status = AVCaptureDevice.authorizationStatusForMediaType(mediaType);
        if (status === AVAuthorizationStatus.Authorized) return resolve('granted');
        if (status === AVAuthorizationStatus.Denied || status === AVAuthorizationStatus.Restricted) {
          return resolve('denied');
        }
        AVCaptureDevice.requestAccessForMediaTypeCompletionHandler(mediaType, (granted: boolean) =>
          resolve(granted ? 'granted' : 'denied')
        );
      });

    const out: { audio?: string; video?: string } = {};
    if (audio) out.audio = await ask(AVMediaTypeAudio);
    if (video) out.video = await ask(AVMediaTypeVideo);
    return out;
  });

  bridge.register('media.configureAudio', ({ mode }: { mode?: string }) => {
    if (!isIOS) return; // Android: nothing to configure
    const session = AVAudioSession.sharedInstance();
    let category: string;
    let options = 0;
    // Default mode = the system's choice for the category; voiceChat swaps in the
    // voice-processing I/O unit (hardware AEC) so TTS doesn't bleed into the mic.
    let avMode = AVAudioSessionModeDefault;
    if (mode === 'playAndRecord') {
      category = AVAudioSessionCategoryPlayAndRecord;
      // Loud speaker by default + allow Bluetooth headsets for calls.
      options =
        AVAudioSessionCategoryOptions.DefaultToSpeaker | AVAudioSessionCategoryOptions.AllowBluetooth;
    } else if (mode === 'voiceChat') {
      // Full-duplex voice agent: PlayAndRecord + VoiceChat engages iOS acoustic
      // echo cancellation, so speaker TTS is removed from the mic feed (no STT bleed).
      category = AVAudioSessionCategoryPlayAndRecord;
      options =
        AVAudioSessionCategoryOptions.DefaultToSpeaker | AVAudioSessionCategoryOptions.AllowBluetooth;
      avMode = AVAudioSessionModeVoiceChat;
    } else if (mode === 'default') {
      category = AVAudioSessionCategoryAmbient;
    } else {
      category = AVAudioSessionCategoryPlayback; // ignores the silent switch
    }
    // options is an OR-combined flag mask; the bitwise result widens to number, so cast back to the enum.
    session.setCategoryModeOptionsError(category, avMode, options as AVAudioSessionCategoryOptions);
    session.setActiveError(true);
  });

  // Start streaming `media.audioState` { silent, volume } events. iOS: volume is event-driven (KVO),
  // the switch is polled (no OS event). Android: media-stream volume polled. Idempotent; emits the
  // current state immediately so the page doesn't wait for the first change.
  bridge.register('media.audioWatch.start', () => {
    if (audioTimer || volObserver || volContentObserver) return;
    lastSilent = null; lastVolume = -1;   // force the first emit
    if (isIOS) startAudioIOS();
    else if (isAndroid) startAudioAndroid();
    // unsupported platform → no events (page treats absence as "audible")
  });

  bridge.register('media.audioWatch.stop', () => {
    if (isIOS) stopAudioIOS();
    else if (isAndroid) stopAudioAndroid();
    lastSilent = null; lastVolume = -1;
  });
}
