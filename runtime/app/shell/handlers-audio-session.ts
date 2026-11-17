import { Utils, isIOS } from '@nativescript/core';
import { bridge } from './bridge';
import { SHELL_CONFIG } from './config';
import { AudioSessionPolicy, type Decision } from './audio-session-policy';

/**
 * Native audio session for WEB playback (`audioSession` capability, core, iOS).
 *
 * Long Web Audio / <audio> sessions need three things the page cannot do itself:
 *  1. the app's AVAudioSession in a playback category, active — `media.configureAudio` (below), and AT BOOT
 *     when the app declares `backgroundAudio: true` (category only at boot — activation happens when audio starts);
 *  2. interruption + route signals so the page can resume its AudioContext / pause on unplug:
 *     events `audio.interruption` and `audio.routeChange`;
 *  3. the current output route (AirPods? spatial audio on?) — `audio.route`.
 *
 * Observers are NSNotificationCenter subscriptions armed once (push — the page never polls).
 * Uses AVAudioSessionInterruptionNotification: deprecated in the iOS 27 SDK (replaced by
 * DidBecomeInactive + ResumptionRecommendation, iOS 27+ only) but still delivered, and the only one on 14–26.
 */

export type AudioSessionMode = 'playback' | 'playAndRecord' | 'voiceChat' | 'default';
export interface AudioSessionOptions {
  /** Mix with other apps' audio instead of interrupting them (adds MixWithOthers). Default false. */
  mixWithOthers?: boolean;
}

/** Boot default vs explicit page claim — decides what may be re-applied / activated (audio-session-policy.ts). */
const policy = new AudioSessionPolicy();
/** The AVAudioSession category the live claim set (to detect WebKit having switched it, e.g. to playAndRecord). */
let claimCategory: string | null = null;

/** A page EXPLICITLY asked for this session (`media.configureAudio`): apply + activate, and remember it as the claim
 * the shell may restore after an interruption, until the next top-level document. */
export function claimAudioSession(mode: AudioSessionMode = 'playback', opts: AudioSessionOptions = {}): void {
  claimCategory = configureAudioSession(mode, opts, true);
  policy.setClaim({ mode, mixWithOthers: !!opts.mixWithOthers });
}

/** Apply a category/mode to the shared AVAudioSession and (unless `activate` is false) activate it. Activating a
 * non-mixing category interrupts other apps' audio, so the boot path only sets the category. Returns the category
 * set. Throws on error. */
function configureAudioSession(mode: AudioSessionMode = 'playback', opts: AudioSessionOptions = {}, activate = true): string {
  const session = AVAudioSession.sharedInstance();
  let category: string;
  let options = 0;
  // Default mode = the system's choice for the category; voiceChat swaps in the
  // voice-processing I/O unit (hardware AEC) so TTS doesn't bleed into the mic.
  let avMode = AVAudioSessionModeDefault;
  if (mode === 'playAndRecord') {
    category = AVAudioSessionCategoryPlayAndRecord;
    // Loud speaker by default + allow Bluetooth headsets for calls.
    options = AVAudioSessionCategoryOptions.DefaultToSpeaker | AVAudioSessionCategoryOptions.AllowBluetooth;
  } else if (mode === 'voiceChat') {
    // Full-duplex voice agent: PlayAndRecord + VoiceChat engages iOS acoustic
    // echo cancellation, so speaker TTS is removed from the mic feed (no STT bleed).
    category = AVAudioSessionCategoryPlayAndRecord;
    options = AVAudioSessionCategoryOptions.DefaultToSpeaker | AVAudioSessionCategoryOptions.AllowBluetooth;
    avMode = AVAudioSessionModeVoiceChat;
  } else if (mode === 'default') {
    category = AVAudioSessionCategoryAmbient; // ambient always mixes; mixWithOthers is moot
  } else {
    category = AVAudioSessionCategoryPlayback; // ignores the silent switch; non-mixing unless asked
  }
  if (opts.mixWithOthers) options |= AVAudioSessionCategoryOptions.MixWithOthers;
  // options is an OR-combined flag mask; the bitwise result widens to number, so cast back to the enum.
  session.setCategoryModeOptionsError(category, avMode, options as AVAudioSessionCategoryOptions);
  if (activate) session.setActiveError(true);
  return category;
}

// ── route ────────────────────────────────────────────────────────────────────
const HEADPHONE_KINDS = new Set(['headphones', 'bluetoothA2DP', 'bluetoothLE', 'bluetoothHFP']);
let portKinds: Record<string, string> | null = null;
/** AVAudioSessionPort* → kit name. Built from the SDK constants at runtime (never hard-coded raw strings). */
function portKind(raw: string): string {
  portKinds ??= {
    [AVAudioSessionPortHeadphones]: 'headphones',
    [AVAudioSessionPortBluetoothA2DP]: 'bluetoothA2DP',
    [AVAudioSessionPortBluetoothLE]: 'bluetoothLE',
    [AVAudioSessionPortBluetoothHFP]: 'bluetoothHFP',
    [AVAudioSessionPortBuiltInSpeaker]: 'builtInSpeaker',
    [AVAudioSessionPortBuiltInReceiver]: 'builtInReceiver',
    [AVAudioSessionPortAirPlay]: 'airPlay',
    [AVAudioSessionPortHDMI]: 'hdmi',
    [AVAudioSessionPortUSBAudio]: 'usbAudio',
    [AVAudioSessionPortCarAudio]: 'carAudio',
    [AVAudioSessionPortLineOut]: 'lineOut',
  };
  return portKinds[raw] ?? 'other';
}

const ROUTE_REASONS: Record<number, string> = {
  0: 'unknown', 1: 'newDeviceAvailable', 2: 'oldDeviceUnavailable', 3: 'categoryChange', 4: 'override',
  6: 'wakeFromSleep', 7: 'noSuitableRouteForCategory', 8: 'routeConfigurationChange',
};

export interface AudioOutput { type: string; portType: string; name: string; headphones: boolean; spatialAudioEnabled: boolean | null }

/** The current output route. `spatialAudioEnabled` is AVAudioSessionPortDescription.isSpatialAudioEnabled
 * (iOS 15+): the port supports spatial rendering AND the user has it on — null where the API is absent. */
export function audioRoute(): { type: string; name: string; headphones: boolean; spatialAudioEnabled: boolean | null; outputs: AudioOutput[]; category: string; otherAudioPlaying: boolean } {
  const session = AVAudioSession.sharedInstance();
  const list = session.currentRoute?.outputs;
  const outputs: AudioOutput[] = [];
  for (let i = 0; i < (list?.count ?? 0); i++) {
    const p = list.objectAtIndex(i);
    const raw = String(p.portType);
    const type = portKind(raw);
    // spatialAudioEnabled is iOS 15+; on 14 the selector is absent → undefined → null (unknown, not false).
    const spatial = (p as { spatialAudioEnabled?: boolean }).spatialAudioEnabled;
    outputs.push({ type, portType: raw, name: String(p.portName ?? ''), headphones: HEADPHONE_KINDS.has(type), spatialAudioEnabled: typeof spatial === 'boolean' ? spatial : null });
  }
  const first = outputs[0];
  return {
    type: first?.type ?? 'none',
    name: first?.name ?? '',
    headphones: outputs.some((o) => o.headphones),
    spatialAudioEnabled: first ? first.spatialAudioEnabled : null,
    outputs,
    category: String(session.category),
    otherAudioPlaying: !!session.otherAudioPlaying,
  };
}

function applyDecision(d: Decision, why: string): void {
  if (!d.apply) return;
  try {
    configureAudioSession(d.apply.mode, { mixWithOthers: d.apply.mixWithOthers }, d.activate);
  } catch (e) {
    console.warn(`[appwrap] audio session restore (${why}) failed`, e);
  }
}

function observe(name: string, fn: (info: NSDictionary<any, any> | null) => void): void {
  NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(name, null, null, (n: NSNotification) => {
    const info = n.userInfo;
    Utils.dispatchToMainThread(() => fn(info));
  });
}

const num = (info: NSDictionary<any, any> | null, key: string): number | null => {
  const v = info?.objectForKey(key);
  return v == null ? null : Number(v);
};

export function registerAudioSessionHandlers(): void {
  if (!isIOS) return; // Android: handshake reports audioSession 'none'; media.configureAudio stays a no-op there

  observe(AVAudioSessionInterruptionNotification, (info) => {
    const type = num(info, AVAudioSessionInterruptionTypeKey);
    if (type === AVAudioSessionInterruptionType.Began) {
      const reason = num(info, AVAudioSessionInterruptionReasonKey);
      bridge.emit('audio.interruption', { type: 'began', reason: reason == null ? null : (['default', 'appWasSuspended', 'builtInMicMuted', null, 'routeDisconnected'][reason] ?? 'unknown') });
      return;
    }
    const shouldResume = ((num(info, AVAudioSessionInterruptionOptionKey) ?? 0) & AVAudioSessionInterruptionOptions.ShouldResume) !== 0;
    // Apple: reactivate BEFORE resuming — but only a session a page explicitly claimed, and only if WebKit hasn't
    // since moved it (getUserMedia → playAndRecord). Otherwise the session stays WebKit's; the page just gets the event.
    const live = String(AVAudioSession.sharedInstance().category);
    applyDecision(policy.onInterruptionEnded(shouldResume, claimCategory != null && live === claimCategory), 'interruption');
    bridge.emit('audio.interruption', { type: 'ended', shouldResume });
  });

  observe(AVAudioSessionRouteChangeNotification, (info) => {
    const reason = num(info, AVAudioSessionRouteChangeReasonKey) ?? 0;
    bridge.emit('audio.routeChange', { ...audioRoute(), reason: ROUTE_REASONS[reason] ?? 'unknown' });
  });

  // The user toggled Spatial Audio for the route (Control Center) — iOS 15+.
  if (typeof AVAudioSessionSpatialPlaybackCapabilitiesChangedNotification !== 'undefined') {
    observe(AVAudioSessionSpatialPlaybackCapabilitiesChangedNotification, () => {
      bridge.emit('audio.routeChange', { ...audioRoute(), reason: 'spatialCapabilitiesChanged' });
    });
  }

  // mediaserverd restarted: every session object is invalid — Apple says re-create the configuration.
  // Restore the category; activate only for a live claim (never stop the user's music on a daemon restart).
  observe(AVAudioSessionMediaServicesWereResetNotification, () => applyDecision(policy.onMediaServicesReset(), 'mediaServicesReset'));

  // A new top-level document never asked: its predecessor's claim ends here.
  bridge.onNewDocument(() => { policy.clearClaim(); claimCategory = null; });

  bridge.register('audio.route', () => audioRoute());

  // `backgroundAudio: true` only stamps the `audio` UIBackgroundMode. Set the PLAYBACK CATEGORY at boot (so web audio
  // plays under it and survives the lock), but do NOT activate: that would stop the user's music at launch.
  if (SHELL_CONFIG.backgroundAudio) {
    try {
      configureAudioSession('playback', {}, false);
      policy.setBootDefault({ mode: 'playback', mixWithOthers: false });
    } catch (e) {
      console.warn('[appwrap] backgroundAudio: playback session failed', e);
    }
  }
}
