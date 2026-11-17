import type { NativeKit } from '../core/NativeKit';
import type { Unsubscribe } from '../core/types';

/** One head-tracking sample from supported headphones (AirPods Pro/Max/3, Beats with head tracking). */
export interface HeadphoneMotionSample {
  /** Attitude quaternion (CMAttitude.quaternion). */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Attitude Euler angles, radians. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Rotation rate, rad/s. */
  rx: number;
  ry: number;
  rz: number;
  /** Sample timestamp, seconds since device boot. */
  t: number;
}

export interface HeadphoneMotionAvailability {
  /** The device supports headphone motion (NOT "AirPods connected" — see `connected`). */
  available: boolean;
  /** Last connect/disconnect the shell saw while streaming; null = unknown (not streamed yet). */
  connected: boolean | null;
  authorization: 'notDetermined' | 'restricted' | 'denied' | 'authorized';
  /** NSMotionUsageDescription is in the build (the `headphoneMotion` module is enabled). */
  configured: boolean;
}

/** iOS head tracking (`headphoneMotion` module). Android / web: capability 'none'. */
export class HeadphoneMotionModule {
  // NativeKit excludes `headphoneMotion.` from the web fallback (no web equivalent: a WebAdapter retry would
  // replace the shell's real error with "Unknown method"). Done in NativeKit's constructor body — module
  // fields initialise BEFORE NativeKit's own private fields, so calling it from here throws.
  constructor(private kit: NativeKit) {}

  get capability() {
    return this.kit.capability('headphoneMotion');
  }

  /** Resolves `null` where the capability is absent (Android, web, module not enabled). */
  async availability(): Promise<HeadphoneMotionAvailability | null> {
    await this.kit.ready().catch(() => {});
    if (this.capability !== 'native') return null;
    return this.kit.invoke('headphoneMotion.isAvailable');
  }

  /** Stream head attitude (default 50 Hz, clamped 5–100; a sample is sent only when the headphones produced a
   * new one). The first start may show the iOS Motion & Fitness prompt. ONE native stream: a second watch
   * restarts it at the new rate and either unsubscribe stops it — own a single watcher per app. */
  async watch(cb: (s: HeadphoneMotionSample) => void, opts?: { hz?: number }): Promise<Unsubscribe> {
    const off = this.kit.on('headphoneMotion.data', (p) => cb(p as HeadphoneMotionSample));
    try {
      await this.kit.invoke('headphoneMotion.start', opts?.hz ? { hz: opts.hz } : undefined);
    } catch (e) {
      off();
      throw e;
    }
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      off();
      this.kit.invoke('headphoneMotion.stop').catch((e) => console.warn('[native-kit] headphoneMotion.stop failed', e));
    };
  }

  /** Headphones connected / disconnected (delivered while a watch is running). */
  onConnection(cb: (e: { connected: boolean }) => void): Unsubscribe {
    return this.kit.on('headphoneMotion.connection', (p) => cb(p as { connected: boolean }));
  }
}
