import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/**
 * Live media bridge — mic / camera / speaker. The streams themselves are plain
 * web APIs (getUserMedia / MediaRecorder / WebAudio); the native shell's job is
 * to *unlock* them: grant the WebView's per-origin capture permission and route
 * audio sensibly. This module is the single import surface + capability gate,
 * plus `configureAudio()` which tunes the native audio session (iOS).
 */
export type AudioMode = 'playback' | 'playAndRecord' | 'voiceChat' | 'default';

/** Whether the device would actually play game/media sound right now, plus the media volume (0–1). */
export interface AudioState {
  /** True when output is effectively silenced — iOS mute switch OR zero media volume; Android: zero media volume. */
  silent: boolean;
  /** Media output volume, 0–1 (iOS AVAudioSession.outputVolume / Android STREAM_MUSIC). */
  volume: number;
}

/** Output port kind (from AVAudioSessionPort*); 'other' for anything unmapped (raw value in `portType`). */
export type AudioPortType =
  | 'headphones' | 'bluetoothA2DP' | 'bluetoothLE' | 'bluetoothHFP' | 'builtInSpeaker' | 'builtInReceiver'
  | 'airPlay' | 'hdmi' | 'usbAudio' | 'carAudio' | 'lineOut' | 'other';

export interface AudioOutput {
  type: AudioPortType;
  /** Raw AVAudioSessionPort value, e.g. 'BluetoothA2DPOutput'. */
  portType: string;
  /** Device name, e.g. "Elya's AirPods Pro". */
  name: string;
  /** Wired/Bluetooth headphones-class (headphones, bluetoothA2DP/LE/HFP). */
  headphones: boolean;
  /** iOS 15+ isSpatialAudioEnabled: port supports spatial rendering AND it's on; null = API absent. */
  spatialAudioEnabled: boolean | null;
}

export interface AudioRoute {
  /** First output's kind / name ('none' when no output). */
  type: AudioPortType | 'none';
  name: string;
  /** Any output is headphones-class. */
  headphones: boolean;
  spatialAudioEnabled: boolean | null;
  outputs: AudioOutput[];
  /** Raw AVAudioSession category, e.g. 'AVAudioSessionCategoryPlayback'. */
  category: string;
  otherAudioPlaying: boolean;
}

export interface AudioRouteChange extends AudioRoute {
  reason:
    | 'unknown' | 'newDeviceAvailable' | 'oldDeviceUnavailable' | 'categoryChange' | 'override' | 'wakeFromSleep'
    | 'noSuitableRouteForCategory' | 'routeConfigurationChange' | 'spatialCapabilitiesChanged';
}

export type AudioInterruption =
  | { type: 'began'; reason: 'default' | 'appWasSuspended' | 'builtInMicMuted' | 'routeDisconnected' | 'unknown' | null }
  | { type: 'ended'; shouldResume: boolean };

export interface MediaDeviceLite {
  kind: MediaDeviceKind;
  label: string;
  deviceId: string;
}

export class MediaModule {
  constructor(private kit: NativeKit) {}

  /** 'native' (shell grants capture) | 'web' (browser handles it) | 'none'. */
  get capability() {
    return this.kit.capability('media');
  }

  /** True only in a secure context with a usable mediaDevices implementation. */
  get available(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /**
   * Pre-establish the OS mic/camera permission so the WebView's getUserMedia
   * doesn't re-prompt on every call (a WKWebView artifact). Native shells prompt
   * once via the OS and cache it; no-op on web. Called automatically by
   * {@link getUserMedia}, but exposed for warming the grant up front.
   */
  ensurePermission(opts: { audio?: boolean; video?: boolean }): Promise<{ audio?: string; video?: string }> {
    if (this.capability !== 'native') return Promise.resolve({});
    return this.kit.invoke('media.ensurePermission', opts);
  }

  /** Thin wrapper over getUserMedia — same constraints, with an availability guard. */
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    if (!this.available) {
      throw Object.assign(new Error('getUserMedia unavailable (insecure context?)'), { code: 'UNSUPPORTED' });
    }
    // Native: secure the persistent OS grant first so the WebView prompts once, like native.
    await this.ensurePermission({ audio: !!constraints.audio, video: !!constraints.video }).catch(() => {});
    return navigator.mediaDevices.getUserMedia(constraints);
  }

  /** Enumerate input/output devices (labels populate only after a grant). */
  async devices(): Promise<MediaDeviceLite[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.map((d) => ({ kind: d.kind, label: d.label, deviceId: d.deviceId }));
  }

  /**
   * Tune the native audio session. 'playback' = loud, ignores the iOS silent
   * switch (media apps); 'playAndRecord' = mic + speaker for calls; 'voiceChat'
   * = full-duplex voice with hardware acoustic echo cancellation (AEC) — use
   * this for live voice agents so TTS playback doesn't bleed into the mic / STT.
   * No-op where the platform needs no session config (Android, web).
   */
  configureAudio(mode: AudioMode = 'playback', opts: { mixWithOthers?: boolean } = {}): Promise<void> {
    // The session handler ships in every iOS shell (`audioSession`, core) — an app need not opt into the
    // camera/mic-bearing `media` module just to play audio.
    if (this.capability !== 'native' && this.audioSessionCapability !== 'native') return Promise.resolve();
    return this.kit.invoke('media.configureAudio', { mode, mixWithOthers: !!opts.mixWithOthers });
  }

  /** 'native' where the shell exposes the audio session (iOS): route + interruption/route events. */
  get audioSessionCapability() {
    return this.kit.capability('audioSession');
  }

  /** Current output route (iOS). Resolves `null` where the platform has no session (Android, web). */
  async route(): Promise<AudioRoute | null> {
    if (this.audioSessionCapability !== 'native') return null;
    return this.kit.invoke('audio.route');
  }

  /** Audio session interrupted (call, Siri, another app) / interruption ended. On `ended` with
   * `shouldResume`, the shell has already re-activated the session — resume your AudioContext / element. */
  onInterruption(cb: (e: AudioInterruption) => void): Unsubscribe {
    return this.kit.on('audio.interruption', (p) => cb(p as AudioInterruption));
  }

  /** Output route changed (AirPods connected/removed, spatial audio toggled). `reason:'oldDeviceUnavailable'`
   * = headphones gone: pause, like every iOS media app. */
  onRouteChange(cb: (e: AudioRouteChange) => void): Unsubscribe {
    return this.kit.on('audio.routeChange', (p) => cb(p as AudioRouteChange));
  }

  /**
   * Watch whether sound would actually be heard — for reflecting the OS mute/volume state in UI
   * (e.g. disabling an in-app speaker toggle while the device is silenced). Fires `cb` with the
   * current {@link AudioState} immediately and again whenever it changes (~1s granularity). Native
   * only — on web (no OS silent concept) this is a no-op returning a noop unsubscribe.
   */
  async watchAudio(cb: (state: AudioState) => void): Promise<Unsubscribe> {
    // Wait for the handshake so `platform` is resolved (it defaults to 'web' until ready — callers
    // often subscribe during early app setup, before the bridge handshake lands).
    await this.kit.ready().catch(() => {});
    // Gate on PLATFORM, not the 'media' capability: the audio-state handler is always registered in
    // the native shell, so this works even for apps that don't opt into the full media module. Only
    // the browser (no OS silent/volume concept) is a genuine no-op.
    if (this.kit.platform === 'web') return () => {};
    const off = this.kit.on('media.audioState', (p) => cb(p as AudioState));
    try {
      await this.kit.invoke('media.audioWatch.start');
    } catch (e) {
      off();
      throw e;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      off();
      this.kit.invoke('media.audioWatch.stop').catch((e) => console.warn('[native-kit] audioWatch.stop failed', e));
    };
  }

  /** Stop every track on a stream — convenience to release the camera/mic LED. */
  stop(stream: MediaStream | null | undefined): void {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
