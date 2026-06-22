import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';

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
}
