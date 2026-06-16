import type { NativeKit } from '../core/NativeKit';

/**
 * Live media bridge — mic / camera / speaker. The streams themselves are plain
 * web APIs (getUserMedia / MediaRecorder / WebAudio); the native shell's job is
 * to *unlock* them: grant the WebView's per-origin capture permission and route
 * audio sensibly. This module is the single import surface + capability gate,
 * plus `configureAudio()` which tunes the native audio session (iOS).
 */
export type AudioMode = 'playback' | 'playAndRecord' | 'voiceChat' | 'default';

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
  configureAudio(mode: AudioMode = 'playback'): Promise<void> {
    if (this.capability !== 'native') return Promise.resolve();
    return this.kit.invoke('media.configureAudio', { mode });
  }

  /** Stop every track on a stream — convenience to release the camera/mic LED. */
  stop(stream: MediaStream | null | undefined): void {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
